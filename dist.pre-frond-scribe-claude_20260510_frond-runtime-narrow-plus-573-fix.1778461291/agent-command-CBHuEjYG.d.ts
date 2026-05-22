import { hn as AgentDefaultsConfig, i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";
import { o as VerboseLevel, r as ThinkLevel } from "./thinking.shared-BCHeA96t.js";
import { o as SessionEntry } from "./types-Choy2DhC.js";
import { g as EmbeddedPiRunMeta } from "./params-DQpvmtuc.js";
import { t as ModelCatalogEntry } from "./model-catalog.types-Bot7BBmo.js";
import { n as RuntimeEnv } from "./runtime-lEKWbTQa.js";
import { t as CliDeps } from "./deps.types-CEMUOfSm.js";
import { a as OutboundSessionContext } from "./delivery-queue-C0vfXQT1.js";
import { s as OutboundPayloadJson } from "./deliver-cQqrRkeK.js";
import { n as AcpSessionResolution, t as AcpSessionManager } from "./manager.core-D0rggkqX.js";
import { n as AgentCommandOpts, r as AgentCommandResultMetaOverrides, t as AgentCommandIngressOpts } from "./types-CjwA5wEi.js";

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