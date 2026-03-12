import { type CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OutboundSessionContext } from "../../infra/outbound/session-context.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { AgentCommandOpts } from "./types.js";
type RunResult = Awaited<ReturnType<(typeof import("../../agents/pi-embedded.js"))["runEmbeddedPiAgent"]>>;
export declare function deliverAgentCommandResult(params: {
    cfg: OpenClawConfig;
    deps: CliDeps;
    runtime: RuntimeEnv;
    opts: AgentCommandOpts;
    outboundSession: OutboundSessionContext | undefined;
    sessionEntry: SessionEntry | undefined;
    result: RunResult;
    payloads: RunResult["payloads"];
}): Promise<{
    payloads: import("../../infra/outbound/payloads.js").OutboundPayloadJson[];
    meta: import("../../agents/pi-embedded.js").EmbeddedPiRunMeta;
}>;
export {};
