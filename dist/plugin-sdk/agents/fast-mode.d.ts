import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
export type FastModeState = {
    enabled: boolean;
    source: "session" | "config" | "default";
};
export declare function resolveFastModeParam(extraParams: Record<string, unknown> | undefined): boolean | undefined;
export declare function resolveConfiguredFastMode(params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    model: string;
}): boolean;
export declare function resolveFastModeState(params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    model: string;
    sessionEntry?: Pick<SessionEntry, "fastMode"> | undefined;
}): FastModeState;
