import { MarkdownConfigSchema, buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { z } from "zod";

/**
 * SimpleX Chat channel configuration schema.
 *
 * The plugin connects to a local simplex-chat CLI instance running
 * as a WebSocket server (simplex-chat -p <port>).
 */
export const SimplexConfigSchema = z.object({
  /** Display name for this SimpleX account */
  name: z.string().optional(),

  /** Whether this channel is enabled */
  enabled: z.boolean().optional(),

  /** Markdown formatting overrides (tables). */
  markdown: MarkdownConfigSchema,

  /**
   * WebSocket port for the simplex-chat CLI.
   * Start the CLI with: simplex-chat -p <port>
   * Default: 5225
   */
  wsPort: z.number().int().min(1).max(65535).optional(),

  /**
   * WebSocket host for the simplex-chat CLI.
   * Default: 127.0.0.1 (localhost only — never expose externally)
   */
  wsHost: z.string().optional(),

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
