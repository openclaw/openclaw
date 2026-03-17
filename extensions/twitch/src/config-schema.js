import { MarkdownConfigSchema } from "openclaw/plugin-sdk/twitch";
import { z } from "zod";
const TwitchRoleSchema = z.enum(["moderator", "owner", "vip", "subscriber", "all"]);
const TwitchAccountSchema = z.object({
  /** Twitch username */
  username: z.string(),
  /** Twitch OAuth access token (requires chat:read and chat:write scopes) */
  accessToken: z.string(),
  /** Twitch client ID (from Twitch Developer Portal or twitchtokengenerator.com) */
  clientId: z.string().optional(),
  /** Channel name to join */
  channel: z.string().min(1),
  /** Enable this account */
  enabled: z.boolean().optional(),
  /** Allowlist of Twitch user IDs who can interact with the bot (use IDs for safety, not usernames) */
  allowFrom: z.array(z.string()).optional(),
  /** Roles allowed to interact with the bot (e.g., ["moderator", "vip", "subscriber"]) */
  allowedRoles: z.array(TwitchRoleSchema).optional(),
  /** Require @mention to trigger bot responses */
  requireMention: z.boolean().optional(),
  /** Outbound response prefix override for this channel/account. */
  responsePrefix: z.string().optional(),
  /** Twitch client secret (required for token refresh via RefreshingAuthProvider) */
  clientSecret: z.string().optional(),
  /** Refresh token (required for automatic token refresh) */
  refreshToken: z.string().optional(),
  /** Token expiry time in seconds (optional, for token refresh tracking) */
  expiresIn: z.number().nullable().optional(),
  /** Timestamp when token was obtained (optional, for token refresh tracking) */
  obtainmentTimestamp: z.number().optional()
});
const TwitchConfigBaseSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema.optional()
});
const SimplifiedSchema = z.intersection(TwitchConfigBaseSchema, TwitchAccountSchema);
const MultiAccountSchema = z.intersection(
  TwitchConfigBaseSchema,
  z.object({
    /** Per-account configuration (for multi-account setups) */
    accounts: z.record(z.string(), TwitchAccountSchema)
  }).refine((val) => Object.keys(val.accounts || {}).length > 0, {
    message: "accounts must contain at least one entry"
  })
);
const TwitchConfigSchema = z.union([SimplifiedSchema, MultiAccountSchema]);
export {
  TwitchConfigSchema
};
