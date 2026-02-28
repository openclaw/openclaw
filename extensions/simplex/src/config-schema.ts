import { MarkdownConfigSchema, buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { z } from "zod";

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
   * Group routing configuration. Map group names or IDs to agent names.
   * Example: { "EffuzionNext": "agent:effuzion" }
   */
  groupRouting: z.record(z.string()).optional(),

  /**
   * Reconnection settings for the WebSocket client.
   */
  reconnection: z.object({
    maxRetries: z.number().int().min(0).optional(),
    backoffMs: z.number().int().min(0).optional(),
    backoffFactor: z.number().optional(),
  }).optional(),

  /**
   * Message format options: control how incoming/outgoing messages are represented.
   */
  messageOptions: z.object({
    allowText: z.boolean().optional(),
    allowFiles: z.boolean().optional(),
    preferM4AForVoice: z.boolean().optional(),
    convertImagesToJpeg: z.boolean().optional(),
  }).optional(),

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
});

export type SimplexConfig = z.infer<typeof SimplexConfigSchema>;

/**
 * JSON Schema for Control UI (converted from Zod)
 */
export const simplexChannelConfigSchema = buildChannelConfigSchema(SimplexConfigSchema);
