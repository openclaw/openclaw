import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { type CliDeps } from "../../cli/outbound-send-deps.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundSessionContext } from "../../infra/outbound/session-context.js";
import { type RuntimeEnv } from "../../runtime.js";
import type { EmbeddedPiRunMeta } from "../pi-embedded-runner/types.js";
import type { AgentCommandOpts, AgentCommandResultMetaOverrides } from "./types.js";
type RunResult = Awaited<ReturnType<(typeof import("../pi-embedded.js"))["runEmbeddedPiAgent"]>>;
export declare function normalizeAgentCommandReplyPayloads(params: {
    cfg: OpenClawConfig;
    opts: AgentCommandOpts;
    outboundSession: OutboundSessionContext | undefined;
    payloads: RunResult["payloads"];
    result: RunResult;
    deliveryChannel?: string;
    accountId?: string;
    applyChannelTransforms?: boolean;
}): ReplyPayload[];
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
    meta: EmbeddedPiRunMeta & AgentCommandResultMetaOverrides;
}>;
export {};
