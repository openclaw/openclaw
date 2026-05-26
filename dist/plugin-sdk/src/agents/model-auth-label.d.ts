import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function resolveModelAuthLabel(params: {
    provider?: string;
    cfg?: OpenClawConfig;
    sessionEntry?: Partial<Pick<SessionEntry, "authProfileOverride">>;
    agentDir?: string;
    workspaceDir?: string;
    includeExternalProfiles?: boolean;
}): string | undefined;
