import type { OpenClawConfig } from "../../config/config.js";
import { type SessionEntry } from "../../config/sessions.js";
import { type CommandNormalizeOptions } from "../commands-registry.js";
import type { FinalizedMsgContext } from "../templating.js";
export { resolveAbortCutoffFromContext, shouldSkipMessageByAbortCutoff } from "./abort-cutoff.js";
export declare function isAbortTrigger(text?: string): boolean;
export declare function isAbortRequestText(text?: string, options?: CommandNormalizeOptions): boolean;
export declare function getAbortMemory(key: string): boolean | undefined;
export declare function setAbortMemory(key: string, value: boolean): void;
export declare function getAbortMemorySizeForTest(): number;
export declare function resetAbortMemoryForTest(): void;
export declare function formatAbortReplyText(stoppedSubagents?: number): string;
export declare function resolveSessionEntryForKey(store: Record<string, SessionEntry> | undefined, sessionKey: string | undefined): {
    entry?: undefined;
    key?: undefined;
} | {
    entry: SessionEntry;
    key: string;
};
export declare function stopSubagentsForRequester(params: {
    cfg: OpenClawConfig;
    requesterSessionKey?: string;
}): {
    stopped: number;
};
export declare function tryFastAbortFromMessage(params: {
    ctx: FinalizedMsgContext;
    cfg: OpenClawConfig;
}): Promise<{
    handled: boolean;
    aborted: boolean;
    stoppedSubagents?: number;
}>;
