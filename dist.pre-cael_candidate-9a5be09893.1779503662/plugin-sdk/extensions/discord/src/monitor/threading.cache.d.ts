import type { DiscordThreadStarter } from "./threading.types.js";
export declare function resetDiscordThreadStarterCacheForTest(): void;
export declare function getCachedThreadStarter(key: string, now: number): DiscordThreadStarter | undefined;
export declare function setCachedThreadStarter(key: string, value: DiscordThreadStarter, now: number): void;
