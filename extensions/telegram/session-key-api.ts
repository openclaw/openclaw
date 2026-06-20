// Telegram API module exposes the plugin public contract.
export {
  parseTelegramDirectSessionKey,
  resolveTelegramSessionConversation as resolveSessionConversation,
  type ParsedTelegramDirectSessionKey,
} from "./src/session-conversation.js";
