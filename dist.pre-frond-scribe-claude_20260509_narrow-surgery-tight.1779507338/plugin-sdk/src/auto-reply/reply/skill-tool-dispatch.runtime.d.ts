import type { AnyAgentTool } from "../../agents/pi-tools.types.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext } from "../templating.js";
/**
 * Policy-enforcement seam for skill `command-dispatch: tool` invocations.
 * Keep this aligned with the normal tool surfaces so GHSA-mhm4-93fw-4qr2
 * stays closed across allow/deny, group, sandbox, and subagent policy layers.
 */
export declare function resolveSkillDispatchTools(params: {
    ctx: MsgContext;
    cfg: OpenClawConfig;
    agentId: string;
    agentDir?: string;
    sessionEntry?: SessionEntry;
    sessionKey: string;
    workspaceDir: string;
    provider: string;
    model: string;
    senderId?: string;
    currentChannelId?: string;
}): AnyAgentTool[];
