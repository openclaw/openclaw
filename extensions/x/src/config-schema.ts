import { z } from "zod";

/**
 * X account configuration schema
 */
const XAccountSchema = z.object({
  /** Twitter/X Consumer Key (API Key) */
  consumerKey: z.string().min(1),
  /** Twitter/X Consumer Secret (API Secret) */
  consumerSecret: z.string().min(1),
  /** Twitter/X Access Token */
  accessToken: z.string().min(1),
  /** Twitter/X Access Token Secret */
  accessTokenSecret: z.string().min(1),
  /** Enable this account */
  enabled: z.boolean().optional(),
  /** Polling interval in seconds (default: 60, min: 15) */
  pollIntervalSeconds: z.number().min(15).optional(),
  /**
   * Allowlist of X user IDs who can mention the bot (mention → reply). When set, only these users can trigger.
   * Server config only; cannot be changed via conversation.
   */
  allowFrom: z.array(z.string()).optional(),
  /**
   * Allowlist of X user IDs who can trigger proactive X actions (follow, like, reply, dm).
   * Do not reuse allowFrom: this is for auto-operations. When request is from X, the mentioner must be in this list.
   * Server config only.
   */
  actionsAllowFrom: z.array(z.string()).optional(),
  /** Account display name */
  name: z.string().optional(),
  /** HTTP proxy URL for API requests (e.g., http://127.0.0.1:7890) */
  proxy: z.string().optional(),
});

/**
 * Base configuration properties shared by both single and multi-account modes
 */
const XConfigBaseSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
});

/**
 * Simplified single-account configuration schema
 *
 * Use this for single-account setups. Properties are at the top level,
 * creating an implicit "default" account.
 */
const SimplifiedSchema = z.intersection(XConfigBaseSchema, XAccountSchema);

/**
 * Multi-account configuration schema
 *
 * Use this for multi-account setups. Each key is an account ID.
 */
const MultiAccountSchema = z.intersection(
  XConfigBaseSchema,
  z
    .object({
      /** Per-account configuration (for multi-account setups) */
      accounts: z.record(z.string(), XAccountSchema),
    })
    .refine((val) => Object.keys(val.accounts || {}).length > 0, {
      message: "accounts must contain at least one entry",
    }),
);

/**
 * X plugin configuration schema
 *
 * Supports two mutually exclusive patterns:
 * 1. Simplified single-account: credentials at top level
 * 2. Multi-account: accounts object with named account configs
 */
export const XConfigSchema = z.union([SimplifiedSchema, MultiAccountSchema]);

export type XConfig = z.infer<typeof XConfigSchema>;
