import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function buildActiveSubagentSystemPromptAddition(params: {
    cfg: OpenClawConfig;
    controllerSessionKey?: string;
    hasSessionsYield?: boolean;
    recentMinutes?: number;
}): string | undefined;
