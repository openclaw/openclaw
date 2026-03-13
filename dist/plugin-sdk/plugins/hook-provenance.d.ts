import type { AgentMessage } from "@mariozechner/pi-agent-core";
export type HookProvenanceFields = {
    entityId?: string;
    parentEntityId?: string;
    sourceRefs?: string[];
    derivedFrom?: string[];
    confidence?: number;
};
export declare function normalizeRefs(values: Array<string | number | undefined | null>): string[] | undefined;
export declare function createSessionEntityId(sessionKey: string | undefined): string | undefined;
export declare function createThreadEntityId(params: {
    explicitThreadEntityId?: string;
    channelId?: string;
    conversationId?: string;
    threadId?: string | number;
}): string | undefined;
export declare function createMessageEntityId(params: {
    channelId?: string;
    messageId?: string;
    from?: string;
    content?: string;
    timestamp?: number;
}): string | undefined;
export declare function createToolCallEntityId(params: {
    toolName?: string;
    toolCallId?: string;
    runId?: string;
    sessionKey?: string;
}): string | undefined;
export declare function createSubagentEntityId(params: {
    childSessionKey?: string;
    targetSessionKey?: string;
    runId?: string;
    agentId?: string;
    reason?: string;
}): string | undefined;
export declare function buildMessagePersistenceProvenance(params: {
    message: AgentMessage;
    sessionKey?: string;
    toolName?: string;
    toolCallId?: string;
    isSynthetic?: boolean;
}): HookProvenanceFields;
