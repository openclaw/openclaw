import { MarkdownConfigSchema, buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { z } from "zod";

/**
 * Per-user routing configuration.
 * Maps SimpleX contacts to specific OpenClaw agents and preferences.
 * This is the KEY feature for personal assistant use cases.
 */
export const SimplexUserRoutingSchema = z.object({
  /** SimpleX display name to match (exact match) */
  contactName: z.string(),

  /** OpenClaw agent to route messages to (e.g., "digimate", "fiancee-assistant") */
  agent: z.string(),

  /** Language for this user (ISO 639-1 code, e.g., "fr", "en") */
  language: z.string().default("fr"),

  /** Model to use for this user (e.g., "claude-sonnet-4-6", "claude-haiku") */
  model: z.string().optional(),

  /** Whether to respond with voice (TTS) for this user */
  voiceReplies: z.boolean().default(true),

  /** System prompt override for this user */
  systemPrompt: z.string().optional(),

  /** Whether to include conversation history for this user */
  includeHistory: z.boolean().default(true),

  /** Maximum history messages to include */
  maxHistoryMessages: z.number().int().min(1).max(50).default(10),

  /** Priority for this route (higher = checked first) */
  priority: z.number().int().min(0).max(100).default(50),
});

export type SimplexUserRouting = z.infer<typeof SimplexUserRoutingSchema>;

/**
 * Group routing configuration.
 * Maps group names/IDs to agent configurations with member filtering.
 */
export const SimplexGroupRoutingSchema = z.object({
  /** Group display name or ID */
  groupName: z.string(),

  /** OpenClaw agent to route messages to */
  agent: z.string(),

  /** Language for this group */
  language: z.string().default("fr"),

  /** Model to use for this group */
  model: z.string().optional(),

  /** Whether to respond with voice */
  voiceReplies: z.boolean().default(false),

  /** System prompt override */
  systemPrompt: z.string().optional(),

  /** Include conversation history */
  includeHistory: z.boolean().default(true),

  /** Max history messages */
  maxHistoryMessages: z.number().int().min(1).max(50).default(10),

  /** Route only specific members to agent (empty = all members) */
  memberFilter: z.array(z.string()).optional(),

  /** Exclude specific members from routing (e.g., Alexandre's own devices) */
  memberExclude: z.array(z.string()).optional(),

  /** Priority for this route */
  priority: z.number().int().min(0).max(100).default(50),
});

export type SimplexGroupRouting = z.infer<typeof SimplexGroupRoutingSchema>;

/**
 * SimpleX Chat channel configuration schema.
 *
 * The plugin connects to a local simplex-chat CLI instance running
 * as a WebSocket server (simplex-chat -p <port> or --ws-url).
 */
export const SimplexConfigSchema = z.object({
  /** Display name for this SimpleX account */
  name: z.string().optional(),

  /** Whether this channel is enabled */
  enabled: z.boolean().optional(),

  /** Markdown formatting overrides (tables). */
  markdown: MarkdownConfigSchema.optional(),

  /**
   * Full WebSocket URL to connect to (overrides host/port if present).
   * Default: ws://127.0.0.1:5225
   */
  wsUrl: z.string().optional(),

  /**
   * WebSocket port for the simplex-chat CLI (used if wsUrl not provided).
   * Default: 5225
   */
  wsPort: z.number().int().min(1).max(65535).optional(),

  /**
   * WebSocket host for the simplex-chat CLI (used if wsUrl not provided).
   * Default: 127.0.0.1 (localhost only — never expose externally)
   */
  wsHost: z.string().optional(),

  /**
   * Whether to auto-accept incoming contact requests (pairing).
   * Default: false (requires manual approval)
   */
  autoAcceptContacts: z.boolean().optional(),

  /**
   * DM policy: who can message this bot.
   * - "open": anyone can DM
   * - "pairing": require pairing approval (default, recommended)
   */
  dmPolicy: z.enum(["open", "pairing"]).optional(),

  /**
   * Allowlist of SimpleX contact IDs that can DM without pairing.
   */
  allowFrom: z.array(z.string()).optional(),

  /**
   * User routing configuration - route specific contacts to specific agents.
   *
   * Example (fiancée use case):
   * [
   *   { contactName: "FormidableVisionary", agent: "fiancee-assistant", language: "fr", voiceReplies: true },
   *   { contactName: "Talleyrand_2010", agent: "digimate", language: "en" },
   *   { contactName: "PleasantTeammate", agent: "digimate", language: "en" }
   * ]
   */
  userRouting: z.array(SimplexUserRoutingSchema).optional(),

  /**
   * Group routing configuration - route group messages to agents.
   * Supports member filtering to route specific members to specific agents.
   *
   * Example:
   * [
   *   {
   *     groupName: "EffuzionNext",
   *     agent: "fiancee-assistant",
   *     language: "fr",
   *     memberExclude: ["Talleyrand_2010", "PleasantTeammate", "Digimate"]  // Alexandre's devices
   *   }
   * ]
   */
  groupRouting: z.array(SimplexGroupRoutingSchema).optional(),

  /**
   * Default agent for unmatched contacts/groups.
   * If not set, unmatched messages are handled by the default OpenClaw pipeline.
   */
  defaultAgent: z.string().optional(),

  /**
   * Default language for responses (when not specified in routing).
   * Default: "en"
   */
  defaultLanguage: z.string().default("en"),

  /**
   * Default model for AI responses.
   */
  defaultModel: z.string().optional(),

  /**
   * Default voice reply setting.
   */
  defaultVoiceReplies: z.boolean().default(false),

  /**
   * Reconnection settings for the WebSocket client.
   */
  reconnection: z
    .object({
      maxRetries: z.number().int().min(0).optional(),
      backoffMs: z.number().int().min(0).optional(),
      backoffFactor: z.number().optional(),
    })
    .optional(),

  /**
   * Message format options: control how incoming/outgoing messages are represented.
   */
  messageOptions: z
    .object({
      allowText: z.boolean().optional(),
      allowFiles: z.boolean().optional(),
      preferM4AForVoice: z.boolean().optional(),
      convertImagesToJpeg: z.boolean().optional(),
    })
    .optional(),

  /**
   * Path to the simplex-chat binary (if not on PATH).
   */
  cliPath: z.string().optional(),

  /**
   * Path to the SimpleX Chat database directory.
   * Default: ~/.simplex
   */
  dbPath: z.string().optional(),

  /**
   * Auto-start the simplex-chat CLI as a child process.
   * If false, you must start simplex-chat -p <port> manually.
   */
  autoStart: z.boolean().optional(),

  /**
   * Member IDs to filter out (skip processing messages from these IDs).
   * Use this to ignore the bot's own messages or other automated accounts.
   * Example: ["1", "3"] - filters out member IDs 1 and 3
   */
  filterMemberIds: z.array(z.string()).optional(),

  /**
   * Display names to filter out (skip processing messages from these senders).
   * Example: ["Alexandre", "MyBot"]
   */
  filterDisplayNames: z.array(z.string()).optional(),

  /**
   * Conversation history storage - keep history per contact/group for context.
   * Default: true (enabled)
   */
  storeHistory: z.boolean().default(true),

  /**
   * Maximum history messages to store per conversation.
   * Default: 50
   */
  maxStoredHistory: z.number().int().min(1).max(500).default(50),
});

export type SimplexConfig = z.infer<typeof SimplexConfigSchema>;

/**
 * JSON Schema for Control UI (converted from Zod)
 */
export const simplexChannelConfigSchema = buildChannelConfigSchema(SimplexConfigSchema);
