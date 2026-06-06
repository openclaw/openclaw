// Feishu type declarations define plugin contracts.
export type MentionTarget = {
  openId: string;
  name: string;
  key: string; // Placeholder in original message, e.g. @_user_1
  /** Whether the mention target is a human user or another bot. Only present on webhook events that carry `mentioned_type`. */
  mentionedType?: "user" | "bot";
};
