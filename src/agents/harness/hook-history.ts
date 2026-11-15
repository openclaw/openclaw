export const MAX_AGENT_HOOK_HISTORY_MESSAGES = 100;

export function buildAgentHookConversationMessages(params: {
  historyMessages?: readonly unknown[];
  currentTurnMessages?: readonly unknown[];
}): unknown[] {
  return [
    ...(params.historyMessages?.slice(-MAX_AGENT_HOOK_HISTORY_MESSAGES) ?? []),
    ...(params.currentTurnMessages ?? []),
  ];
}
