import type { AgentMessage } from "@mariozechner/pi-agent-core";
export declare const QUEUED_USER_MESSAGE_MARKER = "[Queued user message that arrived while the previous turn was still active]";
export declare function textOrphanLeaf(text?: string): {
    content: string;
};
export declare function structuredOrphanLeaf(): {
    content: unknown[];
};
export declare function inlineDataUriOrphanLeaf(): {
    content: unknown[];
};
export declare function mediaOnlyHistoryMessage(): AgentMessage;
export declare function structuredHistoryMessage(): AgentMessage;
export declare function currentPromptHistoryMessage(prompt: string): AgentMessage;
export declare function assistantHistoryMessage(text?: string): AgentMessage;
