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
