import { type CliDeps } from "../cli/deps.js";
import { type RuntimeEnv } from "../runtime.js";
import type { AgentCommandIngressOpts, AgentCommandOpts } from "./agent/types.js";
export declare function agentCommand(opts: AgentCommandOpts, runtime?: RuntimeEnv, deps?: CliDeps): Promise<{
    payloads: import("../infra/outbound/payloads.ts").OutboundPayloadJson[];
    meta: import("../agents/pi-embedded.js").EmbeddedPiRunMeta;
}>;
export declare function agentCommandFromIngress(opts: AgentCommandIngressOpts, runtime?: RuntimeEnv, deps?: CliDeps): Promise<{
    payloads: import("../infra/outbound/payloads.ts").OutboundPayloadJson[];
    meta: import("../agents/pi-embedded.js").EmbeddedPiRunMeta;
}>;
