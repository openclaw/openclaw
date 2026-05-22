export declare const MAX_AGENT_HOOK_HISTORY_MESSAGES = 100;
export declare function limitAgentHookHistoryMessages(messages: readonly unknown[], maxMessages?: number): unknown[];
export declare function buildAgentHookConversationMessages(params: {
    historyMessages?: readonly unknown[];
    currentTurnMessages?: readonly unknown[];
}): unknown[];
