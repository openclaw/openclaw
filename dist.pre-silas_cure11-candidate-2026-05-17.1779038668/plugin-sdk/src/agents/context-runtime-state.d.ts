import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type LazyPromiseLoader } from "../shared/lazy-promise.js";
type ContextWindowRuntimeState = {
    loadPromise: Promise<void> | null;
    configuredConfig: OpenClawConfig | undefined;
    configLoadFailures: number;
    nextConfigLoadAttemptAtMs: number;
    modelsConfigRuntimeLoader: LazyPromiseLoader<typeof import("./models-config.runtime.js")>;
};
export declare const CONTEXT_WINDOW_RUNTIME_STATE: ContextWindowRuntimeState;
export declare function resetContextWindowCacheForTest(): void;
export {};
