export const processedCardActions = new Map<string, { expiresAt: number }>();

export const resolvedCardActionChatTypes = new Map<
  string,
  { value: "p2p" | "group"; expiresAt: number }
>();
