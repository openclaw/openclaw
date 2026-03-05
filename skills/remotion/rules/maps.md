---
name: maps
description: Make map animations with Mapbox
metadata:
  tags: map, map animation, mapbox
---

Maps can be added to a Remotion video with Mapbox.
The [Mapbox documentation](https://docs.mapbox.com/mapbox-gl-js/api/) has the API reference.

## Prerequisites

Mapbox and `@turf/turf` need to be installed.

Search the project for lockfiles and run the correct command depending on the package manager:

If `package-lock.json` is found, use the following command:

```bash
npm i mapbox-gl @turf/turf @types/mapbox-gl
```

If `bun.lock` is found, use the following command:

```bash
bun i mapbox-gl @turf/turf @types/mapbox-gl
```

If `yarn.lock` is found, use the following command:

```bash
yarn add mapbox-gl @turf/turf @types/mapbox-gl
```

If `pnpm-lock.yaml` is found, use the following command:

```bash
pnpm i mapbox-gl @turf/turf @types/mapbox-gl
```

The user needs to create a free Mapbox account and create an access token by visiting https://console.mapbox.com/account/access-tokens/.

The mapbox token needs to be added to the `.env` file:

```txt title=".env"
REMOTION_MAPBOX_TOKEN=pk.your-mapbox-access-token
```

## Adding a map

Here is a basic example of a map in Remotion.

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { AbsoluteFill, useDelayRender, useVideoConfig } from "remotion";
import mapboxgl, { Map } from "mapbox-gl";

export const lineCoordinates = [
  [6.56158447265625, 46.059891147620725],
  [6.5691375732421875, 46.05679376154153],
  [6.5842437744140625, 46.05059898938315],
  [6.594886779785156, 46.04702502069337],
  [6.601066589355469, 46.0460718554722],
  [6.6089630126953125, 46.0365370783104],
  [6.6185760498046875, 46.018420689207964],
];

mapboxgl.accessToken = process.env.REMOTION_MAPBOX_TOKEN as string;

export const MyComposition = () => {
  const ref = useRef<HTMLDivElement>(null);
  const { delayRender, continueRender } = useDelayRender();

  const { width, height } = useVideoConfig();
  const [handle] = useState(() => delayRender("Loading map..."));
  const [map, setMap] = useState<Map | null>(null);

  useEffect(() => {
    const _map = new Map({
      container: ref.current!,
      zoom: 11.53,
      center: [6.5615, 46.0598],
      pitch: 65,
      bearing: 0,
      style: "⁠mapbox://styles/mapbox/standard",
      interactive: false,
      fadeDuration: 0,
    });

    _map.on("style.load", () => {
      // Hide all features from the Mapbox Standard style
      const hideFeatures = [
        "showRoadsAndTransit",
        "showRoads",
        "showTransit",
        "showPedestrianRoads",
        "showRoadLabels",
        "showTransitLabels",
        "showPlaceLabels",
        "showPointOfInterestLabels",
        "showPointsOfInterest",
        "showAdminBoundaries",
        "showLandmarkIcons",
        "showLandmarkIconLabels",
        "show3dObjects",
        "show3dBuildings",
        "show3dTrees",
        "show3dLandmarks",
        "show3dFacades",
      ];
      for (const feature of hideFeatures) {
        _map.setConfigProperty("basemap", feature, false);
      }

      _map.setConfigProperty("basemap", "colorTrunks", "rgba(0, 0, 0, 0)");

      _map.addSource("trace", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: lineCoordinates,
          },
        },
      });
      _map.addLayer({
        type: "line",
        source: "trace",
        id: "line",
        paint: {
          "line-color": "black",
          "line-width": 5,
        },
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
      });
    });

    _map.on("load", () => {
      continueRender(handle);
      setMap(_map);
    });
  }, [handle, lineCoordinates]);

  const style: React.CSSProperties = useMemo(
    () => ({ width, height, position: "absolute" }),
    [width, height],
  );

  return <AbsoluteFill ref={ref} style={style} />;
};
```

The following is important in Remotion:

- Animations must be driven by `useCurrentFrame()` and animations that Mapbox brings itself should be disabled. For example, the `fadeDuration` prop should be set to `0`, `interactive` should be set to `false`, etc.
- Loading the map should be delayed using `useDelayRender()` and the map should be set to `null` until it is loaded.
- The element containing the ref MUST have an explicit width and height and `position: "absolute"`.
- Do not add a `_map.remove();` cleanup function.

## Drawing lines

Unless I request it, do not add a glow effect to the lines.
Unless I request it, do not add additional points to the lines.

## Map style

By default, use the `mapbox://styles/mapbox/standard` style.
Hide the labels from the base map style.

Unless I request otherwise, remove all features from the Mapbox Standard style.

```tsx
// Hide all features from the Mapbox Standard style
const hideFeatures = [
  "showRoadsAndTransit",
  "showRoads",
  "showTransit",
  "showPedestrianRoads",
  "showRoadLabels",
  "showTransitLabels",
  "showPlaceLabels",
  "showPointOfInterestLabels",
  "showPointsOfInterest",
  "showAdminBoundaries",
  "showLandmarkIcons",
  "showLandmarkIconLabels",
  "show3dObjects",
  "show3dBuildings",
  "show3dTrees",
  "show3dLandmarks",
  "show3dFacades",
];
for (const feature of hideFeatures) {
  _map.setConfigProperty("basemap", feature, false);
}

_map.setConfigProperty("basemap", "colorMotorways", "transparent");
_map.setConfigProperty("basemap", "colorRoads", "transparent");
_map.setConfigProperty("basemap", "colorTrunks", "transparent");
```

## Animating the camera

You can animate the camera along the line by adding a `useEffect` hook that updates the camera position based on the current frame.

Unless I ask for it, do not jump between camera angles.

```tsx
import { useState } from "react";
import * as turf from "@turf/turf";
import { interpolate, Easing, useCurrentFrame, useVideoConfig, useDelayRender } from "remotion";

const animationDuration = 20;
const cameraAltitude = 4000;
```

```tsx
const frame = useCurrentFrame();
const { fps } = useVideoConfig();
const { delayRender, continueRender } = useDelayRender();
const [handle] = useState(() => delayRender("Moving point..."));

useEffect(() => {
  if (!map) {
    return;
  }

  const routeDistance = turf.length(turf.lineString(lineCoordinates));

  const progress = interpolate(frame / fps, [0.00001, animationDuration], [0, 1], {
    easing: Easing.inOut(Easing.sin),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const camera = map.getFreeCameraOptions();

  const alongRoute = turf.along(turf.lineString(lineCoordinates), routeDistance * progress).geometry
    .coordinates;

  camera.lookAtPoint({
    lng: alongRoute[0],
    lat: alongRoute[1],
  });

  map.setFreeCameraOptions(camera);
  map.once("idle", () => continueRender(handle));
}, [lineCoordinates, fps, frame, handle, map]);
```

Notes:

IMPORTANT: Keep the camera by default so north is up.
IMPORTANT: For multi-step animations, set all properties at all stages (zoom, position, line progress) to prevent jumps. Override initial values.

- The progress is clamped to a minimum value to avoid the line being empty, which can lead to turf errors
- See [Timing](./timing.md) for more options for timing.
- Consider the dimensions of the composition and make the lines thick enough and the label font size large enough to be legible for when the composition is scaled down.

## Animating lines

### Straight lines (linear interpolation)

To animate a line that appears straight on the map, use linear interpolation between coordinates. Do NOT use turf's `lineSliceAlong` or `along` functions, as they use geodesic (great circle) calculations which appear curved on a Mercator projection.

```tsx
const frame = useCurrentFrame();
const { durationInFrames } = useVideoConfig();

useEffect(() => {
  if (!map) return;

  const animationHandle = delayRender("Animating line...");

  const progress = interpolate(frame, [0, durationInFrames - 1], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });

  // Linear interpolation for a straight line on the map
  const start = lineCoordinates[0];
  const end = lineCoordinates[1];
  const currentLng = start[0] + (end[0] - start[0]) * progress;
  const currentLat = start[1] + (end[1] - start[1]) * progress;

  const lineData: GeoJSON.Feature<GeoJSON.LineString> = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: [start, [currentLng, currentLat]],
    },
  };

  const source = map.getSource("trace") as mapboxgl.GeoJSONSource;
  if (source) {
    source.setData(lineData);
  }

  map.once("idle", () => continueRender(animationHandle));
}, [frame, map, durationInFrames]);
```

### Curved lines (geodesic/great circle)

To animate a line that follows the geodesic (great circle) path between two points, use turf's `lineSliceAlong`. This is useful for showing flight paths or the actual shortest distance on Earth.

```tsx
import * as turf from "@turf/turf";

const routeLine = turf.lineString(lineCoordinates);
const routeDistance = turf.length(routeLine);

const currentDistance = Math.max(0.001, routeDistance * progress);
const slicedLine = turf.lineSliceAlong(routeLine, 0, currentDistance);

const source = map.getSource("route") as mapboxgl.GeoJSONSource;
if (source) {
  source.setData(slicedLine);
}
```

## Markers

Add labels, and markers where appropriate.

```tsx
_map.addSource("markers", {
  type: "geojson",
  data: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Point 1" },
        geometry: { type: "Point", coordinates: [-118.2437, 34.0522] },
      },
    ],
  },
});

_map.addLayer({
  id: "city-markers",
  type: "circle",
  source: "markers",
  paint: {
    "circle-radius": 40,
    "circle-color": "#FF4444",
    "circle-stroke-width": 4,
    "circle-stroke-color": "#FFFFFF",
  },
});

_map.addLayer({
  id: "labels",
  type: "symbol",
  source: "markers",
  layout: {
    "text-field": ["get", "name"],
    "text-font": ["DIN Pro Bold", "Arial Unicode MS Bold"],
    "text-size": 50,
    "text-offset": [0, 0.5],
    "text-anchor": "top",
  },
  paint: {
    "text-color": "#FFFFFF",
    "text-halo-color": "#000000",
    "text-halo-width": 2,
  },
});
```

Make sure they are big enough. Check the composition dimensions and scale the labels accordingly.
For a composition size of 1920x1080, the label font size should be at least 40px.

IMPORTANT: Keep the `text-offset` small enough so it is close to the marker. Consider the marker circle radius. For a circle radius of 40, this is a good offset:

```tsx
"text-offset": [0, 0.5],
```

## 3D buildings

To enable 3D buildings, use the following code:

```tsx
_map.setConfigProperty("basemap", "show3dObjects", true);
_map.setConfigProperty("basemap", "show3dLandmarks", true);
_map.setConfigProperty("basemap", "show3dBuildings", true);
```

## Rendering

When rendering a map animation, make sure to render with the following flags:

```
npx remotion render --gl=angle --concurrency=1
```