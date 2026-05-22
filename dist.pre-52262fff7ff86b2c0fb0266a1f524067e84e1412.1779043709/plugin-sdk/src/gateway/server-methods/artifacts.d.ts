import { type ArtifactSummary } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
type ArtifactRecord = ArtifactSummary & {
    data?: string;
    url?: string;
};
export declare function collectArtifactsFromMessages(params: {
    messages: unknown[];
    sessionKey: string;
    runId?: string;
    taskId?: string;
}): ArtifactRecord[];
export declare const artifactsHandlers: GatewayRequestHandlers;
export {};
