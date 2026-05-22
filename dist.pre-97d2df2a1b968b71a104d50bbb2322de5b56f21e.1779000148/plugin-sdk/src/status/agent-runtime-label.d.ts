import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function resolveAgentRuntimeLabel(args: {
    config?: OpenClawConfig;
    sessionEntry?: Pick<SessionEntry, "acp" | "agentRuntimeOverride" | "agentHarnessId" | "modelProvider" | "providerOverride">;
    resolvedHarness?: string;
    fallbackProvider?: string;
}): string;
