import type {
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
  SecretInput,
} from "openclaw/plugin-sdk/mattermost";

export type MattermostChatMode = "oncall" | "onmessage" | "onchar";

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
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
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
};

export type MattermostConfig = {
  /** Optional per-account Mattermost configuration (multi-account). */
  accounts?: Record<string, MattermostAccountConfig>;
  /** Optional default account id when multiple accounts are configured. */
  defaultAccount?: string;
} & MattermostAccountConfig;
