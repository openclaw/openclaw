/**
 * Webhook 模块公共入口
 *
 * Re-export 所有 Webhook 模式对外暴露的函数和类型。
 */

// ── Handler ─────────────────────────────────────────────────────────
export { handleWecomWebhookRequest } from "./handler.js";

// ── Target ──────────────────────────────────────────────────────────
export {
  registerWecomWebhookTarget,
  getRegisteredTargets,
  getWebhookTargetsMap,
  hasActiveTargets,
  parseWebhookPath,
} from "./target.js";

// ── Gateway ─────────────────────────────────────────────────────────
export { startWebhookGateway, stopWebhookGateway, getMonitorState } from "./gateway.js";

// ── Types ───────────────────────────────────────────────────────────
export type {
  WecomWebhookTarget,
  WebhookGatewayContext,
  ResolvedWebhookAccount,
  WebhookAccountConfig,
  WecomRuntimeEnv,
  StreamState,
  PendingInbound,
  ActiveReplyState,
  WebhookInboundMessage,
} from "./types.js";

export {
  STREAM_TTL_MS,
  ACTIVE_REPLY_TTL_MS,
  DEFAULT_DEBOUNCE_MS,
  STREAM_MAX_BYTES,
  BOT_WINDOW_MS,
  BOT_SWITCH_MARGIN_MS,
  REQUEST_TIMEOUT_MS,
  PRUNE_INTERVAL_MS,
  WEBHOOK_PATHS,
} from "./types.js";

// ── State (全局单例) ────────────────────────────────────────────────
export { monitorState, WebhookMonitorState } from "./state.js";
