import { MarkdownConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

export const TwitchRoleSchema = z.enum(["moderator", "owner", "vip", "subscriber", "all"]);

const TwitchAccountShape = {
  username: z.string(),
  /** Twitch OAuth access token (requires chat:read and chat:write scopes) */
  accessToken: z.string(),
  /** Twitch client ID (from Twitch Developer Portal or twitchtokengenerator.com) */
  clientId: z.string().optional(),
  channel: z.string().min(1),
  enabled: z.boolean().optional(),
  /** Allow channel-initiated configuration writes */
  configWrites: z.boolean().optional(),
  /** Allowlist of Twitch user IDs who can interact with the bot (use IDs for safety, not usernames) */
  allowFrom: z.array(z.string()).optional(),
  allowedRoles: z.array(TwitchRoleSchema).optional(),
  /** Require @mention to trigger bot responses */
  requireMention: z.boolean().optional(),
  responsePrefix: z.string().optional(),
  /** Twitch client secret (required for token refresh via RefreshingAuthProvider) */
  clientSecret: z.string().optional(),
  /** Refresh token (required for automatic token refresh) */
  refreshToken: z.string().optional(),
  /** Token expiry time in seconds (optional, for token refresh tracking) */
  expiresIn: z.number().nullable().optional(),
  /** Timestamp when token was obtained (optional, for token refresh tracking) */
  obtainmentTimestamp: z.number().optional(),
};

export const TwitchAccountSchema = z.object(TwitchAccountShape);

const TwitchConfigBaseShape = {
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  configWrites: z.boolean().optional(),
  markdown: MarkdownConfigSchema.optional(),
  defaultAccount: z.string().optional(),
  // Both union branches are closed, so a root override declared only on the
  // account shape is rejected whenever accounts is present.
  historyLimit: z.number().int().min(0).optional(),
  responsePrefix: z.string().optional(),
};

// Top-level credentials create the implicit default account.
const SimplifiedSchema = z.object({
  ...TwitchConfigBaseShape,
  ...TwitchAccountShape,
});

const MultiAccountSchema = z
  .object({
    ...TwitchConfigBaseShape,
    accounts: z.record(z.string(), TwitchAccountSchema),
  })
  .refine((val) => Object.keys(val.accounts).length > 0, {
    message: "accounts must contain at least one entry",
  });

// Top-level credentials and named accounts remain separate config shapes.
export const TwitchConfigSchema = z.union([SimplifiedSchema, MultiAccountSchema]);
