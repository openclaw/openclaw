import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
type FastModeState = {
    enabled: boolean;
    source: "session" | "agent" | "config" | "default";
};
export declare function resolveFastModeState(params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    model: string;
    agentId?: string;
    sessionEntry?: Pick<SessionEntry, "fastMode"> | undefined;
}): FastModeState;
export {};
