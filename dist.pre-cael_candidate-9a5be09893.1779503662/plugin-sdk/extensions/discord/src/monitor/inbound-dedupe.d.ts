import { type ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import type { DiscordMessageEvent } from "./listeners.js";
export declare function createDiscordInboundReplayGuard(): ClaimableDedupe;
export declare class DiscordRetryableInboundError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export declare function buildDiscordInboundReplayKey(params: {
    accountId: string;
    data: DiscordMessageEvent;
}): string | null;
export declare function claimDiscordInboundReplay(params: {
    replayKey?: string | null;
    replayGuard: ClaimableDedupe;
}): Promise<boolean>;
export declare function commitDiscordInboundReplay(params: {
    replayKeys?: readonly (string | null | undefined)[];
    replayGuard: ClaimableDedupe;
}): Promise<void>;
export declare function releaseDiscordInboundReplay(params: {
    replayKeys?: readonly (string | null | undefined)[];
    replayGuard: ClaimableDedupe;
    error?: unknown;
}): void;
