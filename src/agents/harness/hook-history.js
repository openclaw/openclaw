export const MAX_AGENT_HOOK_HISTORY_MESSAGES = 100;
export function limitAgentHookHistoryMessages(messages, maxMessages = MAX_AGENT_HOOK_HISTORY_MESSAGES) {
    if (maxMessages <= 0) {
        return [];
    }
    return messages.slice(-maxMessages);
}
export function buildAgentHookConversationMessages(params) {
    return [
        ...limitAgentHookHistoryMessages(params.historyMessages ?? []),
        ...(params.currentTurnMessages ?? []),
    ];
}
