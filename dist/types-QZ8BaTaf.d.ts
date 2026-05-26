//#region extensions/twitch/src/types.d.ts
/**
 * Twitch user roles that can be allowed to interact with the bot
 */
type TwitchRole = "moderator" | "owner" | "vip" | "subscriber" | "all";
/**
 * Account configuration for a Twitch channel
 */
interface TwitchAccountConfig {
  /** Twitch username */
  username: string;
  /** Twitch OAuth access token (requires chat:read and chat:write scopes) */
  accessToken: string;
  /** Twitch client ID (from Twitch Developer Portal or twitchtokengenerator.com) */
  clientId: string;
  /** Channel name to join (required) */
  channel: string;
  /** Enable this account */
  enabled?: boolean;
  /** Allowlist of Twitch user IDs who can interact with the bot (use IDs for safety, not usernames) */
  allowFrom?: Array<string>;
  /** Roles allowed to interact with the bot (e.g., ["mod", "vip", "sub"]) */
  allowedRoles?: TwitchRole[];
  /** Require @mention to trigger bot responses */
  requireMention?: boolean;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  /** Twitch client secret (required for token refresh via RefreshingAuthProvider) */
  clientSecret?: string;
  /** Refresh token (required for automatic token refresh) */
  refreshToken?: string;
  /** Token expiry time in seconds (optional, for token refresh tracking) */
  expiresIn?: number | null;
  /** Timestamp when token was obtained (optional, for token refresh tracking) */
  obtainmentTimestamp?: number;
}
//#endregion
export { TwitchAccountConfig as t };