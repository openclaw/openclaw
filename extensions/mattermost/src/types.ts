import type { BlockStreamingCoalesceConfig, DmPolicy, GroupPolicy } from "./runtime-api.js";
import type { SecretInput } from "./secret-input.js";

export type MattermostReplyToMode = "off" | "first" | "all" | "batched";
export type MattermostChatTypeKey = "direct" | "channel" | "group";

/**
 * Mattermost draft preview streaming mode.
 * - "partial": one preview post is created and edited in place across the
 *              whole turn (thinking → tool status → partial reply → final).
 *              This is the historical Mattermost behavior since v2026.4.20
 *              and remains the default for backward compatibility, but it
 *              causes prior preview content to disappear at every transition.
 * - "block":   a fresh preview post is created at each turn boundary
 *              (assistant-message start, reasoning end, tool start) so prior
 *              content stays visible. Recommended when you want streaming
 *              previews without losing content at every transition.
 *
 * To disable preview streaming entirely, set `blockStreaming: true` on
 * the account config. A future change may add `"off"` here for symmetry.
 */
export type MattermostPreviewStreamMode = "partial" | "block";

/**
 * Tool preview verbosity for the Mattermost draft preview stream.
 * - "name":  preview shows just the tool name, e.g. ``Running `exec`…``.
 *            This is the historical behavior and the safer default for
 *            shared channels where tool inputs may be sensitive.
 * - "args":  preview shows the tool name plus a code-block with the tool's
 *            input arguments, e.g.:
 *              Running `exec`
 *              ```bash
 *              ls -la /tmp
 *              ```
 *            Useful when you want to see exactly what the agent is doing.
 */
export type MattermostToolPreviewMode = "name" | "args";

export type MattermostStreamingConfig = {
  /** Draft preview mode. Default: "partial" (historical behavior). */
  mode?: MattermostPreviewStreamMode;
  /**
   * How much detail to render in tool-status preview posts. Default: "name"
   * (just the tool name) for backward compatibility and to avoid leaking
   * potentially sensitive command/path/input data into chat by default.
   * Set to "args" to render the actual tool args in a code block.
   */
  toolPreview?: MattermostToolPreviewMode;
};

export type MattermostChatMode = "oncall" | "onmessage" | "onchar";
type MattermostNetworkConfig = {
  /** Dangerous opt-in for self-hosted Mattermost on trusted private/internal hosts. */
  dangerouslyAllowPrivateNetwork?: boolean;
};

export type MattermostAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /**
   * Break-glass override: allow mutable identity matching (@username/display name) in allowlists.
   * Default behavior is ID-only matching.
   */
  dangerouslyAllowNameMatching?: boolean;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /** If false, do not start this Mattermost account. Default: true. */
  enabled?: boolean;
  /** Bot token for Mattermost. */
  botToken?: SecretInput;
  /** Base URL for the Mattermost server (e.g., https://chat.example.com). */
  baseUrl?: string;
  /**
   * Controls when channel messages trigger replies.
   * - "oncall": only respond when mentioned
   * - "onmessage": respond to every channel message
   * - "onchar": respond when a trigger character prefixes the message
   */
  chatmode?: MattermostChatMode;
  /** Prefix characters that trigger onchar mode (default: [">", "!"]). */
  oncharPrefixes?: string[];
  /** Require @mention to respond in channels. Default: true. */
  requireMention?: boolean;
  /** Direct message policy (pairing/allowlist/open/disabled). */
  dmPolicy?: DmPolicy;
  /** Allowlist for direct messages (user ids or @usernames). */
  allowFrom?: Array<string | number>;
  /** Allowlist for group messages (user ids or @usernames). */
  groupAllowFrom?: Array<string | number>;
  /** Group message policy (allowlist/open/disabled). */
  groupPolicy?: GroupPolicy;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /**
   * Draft preview streaming controls. When `mode` is set to `"block"`, the
   * Mattermost draft preview is split at turn boundaries (assistant-message
   * start, reasoning end, tool start) so prior content stays visible instead
   * of being overwritten in place. See PR #75252 for context.
   */
  streaming?: MattermostStreamingConfig;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  /**
   * Controls whether channel and group replies are sent as thread replies.
   * - "off" (default): only thread-reply when incoming message is already a thread reply
   * - "first": reply in a thread under the triggering message
   * - "all": always reply in a thread; uses existing thread root or starts a new thread under the message
   * Direct messages always behave as "off".
   */
  replyToMode?: MattermostReplyToMode;
  /** Action toggles for this account. */
  actions?: {
    /** Enable message reaction actions. Default: true. */
    reactions?: boolean;
  };
  /** Native slash command configuration. */
  commands?: {
    /** Enable native slash commands. "auto" resolves to false (opt-in). */
    native?: boolean | "auto";
    /** Also register skill-based commands. */
    nativeSkills?: boolean | "auto";
    /** Path for the callback endpoint on the gateway HTTP server. */
    callbackPath?: string;
    /** Explicit callback URL (e.g. behind reverse proxy). */
    callbackUrl?: string;
  };
  interactions?: {
    /** External base URL used for Mattermost interaction callbacks. */
    callbackBaseUrl?: string;
    /**
     * IP/CIDR allowlist for callback request sources when Mattermost reaches the gateway
     * over a non-loopback path. Keep this narrow to the Mattermost server or trusted ingress.
     */
    allowedSourceIps?: string[];
  };
  /** Network policy overrides for self-hosted Mattermost on trusted private/internal hosts. */
  network?: MattermostNetworkConfig;
  /** Retry configuration for DM channel creation */
  dmChannelRetry?: {
    /** Maximum number of retry attempts (default: 3) */
    maxRetries?: number;
    /** Initial delay in milliseconds before first retry (default: 1000) */
    initialDelayMs?: number;
    /** Maximum delay in milliseconds between retries (default: 10000) */
    maxDelayMs?: number;
    /** Timeout for each individual request in milliseconds (default: 30000) */
    timeoutMs?: number;
  };
};

export type MattermostConfig = {
  /** Optional per-account Mattermost configuration (multi-account). */
  accounts?: Record<string, MattermostAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & MattermostAccountConfig;
