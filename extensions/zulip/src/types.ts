import type {
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
} from "openclaw/plugin-sdk";

export type ZulipTopicConfig = {
  /** Number of recent topic messages to include on first turn. Default: 20. */
  initialHistoryLimit?: number;
};

export type ZulipXCaseAutoTriageMode = "off" | "command_post_only" | "mentioned" | "always";

export type ZulipXCaseCaseTopicMode = "always" | "on_continue" | "never";

export type ZulipXCaseRouteConfig = {
  /**
   * Expert agent id to use for analysis in this route (e.g. "exdi", "artie").
   * If omitted, the normal routing config for the xcase peer id applies.
   */
  expertAgentId?: string;
  /**
   * Where to post analysis output by default.
   * If omitted, falls back to xcase.commandPostStream.
   */
  analysisStream?: string;
  /**
   * Default analysis/inbox topic for this route (shared, not per-case).
   * If omitted, falls back to `x/<routeKey>`.
   */
  analysisTopic?: string;
  /** Extra keywords that can be used to select this route (case-insensitive). */
  aliases?: string[];
  /**
   * If set, send analysis messages using this Zulip accountId (so the message comes "from" that bot).
   * Example: "exdi" to post as the Exdi bot.
   */
  postAsAccountId?: string;
};

export type ZulipGroupConfig = {
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

export type ZulipThreadBindingsConfig = {
  /** Enable Zulip topic-bound session routing and lifecycle. */
  enabled?: boolean;
  /** Inactivity window in hours for topic-bound sessions. Set 0 to disable. */
  idleHours?: number;
  /** Hard max age in hours for topic-bound sessions. Set 0 to disable. */
  maxAgeHours?: number;
};

export type ZulipExecApprovalTarget = "dm" | "session" | "both" | "stream";

export type ZulipExecApprovalConfig = {
  /** Enable transport-owned exec approval prompts for this Zulip account. */
  enabled?: boolean;
  /** Zulip user IDs allowed to approve requests and, for DM mode, notified directly. */
  approvers?: Array<string | number>;
  /** Only handle approvals for these agent IDs. Omit = all agents. */
  agentFilter?: string[];
  /** Only handle approvals matching these session key patterns (substring or regex). */
  sessionFilter?: string[];
  /** Collapse resolved/expired messages to a short status update when possible.
   * Zulip currently edits message content instead of deleting the original widget message.
   */
  cleanupAfterResolve?: boolean;
  /** Where to send approval prompts. Default: "dm". */
  target?: ZulipExecApprovalTarget;
  /** Shared approval stream when target="stream". */
  stream?: string;
  /** Shared approval topic when target="stream". Default: "exec-approvals". */
  topic?: string;
};

export type ZulipXCaseConfig = {
  /** Enable x.com/twitter.com case triage workflow. */
  enabled?: boolean;
  /** Command-post stream where xcase cards and controls are posted. */
  commandPostStream?: string;
  /** Base command-post topic (when perCaseTopic is false). */
  commandPostTopic?: string;
  /** Split each link into a dedicated analysis topic (legacy; use caseTopicMode). */
  perCaseTopic?: boolean;
  /**
   * Controls when xcase creates a dedicated per-link topic.
   * - always: create per-case topic immediately (legacy default)
   * - on_continue: only create per-case topic when `/xcase continue` is used
   * - never: never create per-case topics
   */
  caseTopicMode?: ZulipXCaseCaseTopicMode;
  /** Auto-triage trigger mode. */
  autoTriage?: ZulipXCaseAutoTriageMode;
  /** If false, auto-triage will only capture/create cards, not run analysis. Default: true. */
  autoAnalyzeOnCapture?: boolean;
  /** Prefix used when deriving routing peer ids for expert sessions. */
  routePeerPrefix?: string;
  /** Optional pinned expert agent id. */
  expertAgentId?: string;
  /** Optional expert pool; stable-hash selected by case id. */
  expertAgentIds?: string[];
  /**
   * Optional per-agent/per-domain routes (keyed by a short route key like "exdi", "artie").
   * Used for expert selection + analysis destination.
   */
  routes?: Record<string, ZulipXCaseRouteConfig>;
  /** Default route key (used when no override is detected). Default: "default". */
  defaultRoute?: string;
  /** Maximum links processed from one message. */
  maxLinksPerMessage?: number;
  /** Maximum number of open/active cases retained. */
  maxOpenCases?: number;
  /** Include source message context in expert-analysis prompts. */
  includeMessageContext?: boolean;
};

export type ZulipAccountConfig = {
  name?: string;
  capabilities?: string[];
  configWrites?: boolean;
  enabled?: boolean;
  /** Bot email for Zulip Basic auth. */
  botEmail?: string;
  /** Bot API key for Zulip Basic auth. */
  botApiKey?: string;
  /** Base URL for the Zulip server (e.g., https://chat.example.com). */
  baseUrl?: string;
  /** If true, skip TLS certificate verification (for self-signed certs). */
  tlsRejectUnauthorized?: boolean;
  /** Require @mention to respond in streams. Default: true. */
  requireMention?: boolean;
  /** Direct message policy. */
  dmPolicy?: DmPolicy;
  /** Allowlist for direct messages (Zulip emails or user ids). */
  allowFrom?: Array<string | number>;
  /** Allowlist for stream messages. */
  groupAllowFrom?: Array<string | number>;
  /** Stream/group message policy. */
  groupPolicy?: GroupPolicy;
  /** Outbound text chunk size (chars). Default: 10000. */
  textChunkLimit?: number;
  /** Chunking mode. */
  chunkMode?: "length" | "newline";
  /** Disable block streaming for this account. */
  blockStreaming?: boolean;
  /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  /** Draft streaming mode: edit-in-place preview while LLM generates.
   * - "off": disabled (default)
   * - "partial": update preview with cumulative text
   * - "block": update preview with block-chunked text
   */
  draftStreaming?: "off" | "partial" | "block";
  /** Throttle interval (ms) between draft stream edits. Default: 1200. */
  draftStreamingThrottleMs?: number;
  /** Per-DM DM policy overrides by Zulip sender key. */
  groups?: Record<string, ZulipGroupConfig>;
  /** Topic/thread behavior for stream messages. */
  topic?: ZulipTopicConfig;
  /** Per-stream overrides keyed by stream name. */
  streams?: Record<
    string,
    {
      /** Require mention for this stream (overrides account-level requireMention). */
      requireMention?: boolean;
    }
  >;
  /** Enable ocform interactive widget support (requires lionroot-zulip fork). */
  widgetsEnabled?: boolean;
  /** Topic-bound session lifecycle overrides. */
  threadBindings?: ZulipThreadBindingsConfig;
  /** Transport-owned exec approval prompts. */
  execApprovals?: ZulipExecApprovalConfig;
  /** X/Twitter command-post triage workflow. */
  xcase?: ZulipXCaseConfig;
};

export type ZulipConfig = {
  accounts?: Record<string, ZulipAccountConfig>;
} & ZulipAccountConfig;
