import type { LlmRuntime } from "@openclaw/ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveDiagnosticModelContentCapturePolicy } from "../../infra/diagnostic-llm-content.js";
import {
  createDiagnosticEmbeddedRunOwner,
  markDiagnosticEmbeddedRunStarted,
} from "../../logging/diagnostic-run-activity.js";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
import { getModelProviderRuntimePluginHandle } from "../../plugins/provider-hook-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { resolveProviderTextTransforms } from "../../plugins/provider-runtime.js";
import { getCurrentSessionControllerOwner } from "../../sessions/session-controller.lifecycle.js";
import { assertSessionControllerOperation } from "../../sessions/session-controller.state.js";
import { SESSION_WATCHDOG_MAINTENANCE_GRACE_MS } from "../../sessions/session-controller.watchdog-state.js";
import { wrapStreamFnTextTransforms } from "../plugin-text-transforms.js";
import type { ModelCallUrgency } from "../run-trigger.js";
import type { AgentRuntimePlan } from "../runtime-plan/types.js";
import type { StreamFn } from "../runtime/index.js";
import { getModelRegistryRuntime } from "../sessions/model-registry-runtime.js";
import { createSessionStreamFn } from "../sessions/session-stream.js";
import type { SettingsManager } from "../sessions/settings-manager.js";
import { applyExtraParamsToAgent } from "./extra-params.js";
import { wrapStreamFnWithModelRequestGate } from "./model-request-hook.js";
import type { PreparedCompactionRuntime } from "./prepared-compaction-runtime.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./run/attempt.model-diagnostic-events.js";
import {
  resolveEmbeddedAgentApiKey,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStream,
} from "./stream-resolution.js";
import { mapThinkingLevelForProvider } from "./utils.js";

async function prepareCompactionSessionAgent(params: {
  session: { agent: { streamFn?: StreamFn } };
  llmRuntime: LlmRuntime;
  providerStreamFn: StreamFn | undefined;
  sessionId: string;
  effectiveModel: ProviderRuntimeModel;
  resolvedApiKey?: string;
  authStorage: Parameters<typeof resolveEmbeddedAgentStream>[0]["authStorage"];
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  thinkLevel: ThinkLevel;
  sessionAgentId: string;
  effectiveWorkspace: string;
  agentDir: string;
  runtimePlan?: AgentRuntimePlan;
  modelCallUrgency?: ModelCallUrgency;
  contextTokenBudget: number;
  /** Compaction request facts the `before_model_request` hook context carries. */
  params: { sessionKey?: string };
  trigger?: PluginHookAgentContext["trigger"];
  resolvedMessageProvider?: string;
}) {
  const transportApiKey = params.authStorage
    ? await resolveEmbeddedAgentApiKey({
        ...params,
        provider: params.effectiveModel.provider,
      })
    : params.resolvedApiKey;
  params.session.agent.streamFn = resolveEmbeddedAgentStream({
    ...params,
    currentStreamFn: resolveEmbeddedAgentBaseStreamFn({ session: params.session }),
    model: params.effectiveModel,
    transportAuthAvailable: Boolean(transportApiKey?.trim()),
    authProfileId: params.runtimePlan?.auth.forwardedAuthProfileId,
  }).streamFn;
  // Summaries resend older history, so they pass the same final request gate as turns,
  // at the same depth: provider/config payload wrappers applied below run first.
  params.session.agent.streamFn = wrapStreamFnWithModelRequestGate(
    params.session.agent.streamFn,
    {
      agentId: params.sessionAgentId,
      ...(params.params.sessionKey ? { sessionKey: params.params.sessionKey } : {}),
      sessionId: params.sessionId,
      workspaceDir: params.effectiveWorkspace,
      modelProviderId: params.provider,
      modelId: params.modelId,
      messageProvider: params.resolvedMessageProvider,
      trigger: params.trigger,
      contextTokenBudget: params.contextTokenBudget,
    },
    "compaction",
  );
  const providerTextTransforms = resolveProviderTextTransforms({
    provider: params.provider,
    config: params.config,
    workspaceDir: params.effectiveWorkspace,
    runtimeHandle: getModelProviderRuntimePluginHandle(params.effectiveModel),
  });
  if (providerTextTransforms) {
    params.session.agent.streamFn = wrapStreamFnTextTransforms({
      streamFn: params.session.agent.streamFn,
      input: providerTextTransforms.input,
      output: providerTextTransforms.output,
      transformSystemPrompt: false,
    });
  }
  const providerThinkingLevel = mapThinkingLevelForProvider(
    params.thinkLevel,
    params.effectiveModel,
  );
  const preparedRuntimeExtraParams = params.runtimePlan?.transport.resolveExtraParams({
    thinkingLevel: providerThinkingLevel,
    agentId: params.sessionAgentId,
    workspaceDir: params.effectiveWorkspace,
    model: params.effectiveModel,
  });
  const extraParams = applyExtraParamsToAgent(
    params.session.agent,
    params.config,
    params.provider,
    params.modelId,
    undefined,
    providerThinkingLevel,
    params.sessionAgentId,
    params.effectiveWorkspace,
    params.effectiveModel,
    params.agentDir,
    undefined,
    {
      modelCallUrgency: params.modelCallUrgency,
      ...(preparedRuntimeExtraParams ? { preparedExtraParams: preparedRuntimeExtraParams } : {}),
      auth: params.runtimePlan?.auth.selectedAuthMode
        ? {
            mode: params.runtimePlan.auth.selectedAuthMode,
            authFlow: params.runtimePlan.auth.selectedAuthFlow,
          }
        : undefined,
      nativeWebSearchPolicyContext: {
        // Summaries have no tool loop; provider-hosted tools must not inherit
        // the originating conversation's broader web-search authority.
        webSearchEnabled: false,
        runtimeToolAllowlist: [],
      },
    },
  );
  return { ...extraParams, transportApiKey, streamFn: params.session.agent.streamFn };
}

/** Build transport state without constructing an AgentSession or transcript manager. */
export async function prepareCompactionSessionStream(
  runtime: Pick<
    PreparedCompactionRuntime,
    | "effectiveModel"
    | "authStorage"
    | "provider"
    | "modelId"
    | "sessionAgentId"
    | "effectiveWorkspace"
    | "agentDir"
    | "contextTokenBudget"
    | "runtimePlan"
    | "resolvedMessageProvider"
    | "modelRegistry"
    | "hasRuntimeAuthExchange"
    | "apiKeyInfo"
    | "trigger"
  > & {
    params: Pick<
      PreparedCompactionRuntime["params"],
      "sessionId" | "sessionKey" | "config" | "modelCallUrgency"
    >;
  },
  settingsManager: SettingsManager,
  assertActive: () => void,
  thinkLevel: ThinkLevel,
  providerStreamFn: StreamFn | undefined,
  existing?: { agent: { streamFn?: StreamFn } },
) {
  const { params } = runtime;
  const session = existing ?? {
    agent: {
      streamFn: createSessionStreamFn(
        runtime.modelRegistry,
        settingsManager,
        undefined,
        assertActive,
      ),
    },
  };
  const transport = await prepareCompactionSessionAgent({
    ...runtime,
    session,
    llmRuntime: getModelRegistryRuntime(runtime.modelRegistry).llmRuntime,
    providerStreamFn,
    sessionId: params.sessionId,
    resolvedApiKey: runtime.hasRuntimeAuthExchange ? undefined : runtime.apiKeyInfo?.apiKey,
    config: params.config,
    thinkLevel,
    modelCallUrgency:
      runtime.trigger === "manual" ? "foreground" : (params.modelCallUrgency ?? "background"),
  });
  return { session, ...transport };
}

/** Request/output progress and fallback preparation share the silence watchdog. */
export function startCompactionDiagnosticStream(
  runtime: PreparedCompactionRuntime,
  streamFn: StreamFn,
  timeoutMs: number,
  onProgress: () => void,
  transport: string | undefined,
) {
  const { params, diagnosticCompactionRunId: runId } = runtime;
  const operation = getCurrentSessionControllerOwner();
  const owner = createDiagnosticEmbeddedRunOwner({
    watchdogAttempt: operation?.watchdog.attachAttempt({
      nested: true,
      assertCurrent: () => {
        params.abortSignal?.throwIfAborted();
        assertSessionControllerOperation(operation);
      },
    }),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId,
    workKey: runId,
  });
  owner.watchdogAttempt?.setExecutionDeadline(
    Date.now() + timeoutMs + SESSION_WATCHDOG_MAINTENANCE_GRACE_MS,
  );
  markDiagnosticEmbeddedRunStarted({ ...owner, owner });
  return {
    owner,
    streamFn: wrapStreamFnWithDiagnosticModelCallEvents(streamFn, {
      config: params.config,
      runId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      provider: runtime.provider,
      model: runtime.modelId,
      api: runtime.effectiveModel.api,
      transport,
      requestTimeoutMs: timeoutMs,
      contextTokenBudget: runtime.contextTokenBudget,
      trace: runtime.compactionModelCallTrace,
      contentCapture: resolveDiagnosticModelContentCapturePolicy(params.config),
      nextCallId: runtime.nextDiagnosticModelCallId,
      ownerGeneration: owner.generation,
      onStarted: onProgress,
      onOutputDelta: onProgress,
    }),
  };
}
