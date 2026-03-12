export type LocationSource = "pin" | "place" | "live";
export type NormalizedLocation = {
    latitude: number;
    longitude: number;
    accuracy?: number;
    name?: string;
    address?: string;
    isLive?: boolean;
    source?: LocationSource;
    caption?: string;
};
export declare function formatLocationText(location: NormalizedLocation): string;
export declare function toLocationContext(location: NormalizedLocation): {
    LocationLat: number;
    LocationLon: number;
    LocationAccuracy?: number;
    LocationName?: string;
    LocationAddress?: string;
    LocationSource: LocationSource;
    LocationIsLive: boolean;
};
