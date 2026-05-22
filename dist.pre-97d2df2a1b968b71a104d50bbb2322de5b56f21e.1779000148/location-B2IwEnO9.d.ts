//#region src/channels/location.d.ts
type LocationSource = "pin" | "place" | "live";
type NormalizedLocation = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  name?: string;
  address?: string;
  isLive?: boolean;
  source?: LocationSource;
  caption?: string;
};
declare function formatLocationText(location: NormalizedLocation): string;
declare function toLocationContext(location: NormalizedLocation): {
  LocationLat: number;
  LocationLon: number;
  LocationAccuracy?: number;
  LocationName?: string;
  LocationAddress?: string;
  LocationSource: LocationSource;
  LocationIsLive: boolean;
  LocationCaption?: string;
};
//#endregion
export { toLocationContext as i, NormalizedLocation as n, formatLocationText as r, LocationSource as t };