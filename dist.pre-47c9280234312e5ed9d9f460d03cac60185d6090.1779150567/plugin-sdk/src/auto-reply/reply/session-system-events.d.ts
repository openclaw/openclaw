import type { OpenClawConfig } from "../../config/types.openclaw.js";
export type FormattedSystemEventBlock = {
    text: string;
    forceSenderIsOwnerFalse: boolean;
};
/** Drain queued system events, format as `System:` lines, return the block with authority metadata. */
export declare function drainFormattedSystemEventBlock(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    isMainSession: boolean;
    isNewSession: boolean;
}): Promise<FormattedSystemEventBlock | undefined>;
/** Drain queued system events, format as `System:` lines, return the block text (or undefined). */
export declare function drainFormattedSystemEvents(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    isMainSession: boolean;
    isNewSession: boolean;
}): Promise<string | undefined>;
