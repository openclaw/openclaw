import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";
export declare function registerDiscordComponentEntries(params: {
    entries: DiscordComponentEntry[];
    modals: DiscordModalEntry[];
    ttlMs?: number;
    messageId?: string;
}): void;
export declare function resolveDiscordComponentEntry(params: {
    id: string;
    consume?: boolean;
}): DiscordComponentEntry | null;
export declare function resolveDiscordModalEntry(params: {
    id: string;
    consume?: boolean;
}): DiscordModalEntry | null;
export declare function clearDiscordComponentEntries(): void;
