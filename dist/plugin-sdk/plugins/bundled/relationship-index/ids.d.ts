import { type EntityId } from "../../../sre/contracts/entity.js";
export declare function createMessageEntityId(params: {
    channelId: string;
    conversationId?: string;
    messageId?: string;
}): EntityId | undefined;
export declare function createThreadEntityId(params: {
    channelId: string;
    conversationId?: string;
    threadId?: string | number;
}): EntityId | undefined;
export declare function createToolCallEntityId(params: {
    runId?: string;
    sessionKey?: string;
    toolCallId?: string;
    toolName: string;
}): EntityId;
export declare function createArtifactEntityId(params: {
    toolName: string;
    toolCallId?: string;
    runId?: string;
    kind: "error" | "result";
}): EntityId;
export declare function createSessionEntityId(sessionKey: string | undefined): EntityId | undefined;
export declare function createWorkdirEntityId(workspaceDir: string | undefined): EntityId | undefined;
export declare function createRepoEntityId(params: {
    workspaceDir?: string;
    repoRoot?: string;
}): EntityId | undefined;
export declare function normalizeEntityId(value: string | undefined): EntityId | undefined;
