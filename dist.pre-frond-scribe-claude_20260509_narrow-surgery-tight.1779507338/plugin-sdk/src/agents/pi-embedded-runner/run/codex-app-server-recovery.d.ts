import type { EmbeddedRunAttemptResult } from "./types.js";
export declare function resolveCodexAppServerClientCloseRetry(params: {
    attempt: EmbeddedRunAttemptResult;
    alreadyRetried: boolean;
}): {
    retry: boolean;
    reason?: string;
};
