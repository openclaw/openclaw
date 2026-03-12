import { type VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { scheduleFollowupDrain } from "./queue.js";
import type { TypingSignaler } from "./typing-mode.js";
export declare const isAudioPayload: (payload: ReplyPayload) => boolean;
type VerboseGateParams = {
    sessionKey?: string;
    storePath?: string;
    resolvedVerboseLevel: VerboseLevel;
};
export declare const createShouldEmitToolResult: (params: VerboseGateParams) => (() => boolean);
export declare const createShouldEmitToolOutput: (params: VerboseGateParams) => (() => boolean);
export declare const finalizeWithFollowup: <T>(value: T, queueKey: string, runFollowupTurn: Parameters<typeof scheduleFollowupDrain>[1]) => T;
export declare const signalTypingIfNeeded: (payloads: ReplyPayload[], typingSignals: TypingSignaler) => Promise<void>;
export {};
