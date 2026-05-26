import { hn as AgentDefaultsConfig, i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { o as VerboseLevel, r as ThinkLevel } from "./thinking.shared-ClpJoUyA.js";
import { m as EmbeddedPiRunMeta } from "./params-DXH1hJUt.js";
import { o as SessionEntry } from "./types-D2DuU_TB.js";
import { t as ModelCatalogEntry } from "./model-catalog.types-CRpxx7uE.js";
import { n as RuntimeEnv } from "./runtime-CZFxIuHh.js";
import { t as CliDeps } from "./deps.types-Dp9ecsVw.js";
import { a as OutboundSessionContext } from "./delivery-queue-D2AVDddh.js";
import { l as projectOutboundPayloadPlanForJson } from "./deliver-BFHGr8Aj.js";
import { s as AcpSessionResolution, t as AcpSessionManager } from "./manager.core-BcVNvE0a.js";
import { n as AgentCommandOpts, r as AgentCommandResultMetaOverrides, t as AgentCommandIngressOpts } from "./types-Ccc2KS3W.js";

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
declare function agentCommand(opts: AgentCommandOpts, runtime?: RuntimeEnv, deps?: CliDeps): Promise<AgentCommandDeliveryResult>;
declare function agentCommandFromIngress(opts: AgentCommandIngressOpts, runtime?: RuntimeEnv, deps?: CliDeps): Promise<AgentCommandDeliveryResult>;
declare const __testing: {
  resolveAgentRuntimeConfig: typeof resolveAgentRuntimeConfig;
  prepareAgentCommandExecution: typeof prepareAgentCommandExecution;
};
//#endregion
export { agentCommand as n, agentCommandFromIngress as r, __testing as t };