import type { GatewayPresenceUpdate } from "discord-api-types/v10";
/** Update cached presence for a user. */
export declare function setPresence(accountId: string | undefined, userId: string, data: GatewayPresenceUpdate): void;
/** Get cached presence for a user. Returns undefined if not cached. */
export declare function getPresence(accountId: string | undefined, userId: string): GatewayPresenceUpdate | undefined;
/** Clear cached presence data. */
export declare function clearPresences(accountId?: string): void;
/** Get the number of cached presence entries. */
export declare function presenceCacheSize(): number;
