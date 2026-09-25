/**
 * Shared ClickClack config, runtime account, API object, and target types.
 */
import type {
  ChannelBotLoopProtectionConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import type { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import type { ClickClackAccountConfigInput, ClickClackConfigInput } from "./config-schema.js";

/** Per-channel group policy for a ClickClack group/channel. */
export type ClickClackGroupConfig = NonNullable<ClickClackAccountConfigInput["groups"]>[string];

/** User-configurable settings for one ClickClack account. */
export type ClickClackAccountConfig = Omit<
  ClickClackAccountConfigInput,
  "configWrites" | "token"
> & {
  token?: unknown;
};

/** Root ClickClack channel config with optional named accounts. */
type ClickClackConfig = Omit<ClickClackConfigInput, "token" | "accounts"> & {
  token?: unknown;
  accounts?: Record<string, Partial<ClickClackAccountConfig>>;
};

/** OpenClaw config narrowed to include ClickClack channel settings. */
export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    clickclack?: ClickClackConfig;
  };
};

/** Normalized account snapshot consumed by runtime paths. */
export type ResolvedClickClackAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  baseUrl: string;
  apiEndpoint: string;
  token: string;
  tokenSource?: "env" | "tokenFile" | "config" | "none";
  tokenStatus?: "available" | "configured_unavailable" | "missing";
  credentialDiagnostics?: Extract<
    ReturnType<typeof tryReadSecretFileSync>,
    { status: "configured_unavailable" }
  >["diagnostic"][];
  workspace: string;
  botUserId?: string;
  botHandle?: string;
  agentId?: string;
  replyMode: "agent" | "model";
  model?: string;
  systemPrompt?: string;
  toolsAllow?: string[];
  defaultTo: string;
  allowFrom: string[];
  allowBots: boolean | "mentions";
  botLoopProtection?: ChannelBotLoopProtectionConfig;
  reconnectMs: number;
  agentActivity: boolean;
  nativeProgress?: boolean;
  commandMenu: boolean;
  discussions: {
    enabled: boolean;
    workspace: string;
    controlUrlBase?: string;
    section: string;
  };
  config: ClickClackAccountConfig;
  requireMention: boolean;
  mentionPatterns: string[];
  groups: Record<string, ClickClackGroupConfig>;
};

/**
 * One running start of a ClickClack account. Background work it begins, such
 * as forwarding question card answers, ends when its signal aborts.
 */
export type ClickClackAccountLifetime = {
  cfg: CoreConfig;
  account: ResolvedClickClackAccount;
  abortSignal: AbortSignal;
  /**
   * Runs a callback in the account start's async context. Work that a turn's
   * delivery schedules must not keep that turn's caller identity after it ends.
   */
  runInAccountContext: <T>(run: () => T) => T;
};

/** User object returned by the ClickClack API. */
export type ClickClackUser = {
  id: string;
  kind?: "human" | "bot";
  owner_user_id?: string;
  display_name: string;
  handle: string;
  avatar_url: string;
  created_at: string;
};

/** Bot command row returned by the ClickClack command-menu API. */
export type ClickClackBotCommand = {
  id: string;
  workspace_id: string;
  bot_user_id: string;
  command: string;
  description: string;
  args_hint: string;
  created_at: string;
  updated_at: string;
};

/** One-time bot token and installer context returned by setup-code claim. */
export type ClickClackSetupCodeClaim = {
  contract_version?: 1;
  api_base_url?: string;
  token: string;
  bot: {
    id: string;
    handle: string;
    display_name: string;
  };
  workspace: {
    id: string;
    route_id: string;
    slug: string;
    name: string;
  };
  defaults: {
    defaultTo?: string;
    allowFrom?: string[];
    agentActivity?: boolean;
  };
};

/** Workspace object returned by the ClickClack API. */
export type ClickClackWorkspace = {
  id: string;
  route_id: string;
  name: string;
  slug: string;
  created_at: string;
};

/** Channel object returned by the ClickClack API. */
export type ClickClackChannel = {
  id: string;
  route_id: string;
  workspace_id: string;
  name: string;
  kind: string;
  external_managed?: boolean;
  external_ref?: string;
  external_url?: string;
  sidebar_section?: string;
  display_title?: string;
  archived?: boolean;
  archived_at?: string | null;
  created_at: string;
};

/** Message object returned by ClickClack channel, DM, and thread endpoints. */
export type ClickClackMessage = {
  id: string;
  workspace_id: string;
  channel_id?: string;
  direct_conversation_id?: string;
  author_id: string;
  parent_message_id?: string;
  thread_root_id: string;
  channel_seq?: number;
  thread_seq?: number;
  body: string;
  body_format: "markdown";
  created_at: string;
  kind?: "message" | "agent_commentary" | "agent_tool";
  author?: ClickClackUser;
  thread_state?: {
    root_message_id: string;
    reply_count: number;
    last_reply_at?: string;
    last_reply_author_ids: string[];
  };
  /** Present on bot messages that carry a structured question. */
  question?: ClickClackMessageQuestion;
};

/** One question in a ClickClack question card. */
export type ClickClackQuestionItem = {
  id: string;
  header: string;
  prompt: string;
  url?: string;
  options?: Array<{ label: string; description?: string }>;
  multi_select?: boolean;
  allow_other?: boolean;
};

/** Question a bot attaches when it creates a message. */
export type ClickClackQuestionSpec = {
  external_id?: string;
  expires_at: string;
  allow_skip?: boolean;
  items: ClickClackQuestionItem[];
};

export type ClickClackQuestionStatus =
  | "open"
  | "submitted"
  | "answered"
  | "cancelled"
  | "expired"
  | "failed";

/** Question facet as the server reports it on a message. */
export type ClickClackMessageQuestion = {
  status: ClickClackQuestionStatus;
  external_id?: string;
  expires_at: string;
  allow_skip: boolean;
  items: ClickClackQuestionItem[];
  response?: {
    answers?: Record<string, string[]>;
    skipped?: boolean;
    source: "clickclack" | "external";
    responder?: ClickClackUser;
  };
  note?: string;
  version: number;
};

/** Outcome a bot records on one of its question cards. */
export type ClickClackQuestionResolution = {
  status: Exclude<ClickClackQuestionStatus, "submitted">;
  note?: string;
  expected_version?: number;
};

/** Unresolved question listed for a bot during reconciliation. */
export type ClickClackBotQuestion = {
  message_id: string;
  external_id?: string;
  status: "open" | "submitted";
  expires_at: string;
  version: number;
};

/** Realtime event envelope returned by ClickClack polling/websocket APIs. */
export type ClickClackEvent = {
  id: string;
  cursor: string;
  type: string;
  workspace_id: string;
  channel_id?: string;
  seq?: number;
  created_at: string;
  payload: Record<string, unknown>;
};

/**
 * Optional attribution metadata stamped onto agent-authored posts
 * (author_model / author_thinking / author_runtime). Servers that do not
 * define these columns ignore the unknown JSON fields, so sending them is
 * always safe; servers that do define them persist per-message provenance.
 */
export type ClickClackMessageProvenance = {
  model?: string;
  thinking?: string;
  runtime?: string;
};

/** Parsed outbound destination for ClickClack delivery. */
export type ClickClackTarget =
  | { chatType: "group"; kind: "channel"; id: string }
  | { chatType: "group"; kind: "thread"; id: string }
  | { chatType: "direct"; kind: "dm"; id: string };
