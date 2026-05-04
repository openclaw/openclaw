import type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  SecretInput,
} from "openclaw/plugin-sdk/config-types";

/**
 * Transport mode for the MAX channel.
 *
 * Phase 1A scaffolding only ships `polling`; the supervisor implementation
 * lands in Phase 1B. `webhook` is reserved for Phase 2 (docs/max-plugin/plan.md §6).
 */
export type MaxTransport = "polling" | "webhook";

/**
 * User-facing per-account configuration shape for `channels.max-messenger`.
 *
 * See docs/max-plugin/plan.md §5.1 for field-by-field rationale.
 */
export type MaxAccountConfig = {
  /** Optional display name for this account (CLI/UI). */
  name?: string;
  /** Default true; set false to disable this MAX account without removing it. */
  enabled?: boolean;

  /** Bot token issued by dev.max.ru. Mutually exclusive with `tokenFile`. */
  token?: SecretInput;
  /** Path to a file containing the bot token (for secret managers). */
  tokenFile?: string;

  /** Optional API base URL override (default: https://platform-api.max.ru). */
  apiRoot?: string;

  /** Transport: "polling" (default) or "webhook" (Phase 2). */
  transport?: MaxTransport;
  /** Public URL passed to set_webhook (only used when transport === "webhook"). */
  webhookUrl?: string;
  /** Webhook server local port. */
  webhookPort?: number;
  /** Webhook server local host. */
  webhookHost?: string;
  /** Webhook endpoint path. */
  webhookPath?: string;

  /** DM policy: "allowlist" | "open" | "pairing". Default: "pairing". */
  dmPolicy?: DmPolicy;
  /** User ids allowed to DM the bot (when dmPolicy === "allowlist"). */
  allowFrom?: string[];

  /** Group policy: "allowlist" | "open" | "blocked". Default: "allowlist". */
  groupPolicy?: GroupPolicy;
  /** User ids allowed to address the bot in group chats. */
  groupAllowFrom?: string[];

  /** Per-DM overrides keyed by user id. */
  dms?: Record<string, DmConfig>;

  /** Outbound text chunk size (chars). Default: MAX_TEXT_CHUNK_LIMIT (4000). */
  textChunkLimit?: number;
  /** Disable block streaming for MAX (recommended initially: true). */
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Outbound response prefix override. */
  responsePrefix?: string;
  /** Media upload max size in MB. Default: 50. */
  mediaMaxMb?: number;
};

type MaxConfig = {
  /** Per-account configuration (multi-account lands in Phase 5). */
  accounts?: Record<string, MaxAccountConfig>;
  /** Default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & MaxAccountConfig;

export type CoreConfig = {
  channels?: { ["max-messenger"]?: MaxConfig };
  [key: string]: unknown;
};

/**
 * Resolved, normalized account snapshot used by adapters and the (future)
 * polling supervisor. Single-account in Phase 1A; multi-account expansion
 * is Phase 5 (plan.md §8 row 5).
 */
export type ResolvedMaxAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: MaxTokenSource;
  apiRoot: string;
  config: MaxAccountConfig;
};

export type MaxTokenSource = "env" | "tokenFile" | "config" | "none";

/**
 * Subset of MAX wire event variants that Phase 1A scaffolding is aware of.
 *
 * The dispatch skeleton in `adapters/inbound.adapter.ts` switches on
 * `update_type`; concrete handlers land alongside the polling supervisor in
 * Phase 1B (`message_created`) and later phases (`message_callback`,
 * attachments, membership events). See docs/max-plugin/plan.md §4.
 */
export type MaxUpdateType =
  | "bot_started"
  | "message_created"
  | "message_edited"
  | "message_removed"
  | "message_callback"
  | "bot_added"
  | "bot_removed"
  | "user_added"
  | "user_removed"
  | "chat_title_changed";

/**
 * Minimal MAX event envelope shared between the polling/webhook transports
 * and the inbound dispatcher. Concrete payload typing lands in Phase 1B
 * once the SDK shape is verified against `@maxhub/max-bot-api` 0.2.2.
 */
export type MaxEvent = {
  update_type: MaxUpdateType;
  timestamp: number;
  marker?: number;
  // oxlint-disable-next-line typescript/no-explicit-any -- exact payload shape is wired in Phase 1B once we audit the SDK runtime.
  payload?: Record<string, any>;
};

/** Normalized inbound message — populated by Phase 1B handlers. */
export type MaxMessage = {
  messageId: string;
  chatId: string;
  chatTitle?: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  isGroupChat: boolean;
  replyToMessageId?: string;
};
