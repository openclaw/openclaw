import type { WebClient } from "@slack/web-api";
export declare function normalizeSlackId(value: unknown): string | undefined;
export declare function extractSlackSubteamMentionIds(text?: string | null): string[];
export declare function isSlackSubteamMentionForBot(params: {
    client: WebClient;
    text?: string | null;
    botUserId?: string | null;
    teamId?: string;
    now?: number;
    log?: (message: string) => void;
}): Promise<boolean>;
export declare function clearSlackSubteamMentionCacheForTest(): void;
