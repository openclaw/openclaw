import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
export declare function resolveModelAuthLabel(params: {
    provider?: string;
    cfg?: OpenClawConfig;
    sessionEntry?: SessionEntry;
    agentDir?: string;
}): string | undefined;
