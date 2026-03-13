export type AgentMediaPayload = {
    MediaPath?: string;
    MediaType?: string;
    MediaUrl?: string;
    MediaPaths?: string[];
    MediaUrls?: string[];
    MediaTypes?: string[];
};
export declare function buildAgentMediaPayload(mediaList: Array<{
    path: string;
    contentType?: string | null;
}>): AgentMediaPayload;
