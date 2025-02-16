var host;

// Deployment-scripts can insert host here.
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// We know that you love 'free', we love it too :)! And so our entire software stack is free and even Open Source!      
// Our routing service is also free for certain applications or smaller volume. Be fair, grab an API key and support us:
// https://graphhopper.com/#directions-api Misuse of API keys that you don't own is prohibited and you'll be blocked.                    
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
if (!host) {
    if (location.port === '') {
        host = location.protocol + '//' + location.hostname;
    } else {
        host = location.protocol + '//' + location.hostname + ":" + location.port;
    }
}

global.d3 = require('d3');
var L = require('leaflet');
require('leaflet-loading');
require('./lib/leaflet.contextmenu.js');
require('./lib/Leaflet.Elevation-0.0.2.min.js');
require('./lib/leaflet_numbered_markers.js');

global.jQuery = require('jquery');
global.$ = global.jQuery;
require('./lib/jquery-ui-custom-1.11.4.min.js');
require('./lib/jquery.history.js');
require('./lib/jquery.autocomplete.js');

var GHInput = require('./graphhopper/GHInput.js');
var GHRequest = require('./graphhopper/GHRequest.js');
var AutoComplete = require('./autocomplete.js');

// To enable autocomplete
// - Remove the first line
// - Uncomment the second line and add a valid API token
var autocomplete = AutoComplete.prototype.createStub();
// var autocomplete = new AutoComplete('http://graphhopper.com/api/1', 'your api token goes here');

var mapLayer = require('./map.js');
var nominatim = require('./nominatim.js');
var gpxExport = require('./gpxexport.js');
var messages = require('./messages.js');
var translate = require('./translate.js');

var format = require('./tools/format.js');
var urlTools = require('./tools/url.js');
var vehicle = require('./tools/vehicle.js');

var debug = false;
var ghRequest = new GHRequest(host);
var bounds = {};

var activeLayer = '';
var metaVersionInfo;

// usage: log('inside coolFunc',this,arguments);
// http://paulirish.com/2009/log-a-lightweight-wrapper-for-consolelog/
if (global.window) {
    window.log = function () {
        log.history = log.history || [];   // store logs to an array for reference
        log.history.push(arguments);
        if (this.console && debug) {
            console.log(Array.prototype.slice.call(arguments));
        }
    };
}

$(document).ready(function (e) {
    // fixing cross domain support e.g in Opera
    jQuery.support.cors = true;

    gpxExport.addGpxExport(ghRequest);

    if (isProduction())
        $('#hosting').show();

    var History = window.History;
    if (History.enabled) {
        History.Adapter.bind(window, 'statechange', function () {
            // No need for workaround?
            // Chrome and Safari always emit a popstate event on page load, but Firefox doesn’t
            // https://github.com/defunkt/jquery-pjax/issues/143#issuecomment-6194330

            var state = History.getState();
            log(state);
            initFromParams(state.data, true);
        });
    }

    $('#locationform').submit(function (e) {
        // no page reload
        e.preventDefault();
        mySubmit();
    });

    var urlParams = urlTools.parseUrlWithHisto();
    $.when(ghRequest.fetchTranslationMap(urlParams.locale), ghRequest.getInfo())
            .then(function (arg1, arg2) {
                // init translation retrieved from first call (fetchTranslationMap)
                var translations = arg1[0];
                ghRequest.setLocale(translations.locale);
                translate.init(translations);

                // init bounding box from getInfo result
                var json = arg2[0];
                var tmp = json.bbox;
                bounds.initialized = true;
                bounds.minLon = tmp[0];
                bounds.minLat = tmp[1];
                bounds.maxLon = tmp[2];
                bounds.maxLat = tmp[3];
                nominatim.setBounds(bounds);
                var vehiclesDiv = $("#vehicles");

                function createButton(vehicle, hide) {
                    var button = $("<button class='vehicle-btn' title='" + translate.tr(vehicle) + "'/>");
                    if (hide)
                        button.hide();

                    button.attr('id', vehicle);
                    button.html("<img src='img/" + vehicle + ".png' alt='" + translate.tr(vehicle) + "'></img>");
                    button.click(function () {
                        ghRequest.initVehicle(vehicle);
                        resolveAll();
                        routeLatLng(ghRequest);
                    });
                    return button;
                }

                if (json.features) {
                    ghRequest.features = json.features;

                    // car, foot and bike should come first. mc comes last
                    var prefer = {"car": 1, "foot": 2, "bike": 3, "motorcycle": 10000};
                    var showAllVehicles = urlParams.vehicle && (!prefer[urlParams.vehicle] || prefer[urlParams.vehicle] > 3);
                    var vehicles = vehicle.getSortedVehicleKeys(json.features, prefer);
                    if (vehicles.length > 0)
                        ghRequest.initVehicle(vehicles[0]);

                    var hiddenVehicles = [];
                    for (var i in vehicles) {
                        var btn = createButton(vehicles[i].toLowerCase(), !showAllVehicles && i > 2);
                        vehiclesDiv.append(btn);

                        if (i > 2)
                            hiddenVehicles.push(btn);
                    }

                    if (!showAllVehicles && vehicles.length > 3) {
                        var moreBtn = $("<a id='more-vehicle-btn'> ...</a>").click(function () {
                            moreBtn.hide();
                            for (var i in hiddenVehicles) {
                                hiddenVehicles[i].show();
                            }
                        });
                        vehiclesDiv.append($("<a class='vehicle-info-link' href='https://graphhopper.com/api/1/docs/supported-vehicle-profiles/'>?</a>"));
                        vehiclesDiv.append(moreBtn);
                    }
                }
                metaVersionInfo = messages.extractMetaVersionInfo(json);

                mapLayer.initMap(bounds, setStartCoord, setIntermediateCoord, setEndCoord, urlParams.layer);

                // execute query
                initFromParams(urlParams, true);
            }, function (err) {
                log(err);
                $('#error').html('GraphHopper API offline? <a href="http://graphhopper.com/maps">Refresh</a>' + '<br/>Status: ' + err.statusText + '<br/>' + host);

                bounds = {
                    "minLon": -180,
                    "minLat": -90,
                    "maxLon": 180,
                    "maxLat": 90
                };
                nominatim.setBounds(bounds);
                mapLayer.initMap(bounds, setStartCoord, setIntermediateCoord, setEndCoord);
            });

    $(window).resize(function () {
        mapLayer.adjustMapSize();
    });
    $("#locationpoints").sortable({
        items: ".pointDiv",
        cursor: "n-resize",
        containment: "parent",
        handle: ".pointFlag",
        update: function (event, ui) {
            var origin_index = $(ui.item[0]).data('index');
            sortable_items = $("#locationpoints > div.pointDiv");
            $(sortable_items).each(function (index) {
                var data_index = $(this).data('index');
                if (origin_index === data_index) {
                    //log(data_index +'>'+ index);
                    ghRequest.route.move(data_index, index);
                    if (!routeIfAllResolved())
                        checkInput();
                    return false;
                }
            });
        }
    });

    $('#locationpoints > div.pointAdd').click(function () {
        ghRequest.route.add(new GHInput());
        checkInput();
    });

    checkInput();
});


function initFromParams(params, doQuery) {
    ghRequest.init(params);
    var count = 0;
    var singlePointIndex;
    if (params.point)
        for (var key = 0; key < params.point.length; key++) {
            if (params.point[key] !== "") {
                count++;
                singlePointIndex = key;
            }
        }

    var routeNow = params.point && count >= 2;
    if (routeNow) {
        resolveCoords(params.point, doQuery);
    } else if (params.point && count === 1) {
        ghRequest.route.set(params.point[singlePointIndex], singlePointIndex, true);
        resolveIndex(singlePointIndex).done(function () {
            mapLayer.focus(ghRequest.route.getIndex(singlePointIndex), 15, singlePointIndex);
        });
    }
}

function resolveCoords(pointsAsStr, doQuery) {
    for (var i = 0, l = pointsAsStr.length; i < l; i++) {
        var pointStr = pointsAsStr[i];
        var coords = ghRequest.route.getIndex(i);
        if (!coords || pointStr !== coords.input || !coords.isResolved())
            ghRequest.route.set(pointStr, i, true);
    }

    checkInput();

    if (ghRequest.route.isResolved()) {
        resolveAll();
        routeLatLng(ghRequest, doQuery);
    } else {
        // at least one text input from user -> wait for resolve as we need the coord for routing     
        $.when.apply($, resolveAll()).done(function () {
            routeLatLng(ghRequest, doQuery);
        });
    }
}

var FROM = 'from', TO = 'to';
function getToFrom(index) {
    if (index === 0)
        return FROM;
    else if (index === (ghRequest.route.size() - 1))
        return TO;
    return -1;
}

function checkInput() {
    var template = $('#pointTemplate').html(),
            len = ghRequest.route.size();

    // remove deleted points
    if ($('#locationpoints > div.pointDiv').length > len) {
        $('#locationpoints > div.pointDiv:gt(' + (len - 1) + ')').remove();
    }

    // properly unbind previously click handlers
    $("#locationpoints .pointDelete").off();

    var deleteClickHandler = function () {
        var index = $(this).parent().data('index');
        ghRequest.route.removeSingle(index);
        mapLayer.clearLayers();
        routeLatLng(ghRequest, false);
    };

    // console.log("## new checkInput");
    for (var i = 0; i < len; i++) {
        var div = $('#locationpoints > div.pointDiv').eq(i);
        // console.log(div.length + ", index:" + i + ", len:" + len);
        if (div.length === 0) {
            $('#locationpoints > div.pointAdd').before(translate.nanoTemplate(template, {id: i}));
            div = $('#locationpoints > div.pointDiv').eq(i);
        }

        var toFrom = getToFrom(i);
        div.data("index", i);
        div.find(".pointFlag").attr("src",
                (toFrom === FROM) ? 'img/marker-small-green.png' :
                ((toFrom === TO) ? 'img/marker-small-red.png' : 'img/marker-small-blue.png'));
        if (len > 2) {
            div.find(".pointDelete").click(deleteClickHandler).show();
        } else {
            div.find(".pointDelete").hide();
        }

        autocomplete.showListForIndex(ghRequest, routeIfAllResolved, i);
        if (translate.isI18nIsInitialized()) {
            var input = div.find(".pointInput");
            if (i === 0)
                $(input).attr("placeholder", translate.tr("fromHint"));
            else if (i === (len - 1))
                $(input).attr("placeholder", translate.tr("toHint"));
            else
                $(input).attr("placeholder", translate.tr("viaHint"));
        }
    }

    mapLayer.adjustMapSize();
}

function setToStart(e) {
    var latlng = e.target.getLatLng(),
            index = ghRequest.route.getIndexByCoord(latlng);
    ghRequest.route.move(index, 0);
    routeIfAllResolved();
}

function setToEnd(e) {
    var latlng = e.target.getLatLng(),
            index = ghRequest.route.getIndexByCoord(latlng);
    ghRequest.route.move(index, -1);
    routeIfAllResolved();
}

function setStartCoord(e) {
    ghRequest.route.set(e.latlng, 0);
    resolveFrom();
    routeIfAllResolved();
}

function setIntermediateCoord(e) {
    var index = ghRequest.route.size() - 1;
    ghRequest.route.add(e.latlng, index);
    resolveIndex(index);
    routeIfAllResolved();
}

function deleteCoord(e) {
    var latlng = e.target.getLatLng();
    ghRequest.route.removeSingle(latlng);
    mapLayer.clearLayers();
    routeLatLng(ghRequest, false);
}

function setEndCoord(e) {
    var index = ghRequest.route.size() - 1;
    ghRequest.route.set(e.latlng, index);
    resolveTo();
    routeIfAllResolved();
}

function routeIfAllResolved(doQuery) {
    if (ghRequest.route.isResolved()) {
        routeLatLng(ghRequest, doQuery);
        return true;
    }
    return false;
}

function setFlag(coord, index) {
    if (coord.lat) {
        var toFrom = getToFrom(index);
        // intercept openPopup
        var marker = mapLayer.createMarker(index, coord, setToEnd, setToStart, deleteCoord, ghRequest);
        marker._openPopup = marker.openPopup;
        marker.openPopup = function () {
            var latlng = this.getLatLng(),
                    locCoord = ghRequest.route.getIndexFromCoord(latlng),
                    content;
            if (locCoord.resolvedList && locCoord.resolvedList[0] && locCoord.resolvedList[0].locationDetails) {
                var address = locCoord.resolvedList[0].locationDetails;
                content = format.formatAddress(address);
                // at last update the content and update
                this._popup.setContent(content).update();
            }
            this._openPopup();
        };
        var _tempItem = {
            text: 'Set as Start',
            callback: setToStart,
            index: 1,
            state: 2
        };
        if (toFrom === -1)
            marker.options.contextmenuItems.push(_tempItem);// because the Mixin.ContextMenu isn't initialized
        marker.on('dragend', function (e) {
            mapLayer.clearLayers();
            // inconsistent leaflet API: event.target.getLatLng vs. mouseEvent.latlng?
            var latlng = e.target.getLatLng();
            autocomplete.hide();
            ghRequest.route.getIndex(index).setCoord(latlng.lat, latlng.lng);
            resolveIndex(index);
            // do not wait for resolving and avoid zooming when dragging
            ghRequest.do_zoom = false;
            routeLatLng(ghRequest, false);
        });
    }
}

function resolveFrom() {
    return resolveIndex(0);
}

function resolveTo() {
    return resolveIndex((ghRequest.route.size() - 1));
}

function resolveIndex(index) {
    setFlag(ghRequest.route.getIndex(index), index);
    if (index === 0) {
        if (!ghRequest.to.isResolved())
            mapLayer.setDisabledForMapsContextMenu('start', true);
        else
            mapLayer.setDisabledForMapsContextMenu('start', false);
    } else if (index === (ghRequest.route.size() - 1)) {
        if (!ghRequest.from.isResolved())
            mapLayer.setDisabledForMapsContextMenu('end', true);
        else
            mapLayer.setDisabledForMapsContextMenu('end', false);
    }

    return nominatim.resolve(index, ghRequest.route.getIndex(index));
}

function resolveAll() {
    var ret = [];
    for (var i = 0, l = ghRequest.route.size(); i < l; i++) {
        ret[i] = resolveIndex(i);
    }
    return ret;
}

function flagAll() {
    for (var i = 0, l = ghRequest.route.size(); i < l; i++) {
        setFlag(ghRequest.route.getIndex(i), i);
    }
}

function routeLatLng(request, doQuery) {
    // do_zoom should not show up in the URL but in the request object to avoid zooming for history change
    var doZoom = request.do_zoom;
    request.do_zoom = true;

    var urlForHistory = request.createHistoryURL() + "&layer=" + activeLayer;

    // not enabled e.g. if no cookies allowed (?)
    // if disabled we have to do the query and cannot rely on the statechange history event    
    if (!doQuery && History.enabled) {
        // 2. important workaround for encoding problems in history.js
        var params = urlTools.parseUrl(urlForHistory);
        log(params);
        params.do_zoom = doZoom;
        // force a new request even if we have the same parameters
        params.mathRandom = Math.random();
        History.pushState(params, messages.browserTitle, urlForHistory);
        return;
    }

    $("#info").empty();
    $("#info").show();
    var descriptionDiv = $("<div/>");
    $("#info").append(descriptionDiv);

    mapLayer.clearElevation();
    mapLayer.clearLayers();
    flagAll();

    mapLayer.setDisabledForMapsContextMenu('intermediate', false);

    $("#vehicles button").removeClass("selectvehicle");
    $("button#" + request.getVehicle().toLowerCase()).addClass("selectvehicle");

    var urlForAPI = request.createURL();
    descriptionDiv.html('<img src="img/indicator.gif"/> Search Route ...');
    request.doRequest(urlForAPI, function (json) {
        descriptionDiv.html("");
        if (json.message) {
            var tmpErrors = json.message;
            log(tmpErrors);
            if (json.hints) {
                for (var m = 0; m < json.hints.length; m++) {
                    descriptionDiv.append("<div class='error'>" + json.hints[m].message + "</div>");
                }
            } else {
                descriptionDiv.append("<div class='error'>" + tmpErrors + "</div>");
            }
            return;
        }
        var path = json.paths[0];
        var geojsonFeature = {
            "type": "Feature",
            // "style": myStyle,
            "geometry": path.points
        };

        if (request.hasElevation()) {
            mapLayer.addElevation(geojsonFeature);
        }

        mapLayer.addDataToRoutingLayer(geojsonFeature);
        if (path.bbox && doZoom) {
            var minLon = path.bbox[0];
            var minLat = path.bbox[1];
            var maxLon = path.bbox[2];
            var maxLat = path.bbox[3];
            var tmpB = new L.LatLngBounds(new L.LatLng(minLat, minLon), new L.LatLng(maxLat, maxLon));
            mapLayer.fitMapToBounds(tmpB);
        }

        var tmpTime = translate.createTimeString(path.time);
        var tmpDist = translate.createDistanceString(path.distance);
        var tmpEleInfoStr = "";
        if (request.hasElevation())
            tmpEleInfoStr = translate.createEleInfoString(path.ascend, path.descend);

        descriptionDiv.append(translate.tr("routeInfo", [tmpDist, tmpTime]));
        descriptionDiv.append(tmpEleInfoStr);

        $('.defaulting').each(function (index, element) {
            $(element).css("color", "black");
        });

        if (path.instructions) {
            var instructions = require('./instructions.js');
            instructions.addInstructions(mapLayer, path, urlForHistory, request);
        }
    });
}

function mySubmit() {
    var fromStr,
            toStr,
            viaStr,
            allStr = [],
            inputOk = true;
    var location_points = $("#locationpoints > div.pointDiv > input.pointInput");
    var len = location_points.size();
    $.each(location_points, function (index) {
        if (index === 0) {
            fromStr = $(this).val();
            if (fromStr !== translate.tr("fromHint") && fromStr !== "")
                allStr.push(fromStr);
            else
                inputOk = false;
        } else if (index === (len - 1)) {
            toStr = $(this).val();
            if (toStr !== translate.tr("toHint") && toStr !== "")
                allStr.push(toStr);
            else
                inputOk = false;
        } else {
            viaStr = $(this).val();
            if (viaStr !== translate.tr("viaHint") && viaStr !== "")
                allStr.push(viaStr);
            else
                inputOk = false;
        }
    });
    if (!inputOk) {
        // TODO print warning
        return;
    }
    if (fromStr === translate.tr("fromHint")) {
        // no special function
        return;
    }
    if (toStr === translate.tr("toHint")) {
        // lookup area
        ghRequest.from.setStr(fromStr);
        $.when(resolveFrom()).done(function () {
            mapLayer.focus(ghRequest.from, null, 0);
        });
        return;
    }
    // route!
    if (inputOk)
        resolveCoords(allStr);
}

function isProduction() {
    return host.indexOf("graphhopper.com") > 0;
}
