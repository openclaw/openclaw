import { z } from "zod";

export const DEFAULT_DATA_DIR = "~/.openclaw/state/deltachat";

const allowFromEntry = z.union([z.string(), z.number()]);

const toolPolicySchema = z.union([
  z.enum(["allow", "deny"]),
  z.object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  }),
]);

const deltaChatGroupSchema = z
  .object({
    users: z.array(allowFromEntry).optional(),
    // Require @mention for commands in this group
    requireMention: z.boolean().optional(),
    // Tool policy for this group
    tools: toolPolicySchema.optional(),
    // Per-sender tool permissions (overrides group-level tools)
    toolsBySender: z.record(z.string(), toolPolicySchema).optional(),
  })
  .optional();

export const DeltaChatAccountConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  dataDir: z.string().optional(),
  addr: z.string().optional(),
  mail_pw: z.string().optional(),
  bot: z.string().optional(),
  e2ee_enabled: z.string().optional(),
  chatmailQr: z.string().optional(),
  dm: z
    .object({
      enabled: z.boolean().optional(),
      policy: z.enum(["disabled", "pairing", "allowlist", "open"]).optional(),
      allowFrom: z.array(z.string()).optional(),
    })
    .optional(),
  groupPolicy: z.enum(["allowlist", "open"]).optional(),
  groupAllowFrom: z.array(z.string()).optional(),
  groups: z.object({}).catchall(deltaChatGroupSchema).optional(),
  mediaMaxMb: z.number().optional(),
  replyToMode: z.enum(["off", "reply", "thread"]).optional(),
  initialSyncLimit: z.number().optional(),
  reactionLevel: z.enum(["off", "ack", "minimal", "extensive"]).optional(),
  actions: z
    .object({
      reactions: z.boolean().optional(),
    })
    .optional(),
  ackReaction: z.string().optional(),
  ackReactionScope: z.enum(["off", "group-mentions", "group-all", "direct", "all"]).optional(),
  livenessReactionsEnabled: z.boolean().optional(),
  livenessReactionIntervalSeconds: z.number().int().positive().optional(),
});

export const DeltaChatConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    dataDir: z.string().optional(),
    addr: z.string().optional(),
    mail_pw: z.string().optional(),
    bot: z.string().optional(),
    e2ee_enabled: z.string().optional(),
    chatmailQr: z.string().optional(),
    allowlistOnly: z.boolean().optional(),
    dm: z
      .object({
        enabled: z.boolean().optional(),
        policy: z.enum(["disabled", "pairing", "allowlist", "open"]).optional(),
        allowFrom: z.array(z.string()).optional(),
      })
      .optional(),
    groupPolicy: z.enum(["allowlist", "open"]).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groups: z.object({}).catchall(deltaChatGroupSchema).optional(),
    mediaMaxMb: z.number().optional(),
    replyToMode: z.enum(["off", "reply", "thread"]).optional(),
    initialSyncLimit: z.number().optional(),
    reactionLevel: z.enum(["off", "ack", "minimal", "extensive"]).optional(),
    actions: z
      .object({
        reactions: z.boolean().optional(),
      })
      .optional(),
    ackReaction: z.string().optional(),
    ackReactionScope: z.enum(["off", "group-mentions", "group-all", "direct", "all"]).optional(),
    livenessReactionsEnabled: z.boolean().optional(),
    livenessReactionIntervalSeconds: z.number().int().positive().optional(),
    accounts: z.record(z.string(), DeltaChatAccountConfigSchema).optional(),
  })
  .strict();

export type DeltaChatConfig = z.infer<typeof DeltaChatConfigSchema>;

export interface CoreConfig {
  session?: {
    store?: string;
  };
  commands?: {
    useAccessGroups?: boolean;
  };
  channels?: {
    deltachat?: DeltaChatConfig;
    defaults?: {
      groupPolicy?: "allowlist" | "open";
    };
  };
}

export type ReplyToMode = "off" | "reply" | "thread";
export type DeltaChatReactionLevel = "off" | "ack" | "minimal" | "extensive";

export interface DeltaChatAccountConfig {
  name?: string;
  enabled: boolean;
  configured: boolean;
  dataDir?: string;
  addr?: string;
  mail_pw?: string;
  bot?: string;
  e2ee_enabled?: string;
  chatmailQr?: string;
  dm?: {
    enabled?: boolean;
    policy?: "disabled" | "pairing" | "allowlist" | "open";
    allowFrom?: string[];
  };
  groupPolicy?: "allowlist" | "open";
  groupAllowFrom?: string[];
  /** Group config keyed by numeric chat ID (stable across renames). Use "*" for default/wildcard. */
  groups?: Record<
    string,
    {
      users?: (string | number)[];
      requireMention?: boolean;
      tools?: "allow" | "deny" | { allow?: string[]; deny?: string[] };
      toolsBySender?: Record<string, "allow" | "deny" | { allow?: string[]; deny?: string[] }>;
    }
  >;
  mediaMaxMb?: number;
  replyToMode?: ReplyToMode;
  initialSyncLimit?: number;
  reactionLevel?: DeltaChatReactionLevel;
  actions?: {
    reactions?: boolean;
  };
  ackReaction?: string;
  ackReactionScope?: "off" | "group-mentions" | "group-all" | "direct" | "all";
  livenessReactionsEnabled?: boolean;
  livenessReactionIntervalSeconds?: number;
}

export interface DeltaChatAccountConfigWithAccounts extends DeltaChatAccountConfig {
  accounts?: Record<string, DeltaChatAccountConfig>;
}

export interface DeltaChatProbe {
  ok: boolean;
  error?: string;
  elapsedMs: number;
}

export interface DeltaChatRuntime {
  accountId: string;
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  lastProbeAt?: number | null;
  probe?: DeltaChatProbe;
}

export interface DeltaChatMessage {
  id: number;
  chatId: number;
  fromId: number;
  text?: string;
  timestamp?: number;
  hasLocation?: boolean;
  hasHtml?: boolean;
  isInfo?: boolean;
  isForwarded?: boolean;
  isSystemMessage?: boolean;
  overrideSenderName?: string;
  subject?: string;
  showPadlock?: boolean;
  summary?: string;
  downloadState?: number;
}

export interface DeltaChatChat {
  id: number;
  name: string;
  type: number;
  isProtected: boolean;
  isBroadcast: boolean;
  isMuted: boolean;
  isContactRequest: boolean;
  isDeviceChat: boolean;
  isArchived: boolean;
  isPinned: boolean;
  isSelfTalk: boolean;
  isVerified: boolean;
  lastMessageId?: number;
  timestamp?: number;
  visibility?: number;
}

export interface DeltaChatContact {
  id: number;
  name: string;
  email: string;
  isVerified: boolean;
  isBlocked: boolean;
  isSelf: boolean;
}
