export { UserbotClient } from "./client.js";

export type {
  UserbotClientConfig,
  InteractiveAuthParams,
  SendResult,
  SendMessageOptions,
  SendFileOptions,
  PeerResolvable,
  RawClient,
  GramMessage,
} from "./types.js";

export {
  UserbotError,
  UserbotFloodError,
  UserbotAuthError,
  UserbotPeerError,
  UserbotDisconnectedError,
  wrapGramJSError,
} from "./errors.js";
export type { UserbotErrorCode } from "./errors.js";

export {
  resolvePeer,
  parsePeerInput,
  parseTelegramTarget,
  extractNumericId,
  formatTarget,
} from "./peer.js";

export { SessionStore } from "./session-store.js";

export { ConnectionManager } from "./connection.js";
export type { ConnectionConfig, ConnectionHealth, ConnectionEvent } from "./connection.js";

export { FloodController } from "./flood-control.js";
export type { FloodControllerConfig, FloodControllerMetrics } from "./flood-control.js";

export {
  TELEGRAM_USERBOT_CHANNEL_ID,
  telegramUserbotMeta,
  telegramUserbotConfigSchema,
} from "./config-schema.js";
export type { TelegramUserbotConfig } from "./config-schema.js";

// Channel plugin + runtime
export { telegramUserbotPlugin, getConnectionManager } from "./channel.js";
export {
  setTelegramUserbotRuntime,
  clearTelegramUserbotRuntime,
  tryGetTelegramUserbotRuntime,
  getTelegramUserbotRuntime,
} from "./runtime.js";

// Adapters
export {
  telegramUserbotConfigAdapter,
  listTelegramUserbotAccountIds,
  resolveDefaultTelegramUserbotAccountId,
  resolveTelegramUserbotAccount,
} from "./adapters/config.js";
export type { ResolvedTelegramUserbotAccount } from "./adapters/config.js";
export { telegramUserbotAuthAdapter } from "./adapters/auth.js";
export { telegramUserbotSetupAdapter } from "./adapters/setup.js";
export { telegramUserbotStatusAdapter } from "./adapters/status.js";
export type { TelegramUserbotProbe } from "./adapters/status.js";
export { telegramUserbotSecurityAdapter } from "./adapters/security.js";
export { telegramUserbotOutboundAdapter } from "./adapters/outbound.js";

// Outbound helpers
export { chunkMessage, sendText, sendMedia, TELEGRAM_TEXT_LIMIT } from "./outbound.js";
export type {
  SendTextParams,
  SendTextResult,
  SendMediaParams,
  SendMediaResult,
} from "./outbound.js";

// Normalize helpers
export {
  CHANNEL_PREFIX,
  normalizeChatId,
  formatChannelChatId,
  parseChannelChatId,
} from "./normalize.js";

// Message conversion helpers
export {
  resolveChatType,
  resolveSenderName,
  resolveMediaType,
  hasDownloadableMedia,
} from "./helpers.js";
export type { ChatType } from "./helpers.js";

// Inbound message handler
export { registerInboundHandlers } from "./inbound.js";
export type { InboundHandlerConfig, InboundTelegramMessage } from "./inbound.js";
