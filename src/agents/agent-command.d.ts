import { type VerboseLevel } from "../auto-reply/thinking.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { type RuntimeEnv } from "../runtime.js";
import { resolveAgentRuntimeConfig } from "./agent-runtime-config.js";
import type { AgentCommandIngressOpts, AgentCommandOpts } from "./command/types.js";
declare function prepareAgentCommandExecution(opts: AgentCommandOpts & {
    senderIsOwner: boolean;
}, runtime: RuntimeEnv): Promise<{
    body: string;
    transcriptBody: string;
    cfg: import("../config/types.openclaw.js").OpenClawConfig;
    normalizedSpawned: import("./spawned-context.js").NormalizedSpawnedRunMetadata;
    agentCfg: import("../config/types.agent-defaults.js").AgentDefaultsConfig | undefined;
    thinkOverride: import("../auto-reply/thinking.shared.js").ThinkLevel | undefined;
    thinkOnce: import("../auto-reply/thinking.shared.js").ThinkLevel | undefined;
    verboseOverride: VerboseLevel | undefined;
    timeoutMs: number;
    sessionId: string;
    sessionKey: string | undefined;
    sessionEntry: SessionEntry | undefined;
    sessionStore: Record<string, SessionEntry> | undefined;
    storePath: string;
    isNewSession: boolean;
    persistedThinking: import("../auto-reply/thinking.shared.js").ThinkLevel | undefined;
    persistedVerbose: VerboseLevel | undefined;
    sessionAgentId: string;
    outboundSession: import("../infra/outbound/session-context.js").OutboundSessionContext | undefined;
    workspaceDir: string;
    agentDir: string;
    runId: string;
    acpManager: import("../acp/control-plane/manager.core.js").AcpSessionManager;
    acpResolution: import("../acp/control-plane/manager.types.js").AcpSessionResolution | null;
}>;
export declare function agentCommand(opts: AgentCommandOpts, runtime?: RuntimeEnv, deps?: CliDeps): Promise<{
    payloads: import("../infra/outbound/payloads.js").OutboundPayloadJson[];
    meta: import("./pi-embedded-runner.js").EmbeddedAgentRunMeta;
}>;
export declare function agentCommandFromIngress(opts: AgentCommandIngressOpts, runtime?: RuntimeEnv, deps?: CliDeps): Promise<{
    payloads: import("../infra/outbound/payloads.js").OutboundPayloadJson[];
    meta: import("./pi-embedded-runner.js").EmbeddedAgentRunMeta;
}>;
export declare const __testing: {
    resolveAgentRuntimeConfig: typeof resolveAgentRuntimeConfig;
    prepareAgentCommandExecution: typeof prepareAgentCommandExecution;
};
export {};
