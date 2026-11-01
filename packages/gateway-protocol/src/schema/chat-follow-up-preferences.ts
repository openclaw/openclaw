/** Personal send policy shared by every client and runtime ingress. */
export const CHAT_FOLLOW_UP_PREFERENCE_KEY = "chat.followUpMode";
export const CHAT_FOLLOW_UP_MODES = ["queue", "steer", "interrupt"] as const;
export type ChatFollowUpMode = (typeof CHAT_FOLLOW_UP_MODES)[number];
export function normalizeChatFollowUpModePreference(value: unknown): ChatFollowUpMode | undefined {
  return CHAT_FOLLOW_UP_MODES.find((mode) => mode === value);
}
