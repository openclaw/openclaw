import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import { projectExecutionSessionEntry } from "../../config/sessions/session-entry-projection.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import {
  resolveContextEngine,
  resolveContextEngineOwnerPluginId,
} from "../../context-engine/registry.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import type { ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import {
  runOutsidePluginRuntimeGenerationScope,
  withPluginRuntimeGenerationScope,
} from "../../plugins/runtime/generation-scope.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import {
  captureSessionTarget,
  getCurrentSessionControllerOwner,
} from "../../sessions/session-controller.lifecycle.js";
import {
  resolveSessionControllerOperationForSignal,
  getSessionControllerOperation,
  getSessionControllerEntryForOperation,
} from "../../sessions/session-controller.state.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import { resolveUserPath } from "../../utils.js";
import { resolveAgentDir, resolveSessionAgentIds } from "../agent-scope.js";
import { isRecoverableNativeHarnessBindingFailure } from "../harness/compaction-recovery.js";
import { maybeCompactAgentHarnessSession } from "../harness/compaction.js";
import { retainAgentHarnessCompactionSource } from "../harness/host-source-authority.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import { acquireAgentRunPreparedModelRuntime } from "../prepared-model-runtime.js";
import { resolveAgentRunSessionTarget } from "../run-session-target.js";
import { materializePreparedRuntimeModel } from "../runtime-plan/materialize-model.js";
import type { SandboxContext } from "../sandbox/types.js";
import { beginForegroundSessionMaintenance } from "../session-maintenance/coordinator.js";
import { prepareSessionPlacementSandbox } from "../session-placement-admission.js";
import {
  buildCompactionFailureResult,
  DEFERRED_CONTEXT_ENGINE_COMPACTION_REASON,
} from "./compact-reasons.js";
import {
  runForegroundCompactionWork,
  withQueuedCompactionTurn,
} from "./compact.foreground-work.js";
import { compactNativeCliSession } from "./compact.js";
import { attachManualCompactionRun } from "./compact.manual-run.js";
import {
  createQueuedCompactionAbortedResult,
  projectQueuedCompactionSessionTarget,
  executeQueuedContextEngineCompaction,
  runPrimaryNativeCompactionInLanes,
  withQueuedCompactionCancellationResult,
} from "./compact.queued-execution.js";
import type {
  CompactEmbeddedAgentSessionParams,
  QueuedCompactionHostOptions,
} from "./compact.types.js";
import {
  buildEmbeddedCompactionRuntimeContext,
  resolveCompactionContextTokenBudget,
} from "./compaction-runtime-context.js";
import {
  prepareCompactionHarnessAuth,
  resolveCompactionRuntimeSelection,
} from "./compaction-runtime-preparation.js";
import type { acceptCompactionSuccessor } from "./compaction-successor.js";
import { resolveContextEngineCapabilities } from "./context-engine-capabilities.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";
import { log } from "./logger.js";
import { resolveTieredModel } from "./model-resolution.js";
import { resolveModelAsync } from "./model.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

type QueuedCompactionParams = CompactEmbeddedAgentSessionParams & {
  sessionTarget: SessionTranscriptRuntimeTarget;
  sandbox?: SandboxContext | null;
};

function lockedCompactionRuntimeFailure(runtime?: string): EmbeddedAgentCompactResult {
  return buildCompactionFailureResult(
    runtime
      ? `Model selection is locked to native agent harness "${runtime}", but native compaction is unavailable.`
      : "Model selection is locked but the persisted agent harness is unavailable.",
    { reason: "model_selection_locked" },
  );
}

const manualCompactionActiveRunFailure = (): EmbeddedAgentCompactResult => ({
  ok: false,
  compacted: false,
  reason: "manual compaction unavailable while another embedded run is active",
  failure: { reason: "active_run" },
});

function assertQueuedCompactionPreparationActive(
  params: CompactEmbeddedAgentSessionParams,
  host: QueuedCompactionHostOptions,
): void {
  // Preparation runs outside the execution queue. Revalidate after each await
  // so a cancelled or replaced owner cannot continue expensive setup.
  params.abortSignal?.throwIfAborted();
  host.assertActive?.();
}

/**
 * Compacts a session with lane queueing (session lane + global lane).
 * Use this from outside a lane context. If already inside a lane, use
 * `compactEmbeddedAgentSessionDirect` to avoid deadlocks.
 */
export async function compactEmbeddedAgentSession(
  input: CompactEmbeddedAgentSessionParams,
  options: QueuedCompactionHostOptions,
): Promise<EmbeddedAgentCompactResult> {
  const ambient = getCurrentSessionControllerOwner();
  const sourceOperation =
    options.replyOperation ??
    resolveSessionControllerOperationForSignal(input.abortSignal) ??
    (ambient && ambient.key === input.sessionKey && ambient.hasOwnedSessionId(input.sessionId)
      ? ambient
      : undefined);
  return await runWithAsyncWorkResources(async (onAcquired) => {
    const releaseSource = retainAgentHarnessCompactionSource(options.sourceAuthority);
    onAcquired({ release: releaseSource, releaseBeforeResultWhenIdle: true });
    const sourceAuthority = options.sourceAuthority;
    const assertHostActive = options.assertActive;
    const host = {
      ...options,
      assertActive: composeSessionSourceAssertion([
        assertHostActive,
        sourceAuthority.assertActive,
        sourceAuthority.operatorAuthority?.assertCurrent,
      ]),
    };
    const signals = [input.abortSignal, sourceAuthority.operatorAuthority?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const params = {
      ...input,
      ...(signals.length > 0 ? { abortSignal: AbortSignal.any(signals) } : {}),
    };
    const contextEngineAgentId =
      normalizeOptionalString(params.contextEngineAgentId) ??
      normalizeOptionalString(params.agentId);
    const contextEngineSessionKey =
      normalizeOptionalString(params.sessionKey) ??
      normalizeOptionalString(params.sessionTarget?.sessionKey);
    const runtimeTarget =
      host.preparedSession?.sessionTarget ??
      (await resolveAgentRunSessionTarget({
        ...params,
        missingSessionKey: "resolve-existing",
      }));
    if (
      params.trigger === "manual" &&
      !sourceOperation &&
      getSessionControllerOperation(
        runtimeTarget.sessionKey,
        captureSessionTarget({
          storeScope: runtimeTarget.storePath,
          sessionKey: runtimeTarget.sessionKey,
          agentId: runtimeTarget.agentId,
          incarnation: runtimeTarget.sessionId,
        }),
      )
    ) {
      return manualCompactionActiveRunFailure();
    }
    return await withQueuedCompactionCancellationResult(params, () =>
      withQueuedCompactionTurn(
        { ...runtimeTarget, replyOperation: sourceOperation, abortSignal: params.abortSignal },
        async (operation, operationSignal, onSettled) => {
          host.replyOperation = operation;
          const onCommitted = host.onCommitted;
          host.onCommitted = (accepted) => {
            operation?.updateSessionId(accepted.sessionId);
            onCommitted?.(accepted);
          };
          const releaseForeground =
            params.trigger === "manual"
              ? await beginForegroundSessionMaintenance(runtimeTarget.sessionKey)
              : undefined;
          if (releaseForeground) {
            onSettled(releaseForeground);
          }
          // Resolve the storage address first, then freeze its owner before runtime/plugin awaits.
          const entry =
            host.preparedSession?.entry ??
            (await readSessionEntryReadOnlyInWorker(
              { ...runtimeTarget, readConsistency: "latest" },
              () => {
                operationSignal.throwIfAborted();
                assertQueuedCompactionPreparationActive(params, host);
              },
            ));
          operationSignal.throwIfAborted();
          assertQueuedCompactionPreparationActive(params, host);
          const expectedEntry = {
            sessionId: runtimeTarget.sessionId,
            lifecycleRevision: entry?.lifecycleRevision,
            activeWriterRunId: entry?.activeWriterRunId,
          };
          const resolvedParams = {
            ...params,
            abortSignal: params.abortSignal
              ? AbortSignal.any([operationSignal, params.abortSignal])
              : operationSignal,
            sessionEntry: entry ? projectExecutionSessionEntry(entry) : undefined,
            agentHarnessId: resolveSessionPinnedHarnessId(entry) ?? params.agentHarnessId,
            modelSelectionLocked: entry?.modelSelectionLocked ?? params.modelSelectionLocked,
            agentId: runtimeTarget.agentId,
            sessionId: runtimeTarget.sessionId,
            sessionKey: runtimeTarget.sessionKey,
            sessionTarget: runtimeTarget,
            sessionFile: runtimeTarget.sessionKey,
            spawnedBy: normalizeOptionalString(params.spawnedBy) ?? entry?.spawnedBy,
            contextEngineAgentId,
          };
          if (resolvedParams.trigger !== "manual") {
            return await withQueuedCompactionCancellationResult(resolvedParams, () =>
              compactEmbeddedAgentSessionImpl(
                resolvedParams,
                expectedEntry,
                host,
                contextEngineSessionKey,
              ),
            );
          }
          // The native compactor borrows this turn and must not overlap its attached writer.
          const attachment = operation
            ? getSessionControllerEntryForOperation(operation).attachment
            : undefined;
          if (attachment && "handle" in attachment) {
            return manualCompactionActiveRunFailure();
          }

          const activeParams = {
            ...resolvedParams,
            abortSignal: attachManualCompactionRun(resolvedParams, operation, onSettled),
          };
          return await withQueuedCompactionCancellationResult(activeParams, () =>
            compactEmbeddedAgentSessionImpl(
              activeParams,
              expectedEntry,
              host,
              contextEngineSessionKey,
            ),
          );
        },
      ),
    );
  });
}

async function compactEmbeddedAgentSessionImpl(
  inputParams: QueuedCompactionParams,
  expectedEntry: Parameters<typeof acceptCompactionSuccessor>[0]["expectedEntry"],
  sourceHost: QueuedCompactionHostOptions,
  contextEngineSessionKey?: string,
): Promise<EmbeddedAgentCompactResult> {
  return await runForegroundCompactionWork(async (owner) => {
    if (inputParams.abortSignal?.aborted) {
      return createQueuedCompactionAbortedResult();
    }
    sourceHost.assertActive?.();
    const runtimeTarget = inputParams.sessionTarget;
    const agentIds = resolveSessionAgentIds({
      sessionKey: runtimeTarget.sessionKey,
      config: inputParams.config,
      agentId: runtimeTarget.agentId,
    });
    const initialAgentDir =
      inputParams.agentDir ?? resolveAgentDir(inputParams.config ?? {}, agentIds.sessionAgentId);
    const resolvedWorkspaceDir = resolveUserPath(inputParams.workspaceDir);
    using placement =
      inputParams.sandbox === undefined
        ? await prepareSessionPlacementSandbox({
            agentId: runtimeTarget.agentId,
            config: inputParams.config,
            sessionId: runtimeTarget.sessionId,
            sessionKey: runtimeTarget.sessionKey,
            workspaceDir: resolvedWorkspaceDir,
          })
        : null;
    const assertActive = composeSessionSourceAssertion(
      [sourceHost.assertActive],
      (assertSource) => {
        assertSource();
        placement?.assertCurrent();
      },
    );
    const host = {
      ...sourceHost,
      assertActive,
      sourceAuthority: {
        ...sourceHost.sourceAuthority,
        assertActive: composeSessionSourceAssertion([
          sourceHost.sourceAuthority.assertActive,
          assertActive,
        ]),
      },
    };
    const placementSandbox = placement?.sandbox;
    assertQueuedCompactionPreparationActive(inputParams, host);
    const requestedSelection = {
      ...inputParams,
      modelId: inputParams.model,
      boundHarnessRuntime: inputParams.agentHarnessId,
      preparedRuntimePlan: inputParams.runtimePlan,
      selectedHarnessRuntime: resolveSessionPinnedHarnessId(inputParams.sessionEntry),
    };
    const runtimeSelection = resolveCompactionRuntimeSelection(requestedSelection);
    // Native control operations reuse the backend's existing authenticated session.
    // Run them before generic model preparation so subscription-only CLI sessions do
    // not incorrectly require an OpenClaw model API credential.
    const nativeCliResult = await compactNativeCliSession({
      runtime: runtimeSelection.selectedHarnessRuntime,
      replyOperation: host.replyOperation,
      compactParams: {
        ...inputParams,
        agentDir: initialAgentDir,
        workspaceDir: resolvedWorkspaceDir,
      },
      runControlOperation: (run) =>
        runPrimaryNativeCompactionInLanes(inputParams, expectedEntry, host, run),
    });
    if (nativeCliResult) {
      return nativeCliResult;
    }
    assertQueuedCompactionPreparationActive(inputParams, host);
    // Compaction admits new work even when an engine restores a predecessor context.
    // Keep caller authority, but select metadata from the committed inventory.
    const lease = await runOutsidePluginRuntimeGenerationScope(() =>
      acquireAgentRunPreparedModelRuntime(
        {
          config: inputParams.config ?? {},
          agentId: agentIds.sessionAgentId,
          agentDir: initialAgentDir,
          workspaceDir: resolvedWorkspaceDir,
          ...(inputParams.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
        },
        {
          abortSignal: inputParams.abortSignal,
          deriveRuntimePluginSelections: ({ config, metadataSnapshot }) => {
            const selected = resolveCompactionRuntimeSelection({
              ...requestedSelection,
              config,
              manifestPlugins: metadataSnapshot,
              allowPluginNormalization: false,
            });
            return [
              {
                provider: selected.provider,
                modelId: selected.modelId,
                runtime: selected.selectedHarnessRuntime,
                agentId: agentIds.sessionAgentId,
              },
            ];
          },
        },
      ),
    );
    const factoryResources = owner.adoptLease(lease);
    // Admission can replace config and agent storage while preserving the requested workspace.
    const admittedParams = {
      ...inputParams,
      ...(placementSandbox ? { sandbox: placementSandbox } : {}),
      memorySandboxed: (placementSandbox ?? inputParams.sandbox)?.enabled === true,
      config: lease.snapshot.config,
      agentDir: lease.snapshot.agentDir,
    };
    assertQueuedCompactionPreparationActive(inputParams, host);
    return await withPluginRuntimeGenerationScope(lease.snapshot, async () => {
      owner.captureContext();
      await ensureContextEnginesInitialized();
      const contextEngine = await owner.resolveEngine(() =>
        resolveContextEngine(admittedParams.config, {
          agentDir: admittedParams.agentDir,
          workspaceDir: resolvedWorkspaceDir,
        }),
      );
      assertQueuedCompactionPreparationActive(admittedParams, host);
      const params = admittedParams;
      const agentDir = params.agentDir;
      const preparedModelRuntime = lease.snapshot;
      const lockedHarnessRuntime = resolveSessionPinnedHarnessId(params.sessionEntry);
      if (lockedHarnessRuntime === "auto") {
        return lockedCompactionRuntimeFailure();
      }
      // A concrete model lock does not pin the observed or requested runtime. Only
      // durable native ownership can forbid a prepared transport's host fallback.
      const {
        runtimePolicySessionKey,
        runtimePolicyAgentId,
        selectedHarnessRuntime,
        target: resolvedCompactionTarget,
        runtimeModelAuth: { plan: reusableRuntimeAuthPlan, modelAuth: initialModelAuth },
        provider: ceProvider,
        runtimeProvider: ceRuntimeProvider,
        contextConfigProvider: ceContextConfigProvider,
        modelId: ceModelId,
        attemptNativeHarnessCompaction: selectedNativeHarnessCompaction,
      } = resolveCompactionRuntimeSelection({
        ...params,
        modelId: params.model,
        boundHarnessRuntime: params.agentHarnessId,
        preparedRuntimePlan: params.runtimePlan,
        selectedHarnessRuntime: lockedHarnessRuntime,
      });
      const lockedNativeHarness = Boolean(
        lockedHarnessRuntime && lockedHarnessRuntime !== "openclaw",
      );
      // Ensure the policy-selected harness plugin so selection can pick implicit codex.
      await ensureSelectedAgentHarnessPlugin({
        config: params.config,
        provider: ceProvider,
        modelId: ceModelId,
        agentId: runtimePolicyAgentId,
        sessionKey: runtimePolicySessionKey,
        agentHarnessId: params.agentHarnessId,
        agentHarnessRuntimeOverride: selectedHarnessRuntime,
        workspaceDir: resolvedWorkspaceDir,
        pluginRegistry: requireActivePluginRegistry(),
      });
      assertQueuedCompactionPreparationActive(params, host);
      const { resolution: modelResolution } = await resolveTieredModel({
        abortSignal: params.abortSignal,
        provider: ceRuntimeProvider,
        modelId: ceModelId,
        agentDir,
        config: params.config,
        workspaceDir: resolvedWorkspaceDir,
        ...initialModelAuth,
        preparedModelRuntime,
      });
      assertQueuedCompactionPreparationActive(params, host);
      const { model: ceRuntimeModel, authStorage, modelRegistry } = modelResolution;
      // Stock compaction prepares auth inside its fallback owner. Checking the primary
      // here would reject a cooled profile before that owner can select a healthy model.
      const preparedAuth =
        contextEngine.info.ownsCompaction || selectedNativeHarnessCompaction
          ? await prepareCompactionHarnessAuth({
              ...params,
              provider: ceProvider,
              metadataProvider: ceRuntimeProvider,
              modelId: ceModelId,
              model: ceRuntimeModel,
              reusableRuntimeAuthPlan,
              agentDir,
              workspaceDir: resolvedWorkspaceDir,
              authProfileId: resolvedCompactionTarget.authProfileId,
              runtimePolicyAgentId,
              runtimePolicySessionKey,
              agentHarnessRuntimeOverride: selectedHarnessRuntime,
              convergenceErrorPrefix: "Prepared queued compaction",
            })
          : undefined;
      assertQueuedCompactionPreparationActive(params, host);
      if (preparedAuth?.ok === false) {
        return buildCompactionFailureResult(formatErrorMessage(preparedAuth.error));
      }
      const preparedHarnessRuntime =
        preparedAuth?.selectedPreparedHarness.id ?? selectedHarnessRuntime;
      const attemptNativeHarnessCompaction =
        selectedNativeHarnessCompaction && preparedHarnessRuntime !== "openclaw";
      const runtimeAuthPlan = preparedAuth?.runtimeAuthPreparation.plan ?? reusableRuntimeAuthPlan;
      const effectiveRuntimeModel = runtimeAuthPlan
        ? await materializePreparedRuntimeModel<ProviderRuntimeModel>({
            plan: runtimeAuthPlan,
            provider: ceProvider,
            modelId: ceModelId,
            config: params.config,
            workspaceDir: resolvedWorkspaceDir,
            metadataSnapshot: preparedModelRuntime.metadataSnapshot,
            model: ceRuntimeModel,
            forceResolve:
              preparedAuth?.providerUsesProfileScopedModelMetadata &&
              Boolean(runtimeAuthPlan.selectedAuthMode),
            resolveModel: async ({ config, authProfileId, authProfileMode }) => {
              const resolved = await resolveModelAsync(
                ceRuntimeProvider,
                ceModelId,
                agentDir,
                config,
                {
                  abortSignal: params.abortSignal,
                  authStorage,
                  modelRegistry,
                  preparedModelRuntime,
                  skipAgentDiscovery: true,
                  allowBundledStaticCatalogFallback: true,
                  workspaceDir: resolvedWorkspaceDir,
                  authProfileId,
                  authProfileMode,
                },
              );
              assertQueuedCompactionPreparationActive(params, host);
              return resolved;
            },
          })
        : ceRuntimeModel;
      assertQueuedCompactionPreparationActive(params, host);
      const preparedParams: QueuedCompactionParams = {
        ...params,
        provider: ceProvider,
        model: ceModelId,
        agentHarnessId: preparedHarnessRuntime,
        ...(reusableRuntimeAuthPlan
          ? {
              authProfileId: runtimeAuthPlan?.forwardedAuthProfileId,
              authProfileIdSource: runtimeAuthPlan?.forwardedAuthProfileSource,
              runtimeAuthPlan,
            }
          : {
              // The executing owner resolves the full attempt set; forwarding one
              // generated plan would collapse cross-route and direct fallback.
              authProfileId: resolvedCompactionTarget.authProfileId,
              authProfileIdSource: resolvedCompactionTarget.authProfileId
                ? params.authProfileIdSource
                : undefined,
              runtimeAuthPlan: undefined,
              runtimePlan: undefined,
            }),
      };
      const contextTokenBudget = resolveCompactionContextTokenBudget({
        config: params.config,
        provider: ceContextConfigProvider,
        modelId: ceModelId,
        model: effectiveRuntimeModel,
        requestedTokenBudget: params.contextTokenBudget,
      });
      const { sessionFile: _sessionFile, contextEngineAgentId, ...runtimeParams } = preparedParams;
      const contextEngineRuntimeContext: ContextEngineRuntimeContext = {
        ...runtimeParams,
        sessionTarget: projectQueuedCompactionSessionTarget(preparedParams),
        ...buildEmbeddedCompactionRuntimeContext({
          ...preparedParams,
          agentDir,
          modelId: preparedParams.model,
          harnessRuntime: preparedHarnessRuntime,
        }),
        ...resolveContextEngineCapabilities({
          config: preparedParams.config,
          sessionKey: contextEngineSessionKey ?? preparedParams.sessionKey,
          explicitAgentId: contextEngineAgentId,
          authProfileId: preparedParams.authProfileId,
          contextEnginePluginId: resolveContextEngineOwnerPluginId(contextEngine),
          purpose: "context-engine.compaction",
        }),
        tokenBudget: contextTokenBudget,
        currentTokenCount: preparedParams.currentTokenCount,
      };
      const contextEngineRuntimeSettings = buildContextEngineRuntimeSettings({
        contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
        provider: ceProvider,
        requestedModel: params.model,
        resolvedModel: ceModelId,
        selectedContextEngineId: contextEngine.info.id,
        contextEngineSelectionSource: contextEngine.info.id === "legacy" ? "default" : "configured",
        promptTokenBudget: contextTokenBudget,
      });
      const contextEngineOwnsCompaction = contextEngine.info.ownsCompaction === true;
      let requiredPreflightNativeCapabilityUsed = false;
      const harnessResult =
        attemptNativeHarnessCompaction && (!contextEngineOwnsCompaction || lockedNativeHarness)
          ? await runPrimaryNativeCompactionInLanes(
              preparedParams,
              expectedEntry,
              host,
              async () => {
                if (params.abortSignal?.aborted) {
                  return createQueuedCompactionAbortedResult();
                }
                return await maybeCompactAgentHarnessSession(
                  {
                    ...preparedParams,
                    runtimeModel: effectiveRuntimeModel,
                    contextEngine,
                    contextTokenBudget,
                    contextEngineRuntimeContext,
                  },
                  {
                    preparedModelRuntime,
                    sourceAuthority: host.sourceAuthority,
                    ...(preparedParams.preflightRequired === true
                      ? {
                          nativeCompactionRequest: "required_preflight",
                          onNativeCompactionCapabilityUsed: () => {
                            requiredPreflightNativeCapabilityUsed = true;
                          },
                        }
                      : {}),
                  },
                );
              },
            )
          : undefined;
      // Only the private dispatched native capability may authorize required-preflight
      // fallback for a locked harness; public result fields cannot escape the lock.
      if (
        lockedNativeHarness &&
        !(
          preparedParams.preflightRequired === true &&
          requiredPreflightNativeCapabilityUsed &&
          isRecoverableNativeHarnessBindingFailure(harnessResult)
        )
      ) {
        return harnessResult ?? lockedCompactionRuntimeFailure(selectedHarnessRuntime);
      }
      if (harnessResult) {
        if (!isRecoverableNativeHarnessBindingFailure(harnessResult)) {
          return { ...harnessResult, compactionKind: "native-harness" };
        }
        log.warn(
          `native harness compaction could not use its session binding; falling back to context engine: ${harnessResult.reason ?? "unknown"}`,
        );
      }
      if (params.abortSignal?.aborted) {
        return createQueuedCompactionAbortedResult();
      }
      host.assertActive?.();
      // Budget maintenance may outlive reply preflight only when its engine owns
      // the transcript and explicitly supports background turn maintenance.
      if (
        preparedParams.deferOwningContextEngineCompaction === true &&
        preparedParams.trigger === "budget" &&
        contextEngineOwnsCompaction &&
        contextEngine.info.turnMaintenanceMode === "background" &&
        typeof contextEngine.maintain === "function"
      ) {
        let deferredScheduled = false;
        let deferredScheduleFailure: unknown;
        try {
          await runContextEngineMaintenance({
            contextEngine,
            sessionId: preparedParams.sessionId,
            sessionKey: contextEngineSessionKey ?? preparedParams.sessionKey,
            sessionTarget: projectQueuedCompactionSessionTarget(preparedParams),
            sessionFile: preparedParams.sessionFile,
            reason: "turn",
            runtimeContext: contextEngineRuntimeContext,
            runtimeSettings: contextEngineRuntimeSettings,
            config: preparedParams.config,
            contextEngineAgentId: preparedParams.contextEngineAgentId,
            disposeDeferredContextEngineAfterMaintenance: true,
            factoryResources,
            onDeferredMaintenance: () => {
              deferredScheduled = true;
              owner.transferEngine();
            },
            onDeferredMaintenanceFailure: (error) => {
              deferredScheduleFailure = error;
            },
          });
        } catch (err) {
          log.warn("failed to defer context-engine budget compaction", {
            errorMessage: formatErrorMessage(err),
          });
        }
        if (!deferredScheduled || deferredScheduleFailure) {
          log.warn(
            `[compaction] failed to schedule context-engine-owned budget compaction background maintenance ` +
              `(sessionKey=${preparedParams.sessionKey ?? preparedParams.sessionId}` +
              `${deferredScheduleFailure ? ` error=${formatErrorMessage(deferredScheduleFailure)}` : ""})`,
          );
          return buildCompactionFailureResult(
            "failed to schedule background context-engine maintenance",
            { reason: "deferred_compaction_not_scheduled" },
          );
        }
        log.info(
          `[compaction] deferred context-engine-owned budget compaction to background maintenance ` +
            `(sessionKey=${preparedParams.sessionKey ?? preparedParams.sessionId} ` +
            `scheduled=${String(deferredScheduled)})`,
        );
        return {
          ok: true,
          compacted: false,
          reason: DEFERRED_CONTEXT_ENGINE_COMPACTION_REASON,
        };
      }
      return await executeQueuedContextEngineCompaction({
        params,
        preparedParams,
        runtimeTarget,
        expectedEntry,
        host,
        contextEngine,
        contextEngineSessionKey,
        contextEngineRuntimeContext,
        contextEngineRuntimeSettings,
        resolvedWorkspaceDir,
        preparedModelRuntime,
        effectiveRuntimeModel,
        preparedHarnessRuntime,
        contextTokenBudget,
        attemptNativeHarnessCompaction,
      });
    });
  });
}
