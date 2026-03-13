import type { OpenClawConfig } from "../../config/config.js";
import { type SessionEntry } from "../../config/sessions.js";
type RunResult = Awaited<ReturnType<(typeof import("../../agents/pi-embedded.js"))["runEmbeddedPiAgent"]>>;
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
export {};
