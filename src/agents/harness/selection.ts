import { readRuntimeConfig } from "../../config/runtime-snapshot.js";
import { hasInternalHookListeners } from "../../hooks/internal-hooks.js";
import { prepareActiveNodeContext } from "../../infra/active-node-context.js";
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
import { hasGlobalHooks } from "../../plugins/hook-runner-global.js";
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
import type { SystemAgentToolOptions } from "../tools/system-agent-tool.js";
import { copyCoreTtsAttemptResultProvenance } from "../tools/tts-tool-result-provenance.js";
import { createOpenClawAgentHarness, isBuiltInOpenClawAgentHarness } from "./builtin-openclaw.js";
import {
  resolveContextEngineCompletionRuntimeContext,
  runWithContextEngineAssemblyAttempt,
  type ContextEngineAssemblySnapshot,
} from "./context-engine-assembly-attempt.js";
import { beginContextEngineLogicalTurn } from "./context-engine-turn-begin.js";
import { AgentHarnessPreflightError } from "./errors.js";
import {
  assertAgentHarnessExecutionEnvironment,
  isSystemAgentOnlyAllowlist,
  resolvePluginHarnessDenyAllToolPolicyPrompt,
  resolvePluginHarnessToolPolicies,
} from "./execution-environment.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { bindHarnessSettledTurnCallback } from "./host-source-authority.js";
import {
  runAgentHarnessLifecycleAttempt,
  runAgentHarnessLifecycleFinalization,
} from "./lifecycle.js";
import { preparePluginHarnessParams } from "./plugin-attempt-params.js";
import {
  prepareHarnessFinalizationParams,
  withoutPluginHarnessPrivateState,
} from "./plugin-private-state.js";
import {
  buildAgentHarnessSelectionDecision,
  resolveAgentHarnessSelectionDecision,
  type AgentHarnessSelectionParams,
  type AgentHarnessSelectionDecisionParams,
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
const WORKSPACE_EFFECT_HOOKS = [
  "agent_turn_prepare",
  "before_prompt_build",
  "before_agent_run",
  "llm_input",
  "llm_output",
  "before_agent_finalize",
  "agent_end",
  "before_message_write",
  "tool_result_persist",
  "before_compaction",
  "after_compaction",
] as const;
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
  params: EmbeddedRunAttemptInternalParams,
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
      ? {
          ...buildAgentHarnessSelectionDecision({
            harness: isBuiltInOpenClawAgentHarness(nativeSessionRuntime.harness)
              ? undefined
              : nativeSessionRuntime.harness,
            policy: { runtime: nativeSessionRuntime.harness.id, runtimeSource: "model" },
            selectedReason: "forced_plugin",
            candidates: [],
          }),
          harness: nativeSessionRuntime.harness,
        }
      : selectPreparedAgentHarness(params);
  const harness = selection.harness;
  const nativeOwnsModel = nativeSessionRuntime?.auth === "native";
  const nativeModelPolicySupported = harness.nativeModelPolicySupport === "exact";
  assertHarnessModelPolicySupport(harness, params);
  let nativePermissionsConsented = false;
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
        async (attempt) => {
          if (harness.executionEnvironment === "host-only") {
            // Prepared turns can outlive agent consent; the live config owner
            // must still authorize native work after all asynchronous setup.
            const currentConsent = await assertAgentHarnessExecutionEnvironment(harness, {
              ...params,
              config: readRuntimeConfig(),
            });
            if (nativePermissionsConsented && !currentConsent) {
              throw new AgentHarnessPreflightError(
                "Native runtime consent was revoked before dispatch. Review this chat's permissions before retrying.",
              );
            }
          }
          attempt.hostCapabilities?.assertActive();
          return harness.runAttempt(attempt);
        },
      );
      await nativeSessionRuntime?.assertCurrent();
      modelExecution?.assertCurrent();
      return result;
    } finally {
      modelExecution?.release();
    }
  };
  if (nativeSessionRuntime && harness !== nativeSessionRuntime.harness) {
    throw new AgentHarnessPreflightError(
      "Native session runtime changed before dispatch. Reattach the original native session before retrying.",
    );
  }
  if (internalParams.contextEngineLogicalTurnLease) {
    const effective = await beginContextEngineLogicalTurn({
      lease: internalParams.contextEngineLogicalTurnLease,
      host: {
        id: `agent-harness:${harness.id}`,
        label: `agent harness "${harness.id}"`,
        capabilities: harness.contextEngineHostCapabilities ?? [],
      },
      recorder: internalParams.userTurnTranscriptRecorder,
      isHeartbeat: isHeartbeatLifecycleRunKind(internalParams.bootstrapContextRunKind),
      sessionTarget: internalParams.sessionTarget,
    });
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
  const recorder =
    !selection.builtIn && !internalParams.suppressNextUserMessagePersistence
      ? internalParams.userTurnTranscriptRecorder
      : undefined;
  const awaitBaseline = internalParams.awaitSessionDiffBaseline;
  if (
    recorder ||
    (awaitBaseline &&
      (!selection.builtIn ||
        WORKSPACE_EFFECT_HOOKS.some((hook) => hasGlobalHooks(hook)) ||
        (internalParams.trigger === "heartbeat" &&
          hasGlobalHooks("heartbeat_prompt_contribution")) ||
        hasInternalHookListeners("agent", "bootstrap")))
  ) {
    const assertCurrent = resolveAdmittedRunActiveAssertion(
      internalParams.admittedRunContext,
      internalParams.abortSignal,
    );
    if (!assertCurrent) {
      throw new Error("agent harness requires active admitted run authority");
    }
    assertCurrent();
    // Agent callbacks can write workspace files even when the turn never runs a tool.
    await awaitBaseline?.();
    internalParams.abortSignal?.throwIfAborted();
    assertCurrent();
    if (recorder) {
      // Promote approved input before the host binds annotation to its exact stored row.
      await recorder.persistApproved({ cwd: internalParams.cwd ?? internalParams.workspaceDir });
      assertCurrent();
    }
  }
  if (nativeSessionRuntime) {
    await nativeSessionRuntime.assertCurrent();
  }
  const {
    contextEngineLogicalTurnLease: _contextEngineLogicalTurnLease,
    systemAgentTool: _systemAgentTool,
    ...attemptParams
  } = internalParams;
  const pluginAttempt = withoutInternalHarnessAuthority(
    attemptParams,
    harness,
    selection.builtIn,
    selection.ownerPluginId,
  );
  let result: EmbeddedRunAttemptResult;
  let assembly: ContextEngineAssemblySnapshot | undefined;
  try {
    const run = () =>
      runAgentHarnessOperation(harness, params, () =>
        runWithAgentRingZeroTools(ringZeroTools, async () => {
          // Resolve plugin policy after entering the host scope. Ring-zero tools are
          // trusted setup authority and must survive ordinary deny-all policy.
          const hostOpenClawAuthority =
            isHostScopedAgentToolActive("openclaw") &&
            isSystemAgentOnlyAllowlist(pluginAttempt.params.toolsAllow);
          nativePermissionsConsented = await assertAgentHarnessExecutionEnvironment(
            harness,
            params,
          );
          const preparedParams = selection.builtIn
            ? pluginAttempt.params
            : await preparePluginHarnessParams(
                pluginAttempt.params,
                harness,
                nativePermissionsConsented,
                pluginAttempt.setInputAttachmentReadAllowed,
                attemptParams.runtimePluginToolGrant !== undefined,
                // Pending native supervision has no model identity to prepare against yet.
                nativeSessionRuntime?.auth === "native"
                  ? (nativeSessionRuntime.modelRef ?? null)
                  : undefined,
              );
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
                  : (input, sandbox) => {
                      const policies = resolvePluginHarnessToolPolicies(
                        {
                          ...input.run,
                          modelId: input.run.model,
                          sandboxSessionKey: input.run.runtimePolicySessionKey,
                          messageChannel: input.originatingChannel,
                          toolsAllow: input.toolsAllow,
                          disableTools: input.disableTools,
                        },
                        undefined,
                        undefined,
                        sandbox,
                      );
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
    ({ result, assembly } = await runWithContextEngineAssemblyAttempt(run));
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
      runtimeContext: resolveContextEngineCompletionRuntimeContext(
        internalParams,
        result,
        nativeSessionRuntime !== undefined,
        assembly,
      ),
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
  await prepareActiveNodeContext(readRunOperatorAuthority(params)?.profileId);
  resolveAdmittedRunActiveAssertion(params.admittedRunContext, params.abortSignal)?.();
  const activeTrace = getActiveDiagnosticTraceContext();
  const harnessTrace = freezeDiagnosticTraceContext(
    activeTrace ? createChildDiagnosticTraceContext(activeTrace) : createDiagnosticTraceContext(),
  );
  const builtIn = isBuiltInOpenClawAgentHarness(harness);
  try {
    return await runWithDiagnosticTraceContext(harnessTrace, execute);
  } catch (error) {
    if (!builtIn) {
      log.warn(`${harness.label} failed; not falling back to embedded OpenClaw backend`, {
        harnessId: harness.id,
        provider: params.provider,
        modelId: params.modelId,
        error: formatErrorMessage(error),
      });
    }
    throw error;
  }
}

function withoutInternalHarnessAuthority(
  params: EmbeddedRunAttemptParams,
  harness: AgentHarness,
  builtIn: boolean,
  ownerPluginId: string | undefined,
): {
  params: import("./types.js").AgentHarnessAttemptParamsV2;
  closeHostCapabilities: () => void;
  setInputAttachmentReadAllowed: (allowed: boolean) => void;
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
      setInputAttachmentReadAllowed: () => {},
      runWithHostScope: (run) => run(),
    };
  }
  const pluginParams = withoutPluginHarnessPrivateState(params);
  const host = createAgentHarnessHostCapabilities({
    attempt: params,
    requiredNodeCommands: harness.cloudPlacement?.devicePlacement?.requiredNodeCommands,
    nativeModelPolicySupport: harness.nativeModelPolicySupport,
    pluginId:
      ownerPluginId ??
      (() => {
        throw new Error(`Agent harness ${harness.id} has no authoritative registry owner.`);
      })(),
  });
  return {
    params: {
      ...pluginParams,
      hostCapabilities: host.capabilities,
      onSettledTurn: bindHarnessSettledTurnCallback(
        params.onSettledTurn,
        host.capabilities.assertActive,
        params.abortSignal,
      ),
    },
    closeHostCapabilities: host.close,
    setInputAttachmentReadAllowed: host.setInputAttachmentReadAllowed,
    runWithHostScope: host.runWithScope,
  };
}
