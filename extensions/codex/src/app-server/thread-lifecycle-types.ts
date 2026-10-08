import type { AgentHarnessSessionRuntimeParamsV1 } from "openclaw/plugin-sdk/codex-mcp-projection";
import type {
  CodexAppServerLiveThreadOwnership,
  CodexEphemeralThreadPolicy,
} from "./client-thread-owner.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexInferenceProxy } from "./inference-proxy.js";
import type { CodexInferenceProviderRoutes } from "./inference-routing.js";
import type { CodexNativeModelInputTools } from "./native-model-input-tools.js";
import type { CodexPluginThreadConfig } from "./plugin-thread-config.js";
import type { CodexDynamicToolSpec, JsonObject } from "./protocol.js";
import type {
  CodexBindingAuthority,
  CodexAppServerBindingStore,
  CodexAppServerThreadBinding,
} from "./session-binding.js";
import type { CodexThreadConfigurationOptions } from "./thread-configuration-options.js";
import type { CodexContextEngineThreadBootstrapProjection } from "./thread-context-engine.js";
import type { CodexThreadLifecycleTimingOptions } from "./thread-lifecycle-timing.js";

type CodexAppServerThreadLifecycle = {
  action: "started" | "resumed" | "forked";
  /** This live thread leaves the durable binding unchanged and owns no submission store. */
  preserveExistingBinding?: true;
  rotatedContextEngineBinding?: boolean;
  activeTurnIds?: string[];
};

export type CodexAppServerThreadLifecycleBinding = CodexAppServerThreadBinding & {
  lifecycle: CodexAppServerThreadLifecycle;
  liveThreadConfigFingerprint?: string;
  /** Policy a live ephemeral thread was told; never persisted in the binding. */
  liveThreadEphemeralPolicy?: CodexEphemeralThreadPolicy;
  /** Process-local claim proof; never write this callback into durable binding state. */
  liveThreadOwnership?: CodexAppServerLiveThreadOwnership;
  clearInheritedServiceTier?: true;
};

export type CodexThreadFinalConfigPatchDecision = (
  | { action: "resume"; binding: CodexAppServerThreadBinding }
  | { action: "start" }
) & { nativeModelInputTools?: CodexNativeModelInputTools };

export type CodexThreadFinalConfigPatchResult = {
  configPatch?: JsonObject;
  nativeHookRelayGeneration?: string;
};

export type CodexPluginThreadConfigProvider = {
  enabled: boolean;
  /** Rebuild before reuse so live policy can narrow or revoke stored authority. */
  requiresCurrentPolicyCheck?: boolean;
  inputFingerprint?: string;
  enabledPluginConfigKeys?: readonly string[];
  recoverablePluginConfigKeys?: readonly string[];
  accountAppRecoveryEnabled?: boolean;
  build: (options?: { threadId?: string }) => Promise<CodexPluginThreadConfig>;
};

export type CodexStartOrResumeThreadParams = Omit<
  CodexThreadConfigurationOptions,
  "model" | "modelProvider" | "restrictedToolSurfaceInheritedMcpServerNames"
> & {
  inferenceRoute?: CodexInferenceProxy;
  inferenceProviderRoutes?: CodexInferenceProviderRoutes;
  client: CodexAppServerClient;
  abandonClient?: () => Promise<void>;
  reserveResumeThread?: (threadId: string) => { release: () => void };
  bindingStore: CodexAppServerBindingStore;
  params: AgentHarnessSessionRuntimeParamsV1;
  authority?: CodexBindingAuthority;
  /** Caller liveness; durable lineage is owned by authority. */
  assertCurrent?: () => void;
  /** Private execution identity resolved by this harness's catalog generation. */
  runtimeModelId?: string;
  agentId?: string;
  agentDir?: string;
  cwd: string;
  dynamicTools: CodexDynamicToolSpec[];
  persistentWebSearchAllowed?: boolean;
  agentWorkspaceDeveloperInstructions?: string;
  finalConfigPatch?: JsonObject;
  buildFinalConfigPatch?: (
    decision: CodexThreadFinalConfigPatchDecision,
    client: CodexAppServerClient,
  ) => CodexThreadFinalConfigPatchResult | Promise<CodexThreadFinalConfigPatchResult>;
  nativeHookRelayGeneration?: string;
  /** Session-layer PreToolUse hooks must survive authoritative managed hook requirements. */
  nativeHookRelayRequired?: boolean;
  /** A retained operator source can keep legacy hooks off only while its model policy is absent. */
  nativeModelAdmission?: "required" | "optional" | "disabled";
  userMcpServersEnabled?: boolean;
  mcpServersFingerprint?: string;
  mcpServersFingerprintEvaluated?: boolean;
  /** Versioned owner of configured MCP for scheduled dynamic-tool execution. */
  configuredMcpOwnershipVersion?: 1;
  appServerRuntimeFingerprint?: string;
  pluginThreadConfig?: CodexPluginThreadConfigProvider;
  contextEngineProjection?: CodexContextEngineThreadBootstrapProjection;
  signal?: AbortSignal;
  timing?: CodexThreadLifecycleTimingOptions;
};

export type CodexThreadResumePreparation = {
  modelProvider?: string | null;
  assertConfigured: () => void;
  assertCurrent: () => void;
  dispose: () => void;
  settledSystemError: boolean;
};
