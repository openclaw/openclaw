export type MediaPayloadInput = {
    path: string;
    contentType?: string;
};
export type MediaPayload = {
    MediaPath?: string;
    MediaType?: string;
    MediaUrl?: string;
    MediaPaths?: string[];
    MediaUrls?: string[];
    MediaTypes?: string[];
};
export declare function buildMediaPayload(mediaList: MediaPayloadInput[], opts?: {
    preserveMediaTypeCardinality?: boolean;
}): MediaPayload;
