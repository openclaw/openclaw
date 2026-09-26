/**
 * Queues embedded-agent session compaction onto the correct command lane.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  loadSessionEntryReadOnly,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import {
  resolveContextEngine,
  resolveContextEngineOwnerPluginId,
} from "../../context-engine/registry.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import {
  runOutsidePluginRuntimeGenerationScope,
  withPluginRuntimeGenerationScope,
} from "../../plugins/runtime/generation-scope.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import { resolveUserPath } from "../../utils.js";
import { resolveAgentDir, resolveSessionAgentIds } from "../agent-scope.js";
import { isRecoverableNativeHarnessBindingFailure } from "../harness/compaction-recovery.js";
import { maybeCompactAgentHarnessSession } from "../harness/compaction.js";
import { retainAgentHarnessCompactionSource } from "../harness/host-source-authority.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import {
  acquireAgentRunPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
} from "../prepared-model-runtime.js";
import { resolveAgentRunSessionTarget } from "../run-session-target.js";
import { materializePreparedRuntimeModel } from "../runtime-plan/materialize-model.js";
import type { SandboxContext } from "../sandbox/types.js";
import { beginForegroundSessionMaintenance } from "../session-maintenance/coordinator.js";
import { resolveSessionPlacementSandbox } from "../session-placement-admission.js";
import {
  lockedCompactionRuntimeFailure,
  MANUAL_COMPACTION_ACTIVE_RUN_REASON,
} from "./compact-reasons.js";
import { prepareManualTranscriptByteCompaction } from "./compact.accounting.js";
import { deferOwningContextEngineBudgetCompaction } from "./compact.deferred-context-engine.js";
import {
  resolveManualCompactionActiveRunSessionId,
  runForegroundCompactionWork,
  type ForegroundCompactionOwner,
} from "./compact.foreground-work.js";
import { compactNativeCliSession } from "./compact.js";
import {
  createQueuedCompactionAbortedResult,
  projectQueuedCompactionSessionTarget,
  executeQueuedContextEngineCompaction,
  runPrimaryNativeCompactionInLanes,
  type QueuedCompactionHostOptions,
  withQueuedCompactionCancellationResult,
} from "./compact.queued-execution.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import {
  buildEmbeddedCompactionRuntimeContext,
  resolveCompactionContextTokenBudget,
} from "./compaction-runtime-context.js";
import {
  prepareCompactionHarnessAuth,
  projectCodexHostTranscriptBytePreflightConfig,
  resolveCompactionRuntimeSelection,
} from "./compaction-runtime-preparation.js";
import type { acceptCompactionSuccessor } from "./compaction-successor.js";
import { resolveContextEngineCapabilities } from "./context-engine-capabilities.js";
import type { ContextEngineMaintenanceResources } from "./context-engine-maintenance-work.js";
import { log } from "./logger.js";
import { resolveTieredModel } from "./model-resolution.js";
import { resolveModelAsync } from "./model.js";
import type { EmbeddedAgentQueueHandle } from "./run-state.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "./runs.js";
import { resolveTranscriptBytePreflightAuthority } from "./transcript-byte-preflight-authority.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

type QueuedCompactionParams = CompactEmbeddedAgentSessionParams & {
  sessionTarget: SessionTranscriptRuntimeTarget;
  sandbox?: SandboxContext | null;
};

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
  return await runWithAsyncWorkResources(async (onAcquired) => {
    const releaseSource = retainAgentHarnessCompactionSource(options.sourceAuthority);
    onAcquired({ release: releaseSource, releaseBeforeResultWhenIdle: true });
    const sourceAuthority = options.sourceAuthority;
    const assertHostActive = options.assertActive;
    const host = {
      ...options,
      assertActive: () => {
        assertHostActive?.();
        sourceAuthority.assertActive();
        sourceAuthority.operatorAuthority?.assertCurrent();
      },
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
    const runtimeTarget = await resolveAgentRunSessionTarget({
      ...params,
      missingSessionKey: "resolve-existing",
    });
    const releaseForeground =
      params.trigger === "manual"
        ? await beginForegroundSessionMaintenance(runtimeTarget.sessionKey)
        : undefined;
    try {
      // Resolve the storage address first, then freeze its owner before runtime/plugin awaits.
      const entry = loadSessionEntryReadOnly({ ...runtimeTarget, readConsistency: "latest" });
      const expectedEntry = {
        sessionId: runtimeTarget.sessionId,
        lifecycleRevision: entry?.lifecycleRevision,
        activeWriterRunId: entry?.activeWriterRunId,
      };
      const agentHarnessId = resolveSessionPinnedHarnessId(entry) ?? params.agentHarnessId;
      const prepared = await prepareManualTranscriptByteCompaction(
        { ...params, agentHarnessId },
        host,
        runtimeTarget,
        entry,
        resolveCompactionRuntimeSelection({
          ...params,
          ...runtimeTarget,
          modelId: params.model,
          modelSelectionLocked: entry?.modelSelectionLocked ?? params.modelSelectionLocked,
          boundHarnessRuntime: agentHarnessId,
          preparedRuntimePlan: params.runtimePlan,
          allowPluginNormalization: false,
        }).selectedHarnessRuntime,
      );
      assertQueuedCompactionPreparationActive(params, host);
      const projectedConfig = projectCodexHostTranscriptBytePreflightConfig(
        prepared.params.config,
        Boolean(prepared.host.transcriptBytePreflightHarness),
      );
      const resolvedParams = {
        ...prepared.params,
        config: projectedConfig,
        sessionEntry: entry ? projectPublicSessionEntry(entry) : undefined,
        agentHarnessId,
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
            prepared.host,
            contextEngineSessionKey,
          ),
        );
      }
      // Reply operations and embedded handles are separate lifecycle owners. A
      // /compact reply may coexist with this handle, but another embedded writer may not.
      if (resolveManualCompactionActiveRunSessionId(resolvedParams)) {
        return {
          ok: false,
          compacted: false,
          reason: MANUAL_COMPACTION_ACTIVE_RUN_REASON,
          failure: { reason: "active_run" },
        };
      }

      const controller = new AbortController();
      const abortSignal = resolvedParams.abortSignal
        ? AbortSignal.any([resolvedParams.abortSignal, controller.signal])
        : controller.signal;
      const handle: EmbeddedAgentQueueHandle = {
        kind: "embedded",
        queueMessage: async () => {},
        isStreaming: () => true,
        isAborted: () => abortSignal.aborted,
        isCompacting: () => true,
        abort: (reason) => controller.abort(reason ?? "user_abort"),
        cancel: (reason) => controller.abort(reason ?? "user_abort"),
      };
      const activeParams = { ...resolvedParams, abortSignal };
      setActiveEmbeddedRun(
        resolvedParams.sessionId,
        handle,
        resolvedParams.sessionKey,
        resolvedParams.sessionFile,
        resolvedParams.agentId,
      );
      try {
        return await withQueuedCompactionCancellationResult(activeParams, () =>
          compactEmbeddedAgentSessionImpl(
            activeParams,
            expectedEntry,
            prepared.host,
            contextEngineSessionKey,
          ),
        );
      } finally {
        clearActiveEmbeddedRun(
          resolvedParams.sessionId,
          handle,
          resolvedParams.sessionKey,
          resolvedParams.sessionFile,
        );
      }
    } finally {
      releaseForeground?.();
    }
  });
}

async function compactEmbeddedAgentSessionImpl(
  params: QueuedCompactionParams,
  expectedEntry: Parameters<typeof acceptCompactionSuccessor>[0]["expectedEntry"],
  host: QueuedCompactionHostOptions,
  contextEngineSessionKey?: string,
): Promise<EmbeddedAgentCompactResult> {
  return await runForegroundCompactionWork((owner) =>
    compactEmbeddedAgentSessionPrepared(
      params,
      expectedEntry,
      host,
      contextEngineSessionKey,
      owner,
    ),
  );
}

async function compactEmbeddedAgentSessionPrepared(
  params: QueuedCompactionParams,
  expectedEntry: Parameters<typeof acceptCompactionSuccessor>[0]["expectedEntry"],
  host: QueuedCompactionHostOptions,
  contextEngineSessionKey: string | undefined,
  owner: ForegroundCompactionOwner,
): Promise<EmbeddedAgentCompactResult> {
  if (params.abortSignal?.aborted) {
    return createQueuedCompactionAbortedResult();
  }
  host.assertActive?.();
  const runtimeTarget = params.sessionTarget;
  const agentIds = resolveSessionAgentIds({
    sessionKey: runtimeTarget.sessionKey,
    config: params.config,
    agentId: runtimeTarget.agentId,
  });
  const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, agentIds.sessionAgentId);
  const resolvedWorkspaceDir = resolveUserPath(params.workspaceDir);
  const placementSandbox =
    params.sandbox === undefined
      ? await resolveSessionPlacementSandbox({
          agentId: runtimeTarget.agentId,
          config: params.config,
          sessionId: runtimeTarget.sessionId,
          sessionKey: runtimeTarget.sessionKey,
          workspaceDir: resolvedWorkspaceDir,
        })
      : null;
  assertQueuedCompactionPreparationActive(params, host);
  const requestedSelection = {
    ...params,
    modelId: params.model,
    boundHarnessRuntime: params.agentHarnessId,
    preparedRuntimePlan: params.runtimePlan,
    selectedHarnessRuntime: resolveSessionPinnedHarnessId(params.sessionEntry),
  };
  const runtimeSelection = resolveCompactionRuntimeSelection(requestedSelection);
  // Native control operations reuse the backend's existing authenticated session.
  // Run them before generic model preparation so subscription-only CLI sessions do
  // not incorrectly require an OpenClaw model API credential.
  const nativeCliResult = await compactNativeCliSession({
    runtime: runtimeSelection.selectedHarnessRuntime,
    compactParams: {
      ...params,
      agentDir,
      workspaceDir: resolvedWorkspaceDir,
    },
    runControlOperation: (run) =>
      runPrimaryNativeCompactionInLanes(params, expectedEntry, host, run),
  });
  if (nativeCliResult) {
    return nativeCliResult;
  }
  assertQueuedCompactionPreparationActive(params, host);
  // Compaction admits new work even when an engine restores a predecessor context.
  // Keep caller authority, but select metadata from the committed inventory.
  const lease = await runOutsidePluginRuntimeGenerationScope(() =>
    acquireAgentRunPreparedModelRuntime(
      {
        config: params.config ?? {},
        agentId: agentIds.sessionAgentId,
        agentDir,
        workspaceDir: resolvedWorkspaceDir,
        ...(params.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
      },
      {
        abortSignal: params.abortSignal,
        deriveRuntimePluginSelections: ({ config, metadataSnapshot }) => {
          const selected = resolveCompactionRuntimeSelection({
            ...requestedSelection,
            config: projectCodexHostTranscriptBytePreflightConfig(
              config,
              Boolean(host.transcriptBytePreflightHarness),
            ),
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
  const preparedParams = {
    ...params,
    ...(placementSandbox ? { sandbox: placementSandbox } : {}),
    config: projectCodexHostTranscriptBytePreflightConfig(
      lease.snapshot.config,
      Boolean(host.transcriptBytePreflightHarness),
    ),
    agentDir: lease.snapshot.agentDir,
  };
  const run = async () => {
    owner.captureContext();
    ensureContextEnginesInitialized();
    const contextEngine = await owner.resolveEngine(() =>
      resolveContextEngine(preparedParams.config, {
        agentDir: preparedParams.agentDir,
        workspaceDir: resolvedWorkspaceDir,
      }),
    );
    assertQueuedCompactionPreparationActive(params, host);
    return await compactResolvedContextEngine(
      preparedParams,
      expectedEntry,
      host,
      contextEngine,
      preparedParams.agentDir,
      resolvedWorkspaceDir,
      lease.snapshot,
      contextEngineSessionKey,
      owner.transferEngine,
      factoryResources,
    );
  };
  assertQueuedCompactionPreparationActive(params, host);
  return await withPluginRuntimeGenerationScope(lease.snapshot, run);
}

async function compactResolvedContextEngine(
  params: QueuedCompactionParams,
  expectedEntry: Parameters<typeof acceptCompactionSuccessor>[0]["expectedEntry"],
  host: QueuedCompactionHostOptions,
  contextEngine: ContextEngine,
  agentDir: string,
  resolvedWorkspaceDir: string,
  preparedModelRuntime: PreparedModelRuntimeSnapshot,
  contextEngineSessionKey: string | undefined,
  transferContextEngineOwnership: (completion: Promise<void>) => void,
  factoryResources: ContextEngineMaintenanceResources,
): Promise<EmbeddedAgentCompactResult> {
  const runtimeTarget = params.sessionTarget;
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
  const lockedNativeHarness = Boolean(lockedHarnessRuntime && lockedHarnessRuntime !== "openclaw");
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
  const { model: ceModel, authStorage, modelRegistry } = modelResolution;
  const ceRuntimeModel = ceModel as ProviderRuntimeModel | undefined;
  // Overrides stay unset when no bound/planned/explicit harness resolved so auth-aware
  // selection can pick the credential-owning harness (codex for ChatGPT OAuth).
  const preparedAuth = await prepareCompactionHarnessAuth({
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
  });
  assertQueuedCompactionPreparationActive(params, host);
  if (!preparedAuth.ok) {
    return { ok: false, compacted: false, reason: formatErrorMessage(preparedAuth.error) };
  }
  const {
    runtimeAuthPreparation,
    selectedPreparedHarness,
    providerUsesProfileScopedModelMetadata,
  } = preparedAuth;
  const preparedHarnessRuntime = selectedPreparedHarness.id;
  const transcriptBytePreflightAuthority =
    host.transcriptBytePreflightHarness === preparedHarnessRuntime
      ? resolveTranscriptBytePreflightAuthority(selectedPreparedHarness)
      : undefined;
  if (host.transcriptBytePreflightHarness && !transcriptBytePreflightAuthority) {
    return lockedCompactionRuntimeFailure(host.transcriptBytePreflightHarness);
  }
  const attemptNativeHarnessCompaction =
    selectedNativeHarnessCompaction && preparedHarnessRuntime !== "openclaw";
  const runtimeAuthPlan = runtimeAuthPreparation.plan;
  const effectiveRuntimeModel = await materializePreparedRuntimeModel<ProviderRuntimeModel>({
    plan: runtimeAuthPlan,
    provider: ceProvider,
    modelId: ceModelId,
    config: params.config,
    workspaceDir: resolvedWorkspaceDir,
    metadataSnapshot: preparedModelRuntime.metadataSnapshot,
    model: ceRuntimeModel,
    forceResolve:
      providerUsesProfileScopedModelMetadata && Boolean(runtimeAuthPlan.selectedAuthMode),
    resolveModel: async ({ config, authProfileId, authProfileMode }) => {
      const resolved = await resolveModelAsync(ceRuntimeProvider, ceModelId, agentDir, config, {
        abortSignal: params.abortSignal,
        authStorage,
        modelRegistry,
        preparedModelRuntime,
        skipAgentDiscovery: true,
        allowBundledStaticCatalogFallback: true,
        workspaceDir: resolvedWorkspaceDir,
        authProfileId,
        authProfileMode,
      });
      assertQueuedCompactionPreparationActive(params, host);
      return { ...resolved, model: resolved.model as ProviderRuntimeModel | undefined };
    },
  });
  assertQueuedCompactionPreparationActive(params, host);
  const preparedParams: QueuedCompactionParams = {
    ...params,
    provider: ceProvider,
    model: ceModelId,
    agentHarnessId: preparedHarnessRuntime,
    ...(reusableRuntimeAuthPlan
      ? {
          authProfileId: runtimeAuthPlan.forwardedAuthProfileId,
          authProfileIdSource: runtimeAuthPlan.forwardedAuthProfileSource,
          runtimeAuthPlan,
        }
      : {
          // Native compaction resolves this full attempt set itself. Legacy
          // compaction must re-plan too; forwarding one generated plan would
          // collapse cross-route and direct fallback before either dispatch.
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
    agentId: runtimeTarget.agentId,
    requestedTokenBudget: params.contextTokenBudget,
  });
  const contextEngineRuntimeContext = buildCompactionContextEngineRuntimeContext({
    params: preparedParams,
    agentDir,
    harnessRuntime: preparedHarnessRuntime,
    contextEngineSessionKey,
    contextTokenBudget,
    contextEnginePluginId: resolveContextEngineOwnerPluginId(contextEngine),
  });
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
    attemptNativeHarnessCompaction &&
    !transcriptBytePreflightAuthority &&
    (!contextEngineOwnsCompaction || lockedNativeHarness)
      ? await runPrimaryNativeCompactionInLanes(preparedParams, expectedEntry, host, async () => {
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
        })
      : undefined;
  // Only the private dispatched native capability may authorize required-preflight
  // fallback for a locked harness; public result fields cannot escape the lock.
  if (
    lockedNativeHarness &&
    !transcriptBytePreflightAuthority &&
    !(
      preparedParams.preflightRequired === true &&
      requiredPreflightNativeCapabilityUsed &&
      isRecoverableNativeHarnessBindingFailure(harnessResult)
    )
  ) {
    return harnessResult
      ? { ...harnessResult, compactionKind: "native-harness" }
      : lockedCompactionRuntimeFailure(selectedHarnessRuntime);
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
    return await deferOwningContextEngineBudgetCompaction({
      compactParams: preparedParams,
      contextEngineSessionKey,
      contextEngine,
      contextEngineRuntimeContext,
      contextEngineRuntimeSettings,
      onDeferredMaintenance: transferContextEngineOwnership,
      factoryResources,
    });
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
    transcriptBytePreflightAuthority,
  });
}

function buildCompactionContextEngineRuntimeContext(params: {
  params: CompactEmbeddedAgentSessionParams;
  agentDir: string;
  contextEngineSessionKey?: string;
  harnessRuntime?: string;
  contextEnginePluginId?: string;
  contextTokenBudget?: number;
}): ContextEngineRuntimeContext {
  const { sessionFile: _sessionFile, contextEngineAgentId, ...runtimeParams } = params.params;
  return {
    ...runtimeParams,
    sessionTarget: projectQueuedCompactionSessionTarget(params.params),
    ...buildEmbeddedCompactionRuntimeContext({
      ...params.params,
      agentDir: params.agentDir,
      modelId: params.params.model,
      harnessRuntime: params.harnessRuntime,
    }),
    ...resolveContextEngineCapabilities({
      config: params.params.config,
      sessionKey: params.contextEngineSessionKey ?? params.params.sessionKey,
      explicitAgentId: contextEngineAgentId,
      authProfileId: params.params.authProfileId,
      contextEnginePluginId: params.contextEnginePluginId,
      purpose: "context-engine.compaction",
    }),
    tokenBudget: params.contextTokenBudget,
    currentTokenCount: params.params.currentTokenCount,
  };
}
