import { hn as AgentDefaultsConfig, i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
import { o as VerboseLevel, r as ThinkLevel } from "./thinking.shared-D3hXUZEF.js";
import { o as SessionEntry } from "./types-BoPp7-Sf.js";
import { g as EmbeddedPiRunMeta } from "./params-Ca2aO1q_.js";
import { t as ModelCatalogEntry } from "./model-catalog.types-BN5LqwSr.js";
import { n as RuntimeEnv } from "./runtime-D0p4Vp8x.js";
import { t as CliDeps } from "./deps.types-CYr_TOcQ.js";
import { a as OutboundSessionContext } from "./delivery-queue-DNEglQA0.js";
import { s as OutboundPayloadJson } from "./deliver-CilDwjUj.js";
import { n as AcpSessionResolution, t as AcpSessionManager } from "./manager.core-mn7AsLgK.js";
import { n as AgentCommandOpts, r as AgentCommandResultMetaOverrides, t as AgentCommandIngressOpts } from "./types-B1fvR_OF.js";

//#region src/agents/agent-runtime-config.d.ts
declare function resolveAgentRuntimeConfig(runtime: RuntimeEnv, params?: {
  runtimeTargetsChannelSecrets?: boolean;
}): Promise<{
  loadedRaw: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  cfg: OpenClawConfig;
}>;
//#endregion
//#region src/agents/command/attempt-execution.helpers.d.ts
declare function createAcpVisibleTextAccumulator(): {
  consume(chunk: string): {
    text: string;
    delta: string;
  } | null;
  finalize(): string;
  finalizeRaw(): string;
};
//#endregion
//#region src/agents/agent-command.d.ts
declare function prepareAgentCommandExecution(opts: AgentCommandOpts & {
  senderIsOwner: boolean;
}, runtime: RuntimeEnv): Promise<{
  body: string;
  transcriptBody: string;
  cfg: OpenClawConfig;
  configuredThinkingCatalog: ModelCatalogEntry[];
  normalizedSpawned: {
    spawnedBy?: string;
    groupId?: string;
    groupChannel?: string;
    groupSpace?: string;
    workspaceDir?: string;
  };
  agentCfg: AgentDefaultsConfig | undefined;
  thinkOverride: ThinkLevel | undefined;
  thinkOnce: ThinkLevel | undefined;
  verboseOverride: VerboseLevel | undefined;
  timeoutMs: number;
  sessionId: string;
  sessionKey: string | undefined;
  sessionEntry: SessionEntry | undefined;
  sessionStore: Record<string, SessionEntry> | undefined;
  storePath: string;
  isNewSession: boolean;
  persistedThinking: ThinkLevel | undefined;
  persistedVerbose: VerboseLevel | undefined;
  sessionAgentId: string;
  outboundSession: OutboundSessionContext | undefined;
  workspaceDir: string;
  agentDir: string;
  runId: string;
  acpManager: AcpSessionManager;
  acpResolution: AcpSessionResolution | null;
}>;
declare function agentCommand(opts: AgentCommandOpts, runtime?: RuntimeEnv, deps?: CliDeps): Promise<{
  payloads: OutboundPayloadJson[];
  meta: EmbeddedPiRunMeta & AgentCommandResultMetaOverrides;
  deliverySucceeded?: undefined;
} | {
  payloads: OutboundPayloadJson[];
  meta: EmbeddedPiRunMeta & AgentCommandResultMetaOverrides;
  deliverySucceeded: boolean;
}>;
declare function agentCommandFromIngress(opts: AgentCommandIngressOpts, runtime?: RuntimeEnv, deps?: CliDeps): Promise<{
  payloads: OutboundPayloadJson[];
  meta: EmbeddedPiRunMeta & AgentCommandResultMetaOverrides;
  deliverySucceeded?: undefined;
} | {
  payloads: OutboundPayloadJson[];
  meta: EmbeddedPiRunMeta & AgentCommandResultMetaOverrides;
  deliverySucceeded: boolean;
}>;
declare const __testing: {
  resolveAgentRuntimeConfig: typeof resolveAgentRuntimeConfig;
  prepareAgentCommandExecution: typeof prepareAgentCommandExecution;
  createAcpVisibleTextAccumulator: typeof createAcpVisibleTextAccumulator;
};
//#endregion
export { agentCommand as n, agentCommandFromIngress as r, __testing as t };