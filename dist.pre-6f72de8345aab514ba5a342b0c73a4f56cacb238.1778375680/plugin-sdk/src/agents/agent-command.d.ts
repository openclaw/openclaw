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
    cfg: import("openclaw/plugin-sdk").OpenClawConfig;
    configuredThinkingCatalog: import("./model-catalog.types.ts").ModelCatalogEntry[];
    normalizedSpawned: {
        spawnedBy?: string;
        groupId?: string;
        groupChannel?: string;
        groupSpace?: string;
        workspaceDir?: string;
    };
    agentCfg: import("openclaw/plugin-sdk/config-types").AgentDefaultsConfig | undefined;
    thinkOverride: import("../auto-reply/thinking.shared.ts").ThinkLevel | undefined;
    thinkOnce: import("../auto-reply/thinking.shared.ts").ThinkLevel | undefined;
    verboseOverride: VerboseLevel | undefined;
    timeoutMs: number;
    sessionId: string;
    sessionKey: string | undefined;
    sessionEntry: SessionEntry | undefined;
    sessionStore: Record<string, SessionEntry> | undefined;
    storePath: string;
    isNewSession: boolean;
    persistedThinking: import("../auto-reply/thinking.shared.ts").ThinkLevel | undefined;
    persistedVerbose: VerboseLevel | undefined;
    sessionAgentId: string;
    outboundSession: import("../infra/outbound/session-context.js").OutboundSessionContext | undefined;
    workspaceDir: string;
    agentDir: string;
    runId: string;
    acpManager: import("../acp/control-plane/manager.core.ts").AcpSessionManager;
    acpResolution: import("../acp/control-plane/manager.types.ts").AcpSessionResolution | null;
}>;
export declare function agentCommand(opts: AgentCommandOpts, runtime?: RuntimeEnv, deps?: CliDeps): Promise<{
    payloads: import("../infra/outbound/payloads.ts").OutboundPayloadJson[];
    meta: import("./pi-embedded.ts").EmbeddedPiRunMeta & import("./command/types.js").AgentCommandResultMetaOverrides;
    deliverySucceeded?: undefined;
} | {
    payloads: import("../infra/outbound/payloads.ts").OutboundPayloadJson[];
    meta: import("./pi-embedded.ts").EmbeddedPiRunMeta & import("./command/types.js").AgentCommandResultMetaOverrides;
    deliverySucceeded: boolean;
}>;
export declare function agentCommandFromIngress(opts: AgentCommandIngressOpts, runtime?: RuntimeEnv, deps?: CliDeps): Promise<{
    payloads: import("../infra/outbound/payloads.ts").OutboundPayloadJson[];
    meta: import("./pi-embedded.ts").EmbeddedPiRunMeta & import("./command/types.js").AgentCommandResultMetaOverrides;
    deliverySucceeded?: undefined;
} | {
    payloads: import("../infra/outbound/payloads.ts").OutboundPayloadJson[];
    meta: import("./pi-embedded.ts").EmbeddedPiRunMeta & import("./command/types.js").AgentCommandResultMetaOverrides;
    deliverySucceeded: boolean;
}>;
export declare const __testing: {
    resolveAgentRuntimeConfig: typeof resolveAgentRuntimeConfig;
    prepareAgentCommandExecution: typeof prepareAgentCommandExecution;
};
export {};
