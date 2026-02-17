import { Type, type Static } from "@sinclair/typebox";

/**
 * SimpleX Chat channel configuration schema.
 *
 * The plugin connects to a local simplex-chat CLI instance running
 * as a WebSocket server (simplex-chat -p <port>).
 */
export const SimplexConfigSchema = Type.Object({
  /** Display name for this SimpleX account */
  name: Type.Optional(Type.String({ default: "SimpleX" })),

  /** Whether this channel is enabled */
  enabled: Type.Optional(Type.Boolean({ default: true })),

  /**
   * WebSocket port for the simplex-chat CLI.
   * Start the CLI with: simplex-chat -p <port>
   * Default: 5225
   */
  wsPort: Type.Optional(Type.Number({ default: 5225, minimum: 1, maximum: 65535 })),

  /**
   * WebSocket host for the simplex-chat CLI.
   * Default: 127.0.0.1 (localhost only — never expose externally)
   */
  wsHost: Type.Optional(Type.String({ default: "127.0.0.1" })),

  /**
   * DM policy: who can message this bot.
   * - "open": anyone can DM
   * - "pairing": require pairing approval (default, recommended)
   */
  dmPolicy: Type.Optional(
    Type.Union([Type.Literal("open"), Type.Literal("pairing")], { default: "pairing" }),
  ),

  /**
   * Allowlist of SimpleX contact IDs that can DM without pairing.
   */
  allowFrom: Type.Optional(Type.Array(Type.String())),

  /**
   * Path to the simplex-chat binary (if not on PATH).
   */
  cliPath: Type.Optional(Type.String()),

  /**
   * Path to the SimpleX Chat database directory.
   * Default: ~/.simplex
   */
  dbPath: Type.Optional(Type.String()),

  /**
   * Auto-start the simplex-chat CLI as a child process.
   * If false, you must start simplex-chat -p <port> manually.
   */
  autoStart: Type.Optional(Type.Boolean({ default: false })),
});

export type SimplexConfig = Static<typeof SimplexConfigSchema>;
