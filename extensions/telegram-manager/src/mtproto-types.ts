// Bot creation response types for the MTProto managed-bots surface (Layer 225).
// Real methods: bots.checkUsername, bots.createBot, bots.exportBotToken.
// There is NO bots.updateBot / bots.getBotToken / bots.resetBotToken.

export type BotUsernameAvailability = {
  username: string;
  available: boolean;
};

export type BotCreationResult = {
  /** Telegram user id of the newly created bot. */
  botId: string;
  /** Username without leading @. */
  username: string;
};

export type ExportedBotToken = {
  botId: string;
  token: string;
  /** True when the token was rotated (revoke=true). */
  revokedPrevious: boolean;
};

export type ManagedBotRecord = BotCreationResult & {
  createdAt: string;
};
