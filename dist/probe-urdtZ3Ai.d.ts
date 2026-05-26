import { t as BaseProbeResult } from "./types.core-BkmTlRzr.js";
//#region extensions/discord/src/probe.d.ts
type DiscordProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  bot?: {
    id?: string | null;
    username?: string | null;
  };
  application?: DiscordApplicationSummary;
};
type DiscordPrivilegedIntentStatus = "enabled" | "limited" | "disabled";
type DiscordPrivilegedIntentsSummary = {
  messageContent: DiscordPrivilegedIntentStatus;
  guildMembers: DiscordPrivilegedIntentStatus;
  presence: DiscordPrivilegedIntentStatus;
};
type DiscordApplicationSummary = {
  id?: string | null;
  flags?: number | null;
  intents?: DiscordPrivilegedIntentsSummary;
};
declare function resolveDiscordPrivilegedIntentsFromFlags(flags: number): DiscordPrivilegedIntentsSummary;
declare function fetchDiscordApplicationSummary(token: string, timeoutMs: number, fetcher?: typeof fetch): Promise<DiscordApplicationSummary | undefined>;
declare function probeDiscord(token: string, timeoutMs: number, opts?: {
  fetcher?: typeof fetch;
  includeApplication?: boolean;
}): Promise<DiscordProbe>;
/**
 * Extract the application (bot user) ID from a Discord bot token by
 * base64-decoding the first segment.  Discord tokens have the format:
 *   base64(user_id) . timestamp . hmac
 * The decoded first segment is the numeric snowflake ID as a plain string,
 * so we keep it as a string to avoid precision loss for IDs that exceed
 * Number.MAX_SAFE_INTEGER.
 */
declare function parseApplicationIdFromToken(token: string): string | undefined;
declare function fetchDiscordApplicationId(token: string, timeoutMs: number, fetcher?: typeof fetch): Promise<string | undefined>;
//#endregion
export { fetchDiscordApplicationId as a, probeDiscord as c, DiscordProbe as i, resolveDiscordPrivilegedIntentsFromFlags as l, DiscordPrivilegedIntentStatus as n, fetchDiscordApplicationSummary as o, DiscordPrivilegedIntentsSummary as r, parseApplicationIdFromToken as s, DiscordApplicationSummary as t };