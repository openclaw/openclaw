import type { BaseProbeResult } from "../channels/plugins/types.js";
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
export declare function fetchDiscordApplicationId(token: string, timeoutMs: number, fetcher?: typeof fetch): Promise<string | undefined>;
