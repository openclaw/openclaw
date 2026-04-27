import { type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
type RunResult = Awaited<ReturnType<(typeof import("../pi-embedded.js"))["runEmbeddedPiAgent"]>>;
export declare function updateSessionStoreAfterAgentRun(params: {
    cfg: OpenClawConfig;
    contextTokensOverride?: number;
    sessionId: string;
    sessionKey: string;
    storePath: string;
    sessionStore: Record<string, SessionEntry>;
    defaultProvider: string;
    defaultModel: string;
    fallbackProvider?: string;
    fallbackModel?: string;
    result: RunResult;
}): Promise<void>;
export declare function clearCliSessionInStore(params: {
    provider: string;
    sessionKey: string;
    sessionStore: Record<string, SessionEntry>;
    storePath: string;
}): Promise<SessionEntry | undefined>;
export {};
