import { prepareActiveNodeContext } from "../../infra/active-node-context.js";
/**
 * Selects and invokes native agent harnesses for embedded run attempts.
 */
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { claimHeartbeatContextForUserRun } from "../../infra/heartbeat-outcome-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  assertOperatorModelAllowed,
  bindOperatorModelExecution,
  readRunOperatorAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../admitted-run-context.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import {
  isHostScopedAgentToolActive,
  runWithAgentRingZeroTools,
} from "../agent-tools.ring-zero-context.js";
import { isHeartbeatLifecycleRunKind } from "../bootstrap-mode.js";
import type { EmbeddedRunAttemptInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import { appendCurrentInboundContext } from "../embedded-agent-runner/run/runtime-context-prompt.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../embedded-agent-runner/run/types.js";
import {
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "../provider-secret-egress.js";
import { normalizeToolPolicyName } from "../tool-policy.js";
import type { SystemAgentToolOptions } from "../tools/system-agent-tool.js";
import { copyCoreTtsAttemptResultProvenance } from "../tools/tts-tool-result-provenance.js";
import { createOpenClawAgentHarness, isBuiltInOpenClawAgentHarness } from "./builtin-openclaw.js";
import { selectContextEngineForTranscriptHost } from "./context-engine-logical-turn.js";
import { drainPendingContextEngineTurnsBeforeRun } from "./context-engine-turn-attempt.js";
import { AgentHarnessPreflightError } from "./errors.js";
import {
  assertAgentHarnessExecutionEnvironment,
  resolvePluginHarnessDenyAllToolPolicyPrompt,
  resolvePluginHarnessToolPolicies,
  type ResolvedPluginHarnessToolPolicies,
} from "./execution-environment.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import {
  runAgentHarnessLifecycleAttempt,
  runAgentHarnessLifecycleFinalization,
} from "./lifecycle.js";
import type { AgentHarnessPolicy } from "./policy.js";
import {
  buildAgentHarnessSelectionDecision,
  resolveAgentHarnessSelectionDecision,
  type AgentHarnessSelectionParams,
  type AgentHarnessSelectionDecisionParams,
  type AgentHarnessSelectionCandidate,
  type AgentHarnessSelectionDecision as AgentHarnessSelectionFact,
  type AgentHarnessPreparedModelProvider,
} from "./selection-decision.js";
import {
  assertPluginHarnessConversationToolPolicySupport,
  resolveAgentHarnessPreparedAuthSupport,
  resolveAgentHarnessPreparedRouteSupport,
} from "./support.js";
import type { AgentHarness } from "./types.js";

const log = createSubsystemLogger("agents/harness");
export { resolveAvailableAgentHarnessPolicy } from "./availability.js";

type AgentHarnessSelectionDecision = Omit<AgentHarnessSelectionFact, "harness"> & {
  harness: AgentHarness;
};

export function selectAgentHarness(params: AgentHarnessSelectionParams): AgentHarness {
  return selectAgentHarnessDecision(params).harness;
}

/** Selects one harness that can preserve every prepared route/auth retry candidate. */
export function selectAgentHarnessForPreparedModelProviders(
  params: Omit<AgentHarnessSelectionParams, "modelProvider"> & {
    modelProviders: readonly AgentHarnessPreparedModelProvider[];
  },
): AgentHarness {
  const { modelProviders, ...selectionParams } = params;
  if (modelProviders.length === 0) {
    return selectAgentHarness(selectionParams);
  }
  const decisions = modelProviders.map((modelProvider) =>
    selectAgentHarnessDecision({
      ...selectionParams,
      modelProvider,
      preparedModelProvider: true,
    }),
  );
  const first = decisions[0];
  if (
    !first ||
    decisions.every((decision) => decision.selectedHarnessId === first.selectedHarnessId)
  ) {
    return first?.harness ?? selectAgentHarness(selectionParams);
  }
  // One embedded runtime owns the complete retry set. Auto selection and plugin-declared
  // fallbacks may resolve individual prepared routes to different harnesses.
  return (
    decisions.find((decision) => decision.selectedHarnessId === "openclaw")?.harness ??
    createOpenClawAgentHarness()
  );
}

function selectAgentHarnessDecision(
  params: AgentHarnessSelectionDecisionParams,
): AgentHarnessSelectionDecision {
  const selection = resolveAgentHarnessSelectionDecision(params);
  return {
    ...selection,
    harness: selection.builtIn ? createOpenClawAgentHarness() : selection.harness,
  };
}

/** Runs the selected harness's fail-closed settled-turn finalization operation. */
export async function runAgentHarnessSettledTurnFinalization(
  params: EmbeddedRunAttemptParams,
  settledAttempt: EmbeddedRunAttemptResult,
  harness: AgentHarness,
) {
  const internalParams = params as EmbeddedRunAttemptParams & {
    systemAgentTool?: SystemAgentToolOptions;
  };
  const finalizeSettledTurn = harness.finalizeSettledTurn?.bind(harness);
  if (!finalizeSettledTurn) {
    throw new Error(`Agent harness ${harness.id} cannot safely finalize a settled tool turn.`);
  }
  if (internalParams.systemAgentTool && !isSystemAgentOnlyAllowlist(internalParams.toolsAllow)) {
    throw new Error('OpenClaw host authority requires toolsAllow: ["openclaw"]');
  }
  const builtIn = isBuiltInOpenClawAgentHarness(harness);
  const operatorAuthority = assertHarnessModelPolicySupport(harness, params);
  const modelExecution = builtIn
    ? undefined
    : bindOperatorModelExecution(
        operatorAuthority,
        harness.nativeModelPolicySupport === "exact"
          ? (settledAttempt.runtimeModelSelection ?? {
              provider: params.provider,
              model: params.modelId,
            })
          : undefined,
      );
  try {
    modelExecution?.assertCurrent();
    const attemptParams = prepareHarnessFinalizationParams(
      {
        ...internalParams,
        operation: "settled-tool-finalization",
        abortSignal: modelExecution
          ? params.abortSignal
            ? AbortSignal.any([params.abortSignal, modelExecution.signal])
            : modelExecution.signal
          : params.abortSignal,
      },
      builtIn,
    );
    const result = await runAgentHarnessOperation(harness, params, () =>
      runWithAgentRingZeroTools([], () =>
        runAgentHarnessLifecycleFinalization(harness, attemptParams, () => {
          assertHarnessModelPolicySupport(harness, params);
          modelExecution?.assertCurrent();
          return finalizeSettledTurn({ attempt: attemptParams, settledAttempt });
        }),
      ),
    );
    modelExecution?.assertCurrent();
    return result;
  } finally {
    modelExecution?.release();
  }
}

export async function runAgentHarnessAttempt(
  params: EmbeddedRunAttemptParams,
  nativeSessionRuntime?: import("../embedded-agent-runner/run/model-setup.js").PreparedNativeSessionRuntime,
): Promise<EmbeddedRunAttemptResult> {
  let internalParams = params as EmbeddedRunAttemptParams & {
    systemAgentTool?: SystemAgentToolOptions;
  };
  if (nativeSessionRuntime) {
    await nativeSessionRuntime.assertCurrent();
  } else {
    assertOperatorModelAllowed(readRunOperatorAuthority(params), {
      provider: params.provider,
      model: params.modelId,
    });
  }
  // A bound native connection owns the real route. Outer model config cannot
  // redirect its transcript or credentials through a second support decision.
  const selection =
    nativeSessionRuntime?.auth === "native"
      ? buildSelectionDecision({
          harness: nativeSessionRuntime.harness,
          policy: { runtime: nativeSessionRuntime.harness.id, runtimeSource: "model" },
          selectedReason: "forced_plugin",
          candidates: [],
        })
      : selectPreparedAgentHarness(params);
  const harness = selection.harness;
  const nativeOwnsModel = nativeSessionRuntime?.auth === "native";
  const nativeModelPolicySupported = harness.nativeModelPolicySupport === "exact";
  assertHarnessModelPolicySupport(harness, params);
  const runPreparedAttempt = async (
    prepared: Parameters<typeof runAgentHarnessLifecycleAttempt>[1],
  ) => {
    if (nativeSessionRuntime) {
      await nativeSessionRuntime.assertCurrent();
    } else {
      assertOperatorModelAllowed(readRunOperatorAuthority(params), {
        provider: params.provider,
        model: params.modelId,
      });
    }
    const operatorAuthority = assertHarnessModelPolicySupport(harness, params);
    const modelExecution =
      selection.builtIn || (nativeOwnsModel && nativeModelPolicySupported)
        ? undefined
        : bindOperatorModelExecution(
            operatorAuthority,
            !nativeModelPolicySupported
              ? undefined
              : nativeSessionRuntime
                ? nativeSessionRuntime.modelRef
                : { provider: params.provider, model: params.modelId },
          );
    try {
      modelExecution?.assertCurrent();
      const result = await runAgentHarnessLifecycleAttempt(
        harness,
        modelExecution
          ? {
              ...prepared,
              abortSignal: prepared.abortSignal
                ? AbortSignal.any([prepared.abortSignal, modelExecution.signal])
                : modelExecution.signal,
            }
          : prepared,
      );
      await nativeSessionRuntime?.assertCurrent();
      modelExecution?.assertCurrent();
      return result;
    } finally {
      modelExecution?.release();
    }
  };
  assertAgentHarnessExecutionEnvironment(harness, params);
  if (nativeSessionRuntime && harness !== nativeSessionRuntime.harness) {
    throw new AgentHarnessPreflightError(
      "Native session runtime changed before dispatch. Reattach the original native session before retrying.",
    );
  }
  if (internalParams.contextEngineLogicalTurnLease) {
    selectContextEngineForTranscriptHost({
      lease: internalParams.contextEngineLogicalTurnLease,
      host: {
        id: `agent-harness:${harness.id}`,
        label: `agent harness "${harness.id}"`,
        capabilities: harness.contextEngineHostCapabilities ?? [],
      },
      operation: "agent-run",
      recorder: internalParams.userTurnTranscriptRecorder,
    });
    await drainPendingContextEngineTurnsBeforeRun({
      admission: internalParams.userTurnTranscriptRecorder?.getAdmissionReceipt(),
      isHeartbeat: isHeartbeatLifecycleRunKind(internalParams.bootstrapContextRunKind),
      lease: internalParams.contextEngineLogicalTurnLease,
      recorder: internalParams.userTurnTranscriptRecorder,
      sessionTarget: internalParams.sessionTarget,
    });
    const effective = internalParams.contextEngineLogicalTurnLease.begin();
    internalParams = {
      ...internalParams,
      contextEngine: effective.engine.info.id === "legacy" ? undefined : effective.engine,
    };
  }
  if (internalParams.systemAgentTool && !isSystemAgentOnlyAllowlist(internalParams.toolsAllow)) {
    throw new Error('OpenClaw host authority requires toolsAllow: ["openclaw"]');
  }
  const ringZeroTools = internalParams.systemAgentTool
    ? [
        (await import("../tools/system-agent-tool.js")).createSystemAgentTool(
          internalParams.systemAgentTool,
        ),
      ]
    : [];
  if (
    !selection.builtIn &&
    !internalParams.suppressNextUserMessagePersistence &&
    internalParams.userTurnTranscriptRecorder
  ) {
    const assertCurrent = resolveAdmittedRunActiveAssertion(
      internalParams.admittedRunContext,
      internalParams.abortSignal,
    );
    if (!assertCurrent) {
      throw new Error("agent harness requires active admitted run authority");
    }
    assertCurrent();
    // Promote approved input before the host binds annotation to its exact stored row.
    await internalParams.userTurnTranscriptRecorder.persistApproved({
      cwd: internalParams.cwd ?? internalParams.workspaceDir,
    });
    assertCurrent();
  }
  if (nativeSessionRuntime) {
    await nativeSessionRuntime.assertCurrent();
  }
  const attemptParams = withoutHarnessSetupAuthority(internalParams);
  const pluginAttempt = withoutInternalHarnessAuthority(
    attemptParams,
    harness,
    selection.builtIn,
    selection.ownerPluginId,
  );
  logAgentHarnessSelection(selection, {
    provider: params.provider,
    modelId: params.modelId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  let result: EmbeddedRunAttemptResult;
  try {
    result = await runAgentHarnessOperation(harness, params, () =>
      runWithAgentRingZeroTools(ringZeroTools, () => {
        // Resolve plugin policy after entering the host scope. Ring-zero tools are
        // trusted setup authority and must survive ordinary deny-all policy.
        const hostOpenClawAuthority =
          isHostScopedAgentToolActive("openclaw") &&
          isSystemAgentOnlyAllowlist(pluginAttempt.params.toolsAllow);
        const nativePermissionsConsented = assertAgentHarnessExecutionEnvironment(harness, params);
        const preparedParams = selection.builtIn
          ? pluginAttempt.params
          : preparePluginHarnessParams(pluginAttempt.params, harness, nativePermissionsConsented);
        const effectiveAttemptParams =
          hostOpenClawAuthority && preparedParams.pluginHarnessToolPolicyRestricted
            ? { ...preparedParams, pluginHarnessToolPolicyRestricted: false }
            : preparedParams;
        assertPluginHarnessConversationToolPolicySupport(
          harness,
          effectiveAttemptParams.pluginHarnessToolPolicyRestricted === true &&
            !nativePermissionsConsented,
        );
        // Load the calculator only after admission and final host policy preparation.
        return import("./tool-authority.runtime.js").then(
          ({ withPreparedEmbeddedRunToolAuthority }) =>
            withPreparedEmbeddedRunToolAuthority(
              internalParams,
              effectiveAttemptParams,
              selection.builtIn
                ? undefined
                : (input) => {
                    const policies = resolvePluginHarnessToolPolicies({
                      ...input.run,
                      modelId: input.run.model,
                      sandboxSessionKey: input.run.runtimePolicySessionKey,
                      messageChannel: input.originatingChannel,
                      toolsAllow: input.toolsAllow,
                      disableTools: input.disableTools,
                    });
                    return resolvePluginHarnessDenyAllToolPolicyPrompt(policies)
                      ? { ...input, toolsAllow: [] }
                      : input;
                  },
              (prepared) =>
                pluginAttempt.runWithHostScope(async () => {
                  if (prepared.trigger !== "user" || !prepared.sessionKey) {
                    return runPreparedAttempt(prepared);
                  }
                  const note = await claimHeartbeatContextForUserRun({
                    ...prepared,
                    agentId: resolveSessionAgentIds(prepared).sessionAgentId,
                    storePath: prepared.sessionTarget?.storePath,
                    detached: prepared.sessionPersistence === "detached",
                    assertCurrent: resolveAdmittedRunActiveAssertion(
                      internalParams.admittedRunContext,
                      prepared.abortSignal,
                    ),
                  });
                  if (!note) {
                    return runPreparedAttempt(prepared);
                  }
                  return runPreparedAttempt({
                    ...prepared,
                    currentInboundContext: appendCurrentInboundContext(
                      prepared.currentInboundContext,
                      [{ kind: "heartbeat-outcome", text: note }],
                    ),
                  });
                }),
            ),
        );
      }),
    );
  } finally {
    pluginAttempt.closeHostCapabilities();
  }
  const admission = internalParams.userTurnTranscriptRecorder?.getAdmissionReceipt();
  if (
    internalParams.onContextEngineTurnCandidate &&
    admission &&
    result.contextEngineTerminalAnchor
  ) {
    internalParams.onContextEngineTurnCandidate({
      boundary: {
        admission,
        terminal: result.contextEngineTerminalAnchor,
      },
      sessionIdUsed: result.sessionIdUsed,
      sessionKey: internalParams.sessionKey,
      sessionTarget: internalParams.sessionTarget,
      promptError: result.terminal.kind === "failed",
      aborted:
        result.terminal.kind === "aborted" ||
        (result.terminal.kind === "timeout" &&
          "aborted" in result.terminal &&
          result.terminal.aborted === true),
      yieldAborted:
        result.terminal.kind === "aborted" && result.terminal.source === "yield_cleanup",
      isHeartbeat: isHeartbeatLifecycleRunKind(internalParams.bootstrapContextRunKind),
      // Native model identity does not attest the host's window or context cap.
      runtimeContext:
        nativeSessionRuntime && result.runtimeModelSelection
          ? {
              provider: result.runtimeModelSelection.provider,
              modelId: result.runtimeModelSelection.model,
            }
          : {
              provider: internalParams.provider,
              modelId: internalParams.modelId,
              modelContextWindow: internalParams.modelContextWindow,
              tokenBudget: internalParams.contextTokenBudget,
            },
    });
  }
  const { contextEngineTerminalAnchor: _contextEngineTerminalAnchor, ...publicResult } = result;
  return copyCoreTtsAttemptResultProvenance(result, publicResult);
}

function assertHarnessModelPolicySupport(harness: AgentHarness, params: EmbeddedRunAttemptParams) {
  const authority = readRunOperatorAuthority(params);
  authority?.assertCurrent();
  if (
    !isBuiltInOpenClawAgentHarness(harness) &&
    authority?.modelPolicy &&
    harness.nativeModelPolicySupport !== "exact"
  ) {
    throw new AgentHarnessPreflightError(
      `Agent harness ${harness.id} cannot enforce your operator role's model policy. Choose a compatible runtime or ask a gateway administrator to update the harness.`,
    );
  }
  return authority;
}

function selectPreparedAgentHarness(
  params: EmbeddedRunAttemptParams,
): AgentHarnessSelectionDecision {
  return selectAgentHarnessDecision({
    provider: params.provider,
    modelId: params.modelId,
    modelProvider: {
      api: params.model.api,
      baseUrl: params.model.baseUrl,
      ...resolveAgentHarnessPreparedRouteSupport(params.runtimePlan?.auth),
      preparedAuth: resolveAgentHarnessPreparedAuthSupport({ plan: params.runtimePlan?.auth }),
    },
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    agentHarnessId: params.agentHarnessId,
    agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
    preparedModelProvider: params.runtimePlan?.auth !== undefined,
  });
}

async function runAgentHarnessOperation<T>(
  harness: AgentHarness,
  params: EmbeddedRunAttemptParams,
  execute: () => Promise<T>,
): Promise<T> {
  await prepareActiveNodeContext();
  resolveAdmittedRunActiveAssertion(params.admittedRunContext, params.abortSignal)?.();
  const activeTrace = getActiveDiagnosticTraceContext();
  const harnessTrace = freezeDiagnosticTraceContext(
    activeTrace ? createChildDiagnosticTraceContext(activeTrace) : createDiagnosticTraceContext(),
  );
  if (isBuiltInOpenClawAgentHarness(harness)) {
    return await runWithDiagnosticTraceContext(harnessTrace, execute);
  }

  try {
    return await runWithDiagnosticTraceContext(harnessTrace, execute);
  } catch (error) {
    log.warn(`${harness.label} failed; not falling back to embedded OpenClaw backend`, {
      harnessId: harness.id,
      provider: params.provider,
      modelId: params.modelId,
      error: formatErrorMessage(error),
    });
    throw error;
  }
}

function isSystemAgentOnlyAllowlist(toolsAllow: readonly string[] | undefined): boolean {
  return toolsAllow?.length === 1 && normalizeToolPolicyName(toolsAllow[0] ?? "") === "openclaw";
}

function withoutHarnessSetupAuthority(
  params: EmbeddedRunAttemptParams & { systemAgentTool?: SystemAgentToolOptions },
): EmbeddedRunAttemptParams {
  const {
    contextEngineLogicalTurnLease: _contextEngineLogicalTurnLease,
    systemAgentTool: _systemAgentTool,
    ...attemptParams
  } = params;
  return attemptParams;
}

function withoutInternalHarnessAuthority(
  params: EmbeddedRunAttemptParams,
  harness: AgentHarness,
  builtIn: boolean,
  ownerPluginId: string | undefined,
): {
  params: import("./types.js").AgentHarnessAttemptParamsV2;
  closeHostCapabilities: () => void;
  runWithHostScope: <T>(run: () => Promise<T>) => Promise<T>;
} {
  if (builtIn) {
    return {
      // The built-in harness is the internal owner of this authority. Only
      // plugin handoffs receive the projected public attempt shape below.
      params: {
        ...params,
        operationalRunInstance: params.admittedRunContext.operationalRunInstance,
      } as import("./types.js").AgentHarnessAttemptParamsV2,
      closeHostCapabilities: () => {},
      runWithHostScope: (run) => run(),
    };
  }
  const pluginParams = withoutPluginHarnessPrivateState(params);
  const host = createAgentHarnessHostCapabilities({
    attempt: params,
    requiredNodeCommands: harness.cloudPlacement?.devicePlacement?.requiredNodeCommands,
    pluginId:
      ownerPluginId ??
      (() => {
        throw new Error(`Agent harness ${harness.id} has no authoritative registry owner.`);
      })(),
  });
  return {
    params: { ...pluginParams, hostCapabilities: host.capabilities },
    closeHostCapabilities: host.close,
    runWithHostScope: host.runWithScope,
  };
}

function prepareHarnessFinalizationParams(
  params: EmbeddedRunAttemptParams & { systemAgentTool?: SystemAgentToolOptions },
  builtIn: boolean,
): import("./types.js").AgentHarnessSettledTurnFinalizationAttemptParams<
  import("./types.js").AgentHarnessAttemptParamsV2
> {
  const {
    hostCapabilities: _hostCapabilities,
    systemAgentTool: _systemAgentTool,
    ...withoutCapabilities
  } = params;
  if (builtIn) {
    return withoutCapabilities;
  }
  const pluginParams = withoutPluginHarnessPrivateState(withoutCapabilities);
  const boundary = "plugin harness finalization handoff";
  return {
    ...pluginParams,
    model: unwrapModelHeaderSentinelsForProviderEgress(pluginParams.model, boundary),
    resolvedApiKey: pluginParams.resolvedApiKey
      ? unwrapSecretSentinelsForProviderEgress(pluginParams.resolvedApiKey, boundary)
      : pluginParams.resolvedApiKey,
  };
}

function withoutPluginHarnessPrivateState(
  params: EmbeddedRunAttemptInternalParams,
): Omit<import("./types.js").AgentHarnessAttemptParamsV2, "hostCapabilities"> {
  // Keep mutable host-owned state behind one projection for every plugin handoff;
  // separate projections can drift and expose authority on less common operations.
  const {
    admittedRunContext: _admittedRunContext,
    assistantErrorTranscript: _assistantErrorTranscript,
    compactionCountOwner: _compactionCountOwner,
    onContextAccountingEvent: _onContextAccountingEvent,
    onCompactionRequestBudget: _onCompactionRequestBudget,
    contextEngineLogicalTurnLease: _contextEngineLogicalTurnLease,
    hostCapabilities: _hostCapabilities,
    onContextEngineTurnCandidate: _onContextEngineTurnCandidate,
    trajectoryRecorder: _trajectoryRecorder,
    __openclawSourceReplyDeliveryRuntime: _sourceReplyDeliveryRuntime,
    ...pluginParams
  } = params as EmbeddedRunAttemptInternalParams & {
    __openclawSourceReplyDeliveryRuntime?: unknown;
  };
  return pluginParams;
}

function preparePluginHarnessParams(
  params: import("./types.js").AgentHarnessAttemptParamsV2,
  harness: AgentHarness,
  nativePermissionsConsented: boolean,
): import("./types.js").AgentHarnessAttemptParamsV2 {
  const boundary = "plugin harness handoff";
  const resolvedApiKey = params.resolvedApiKey
    ? unwrapSecretSentinelsForProviderEgress(params.resolvedApiKey, boundary)
    : params.resolvedApiKey;
  const model = unwrapModelHeaderSentinelsForProviderEgress(params.model, boundary);
  const preparedParams =
    model === params.model && resolvedApiKey === params.resolvedApiKey
      ? params
      : { ...params, model, resolvedApiKey };
  const policies = resolvePluginHarnessToolPolicies(
    preparedParams,
    harness.conversationToolPolicySupport === "exact"
      ? harness.conversationToolPolicySafeDenyTools
      : undefined,
    harness.conversationToolPolicyNativeTools,
  );
  const policyParams = {
    ...preparedParams,
    pluginHarnessToolPolicySafeDeniedTools:
      policies.safeDeniedToolNames.length > 0 ? policies.safeDeniedToolNames : undefined,
    pluginHarnessToolPolicyRestricted: policies.toolPolicyRestricted,
  };
  return nativePermissionsConsented
    ? policyParams
    : applyPluginHarnessDenyAllToolPolicy(policyParams, policies);
}

function applyPluginHarnessDenyAllToolPolicy(
  params: import("./types.js").AgentHarnessAttemptParamsV2,
  policies: ResolvedPluginHarnessToolPolicies,
): import("./types.js").AgentHarnessAttemptParamsV2 {
  if (
    isHostScopedAgentToolActive("openclaw") &&
    params.toolsAllow?.length === 1 &&
    normalizeToolPolicyName(params.toolsAllow[0] ?? "") === "openclaw"
  ) {
    return params;
  }
  const prompt = resolvePluginHarnessDenyAllToolPolicyPrompt(policies);
  if (!prompt) {
    return params;
  }
  return {
    ...params,
    toolsAllow: [],
    extraSystemPrompt: appendPluginHarnessToolPolicyPrompt(params.extraSystemPrompt, prompt),
  };
}

function appendPluginHarnessToolPolicyPrompt(existing: string | undefined, prompt: string): string {
  const trimmed = existing?.trim();
  if (!trimmed) {
    return prompt;
  }
  return trimmed.includes(prompt) ? trimmed : `${trimmed}\n\n${prompt}`;
}

function buildSelectionDecision(params: {
  harness: AgentHarness;
  policy: AgentHarnessPolicy;
  selectedReason: AgentHarnessSelectionDecision["selectedReason"];
  candidates: AgentHarnessSelectionCandidate[];
}): AgentHarnessSelectionDecision {
  return {
    ...buildAgentHarnessSelectionDecision({
      ...params,
      harness: isBuiltInOpenClawAgentHarness(params.harness) ? undefined : params.harness,
    }),
    harness: params.harness,
  };
}

function logAgentHarnessSelection(
  selection: AgentHarnessSelectionDecision,
  params: { provider: string; modelId?: string; sessionKey?: string; agentId?: string },
) {
  if (!log.isEnabled("debug")) {
    return;
  }
  log.debug("agent harness selected", {
    provider: params.provider,
    modelId: params.modelId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    selectedHarnessId: selection.selectedHarnessId,
    selectedReason: selection.selectedReason,
    runtime: selection.policy.runtime,
    candidates: selection.candidates,
  });
}
