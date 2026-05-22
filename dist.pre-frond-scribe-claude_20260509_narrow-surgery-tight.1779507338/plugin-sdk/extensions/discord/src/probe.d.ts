import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
export type DiscordProbe = BaseProbeResult & {
    status?: number | null;
    elapsedMs: number;
    bot?: {
        id?: string | null;
        username?: string | null;
    };
    application?: DiscordApplicationSummary;
};
export type DiscordPrivilegedIntentStatus = "enabled" | "limited" | "disabled";
export type DiscordPrivilegedIntentsSummary = {
    messageContent: DiscordPrivilegedIntentStatus;
    guildMembers: DiscordPrivilegedIntentStatus;
    presence: DiscordPrivilegedIntentStatus;
};
export type DiscordApplicationSummary = {
    id?: string | null;
    flags?: number | null;
    intents?: DiscordPrivilegedIntentsSummary;
};
export declare function resolveDiscordPrivilegedIntentsFromFlags(flags: number): DiscordPrivilegedIntentsSummary;
export declare function fetchDiscordApplicationSummary(token: string, timeoutMs: number, fetcher?: typeof fetch): Promise<DiscordApplicationSummary | undefined>;
export declare function probeDiscord(token: string, timeoutMs: number, opts?: {
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
export declare function parseApplicationIdFromToken(token: string): string | undefined;
export declare function fetchDiscordApplicationId(token: string, timeoutMs: number, fetcher?: typeof fetch): Promise<string | undefined>;
