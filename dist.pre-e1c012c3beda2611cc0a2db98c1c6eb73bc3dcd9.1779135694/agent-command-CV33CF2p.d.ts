import { Sn as AgentDefaultsConfig, i as OpenClawConfig } from "./types.openclaw-BYfkTL_f.js";
import { t as PluginManifestRecord } from "./manifest-registry-CkpojMOJ.js";
import { o as VerboseLevel, r as ThinkLevel } from "./thinking.shared-CciWWnKI.js";
import { o as SessionEntry } from "./types-BQPM9qpo.js";
import { g as EmbeddedPiRunMeta } from "./params-5qNeDXlV.js";
import { t as ModelCatalogEntry } from "./model-catalog.types-CSoOJPur.js";
import { n as RuntimeEnv } from "./runtime-BGFXd35m.js";
import { t as CliDeps } from "./deps.types-CYr_TOcQ.js";
import { a as OutboundSessionContext } from "./delivery-queue-BKo7G7KM.js";
import { l as projectOutboundPayloadPlanForJson } from "./deliver-CzdzWGYy.js";
import { s as AcpSessionResolution, t as AcpSessionManager } from "./manager.core-BqdaqVxy.js";
import { n as AgentCommandOpts, r as AgentCommandResultMetaOverrides, t as AgentCommandIngressOpts } from "./types-C6JhTA4C.js";

//#region src/agents/command/delivery.d.ts
type AgentCommandDeliveryPayloadStatus = "sent" | "suppressed" | "failed";
type AgentCommandDeliveryPayloadOutcome = {
  index: number;
  status: AgentCommandDeliveryPayloadStatus;
  reason?: string;
  resultCount?: number;
  sentBeforeError?: boolean;
  stage?: string;
  error?: string;
  hookEffect?: {
    cancelReason?: string;
    metadata?: Record<string, unknown>;
  };
};
type AgentCommandDeliveryStatus = {
  requested: true;
  attempted: boolean;
  status: "sent" | "suppressed" | "partial_failed" | "failed"; /** `partial` means at least one payload was sent before a later payload failed. */
  succeeded: true | false | "partial";
  error?: true;
  errorMessage?: string; /** Free-form lowercase_snake reason from durable delivery or preflight validation. */
  reason?: string;
  resultCount?: number;
  sentBeforeError?: true;
  payloadOutcomes?: AgentCommandDeliveryPayloadOutcome[];
};
type AgentCommandDeliveryResult = {
  payloads: ReturnType<typeof projectOutboundPayloadPlanForJson>;
  meta: EmbeddedPiRunMeta & AgentCommandResultMetaOverrides;
  deliverySucceeded?: boolean;
  deliveryStatus?: AgentCommandDeliveryStatus;
};
//#endregion
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
  modelManifestContext: {
    manifestPlugins: readonly PluginManifestRecord[];
  };
  runId: string;
  acpManager: AcpSessionManager;
  acpResolution: AcpSessionResolution | null;
}>;
declare function agentCommand(opts: AgentCommandOpts, runtime?: RuntimeEnv, deps?: CliDeps): Promise<AgentCommandDeliveryResult>;
declare function agentCommandFromIngress(opts: AgentCommandIngressOpts, runtime?: RuntimeEnv, deps?: CliDeps): Promise<AgentCommandDeliveryResult>;
declare const testing: {
  resolveAgentRuntimeConfig: typeof resolveAgentRuntimeConfig;
  prepareAgentCommandExecution: typeof prepareAgentCommandExecution;
  createAcpVisibleTextAccumulator: typeof createAcpVisibleTextAccumulator;
};
//#endregion
export { agentCommandFromIngress as n, testing as r, agentCommand as t };