/** Runs complete model-catalog discovery outside the Gateway event loop. */
import { captureClawInstallSchemaVersionFacts } from "../claws/provenance-runtime-read.js";
import {
  getConfigResolutionFacts,
  serializeConfigResolutionFacts,
} from "../config/resolution-facts.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import { formatErrorMessage } from "../infra/errors.js";
import { WorkerTaskError, WorkerTaskPool } from "../infra/worker-task-pool.js";
import type { Model } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { captureRemoteModelCatalogSnapshot } from "../model-catalog/remote-overlay.js";
import { resolveCodexClientVersion } from "../plugin-sdk/codex-client-version-runtime.js";
import {
  getPluginCacheRetirementSignal,
  getPluginMetadataSnapshotCache,
} from "../plugins/plugin-cache.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { overlayPluginNativeAdmissions } from "../plugins/plugin-native-admission-state.js";
import type { NativeReferenceProgress } from "../plugins/plugin-native-reference.js";
import { captureProviderSyntheticAuthFacts } from "../plugins/provider-runtime.js";
import type { PreparedSyntheticAuthFacts } from "../plugins/provider-synthetic-auth.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { listManifestSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { cloneAuthProfileStore } from "./auth-profiles/clone.js";
import { getPreparedSharedAuthStoreOwnership } from "./auth-profiles/path-resolve.js";
import { PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS } from "./model-catalog-timeouts.js";
import {
  fingerprintPreparedModelCatalogGeneration,
  fingerprintPreparedModelWorkerRequest,
} from "./prepared-model-catalog-fingerprints.js";
import {
  CatalogWorkerTaskPool,
  GATEWAY_CATALOG_WORKERS,
} from "./prepared-model-catalog-worker.pool.js";
import type {
  PreparedModelCatalogWorkerInput,
  PreparedModelCatalogWorkerTask,
  PreparedModelWorkerCommand,
  PreparedModelWorkerResult,
} from "./prepared-model-catalog-worker.types.js";
import {
  PreparedModelCatalogAdmissionStalledError,
  PreparedModelCatalogGenerationMismatchError,
} from "./prepared-model-catalog.errors.js";
import {
  setPreparedModelFullCatalogAuth,
  type PreparedModelRuntimeAuth,
  type PreparedModelRuntimeAuthScope,
} from "./prepared-model-runtime-auth.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogFacts,
} from "./prepared-model-runtime.catalog-contract.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { fingerprintPreparedRuntimeFacts } from "./prepared-model-runtime.facts.js";
import { markPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import { registerPreparedModelRuntimeClose } from "./prepared-model-runtime.lifecycle.js";
import {
  listRegistrySyntheticAuthProviderRefs,
  scopeSyntheticAuthProviderRefs,
} from "./prepared-model-runtime.synthetic-auth.js";
import type { AuthStorageData } from "./sessions/auth-storage.js";

const log = createSubsystemLogger("agents/prepared-model-runtime");
type CatalogPool = WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult>;
type CatalogPoolBorrower = {
  agentDir: string;
  isCurrent: () => boolean;
  notifyRecovery: (error: Error) => void;
  stop: (error: Error) => Promise<void>;
};
const generationMismatchBorrowers = new WeakMap<
  PreparedModelCatalogGenerationMismatchError,
  CatalogPoolBorrower
>();
type GatewayCatalogPool = {
  cache: ReturnType<typeof getPluginMetadataSnapshotCache>;
  pool: CatalogPool;
  envFingerprint: string;
  /** Set before the owner closes the pool; a close without it means the worker failed. */
  closing?: true;
  close: (error?: Error) => Promise<void>;
  borrowers: Set<CatalogPoolBorrower>;
  recovery?: Promise<void>;
  recover: (error: Error, options?: { failedOwner?: CatalogPoolBorrower }) => Promise<void>;
  validate?: (result: PreparedModelWorkerResult) => void;
};
const gatewayCatalog = resolveGlobalSingleton<{
  current?: GatewayCatalogPool;
  rotating?: Promise<void>;
  // Process lifetime: a failed pool is replaced, so the replacement's own counters restart at zero.
  workerFailures?: number;
}>(Symbol.for("openclaw.gatewayModelCatalogPool"), () => ({}));

export function getPreparedModelCatalogWorkerPoolSnapshot() {
  return {
    ...(gatewayCatalog.current?.pool.getSnapshot() ?? {
      maxWorkers: GATEWAY_CATALOG_WORKERS,
      workers: 0,
      workersCreated: 0,
      activeTasks: 0,
      pendingTasks: 0,
    }),
    workerFailures: gatewayCatalog.workerFailures ?? 0,
  };
}

async function getGatewayCatalogPool(
  input: PreparedModelCatalogWorkerInput,
  metadata: PluginMetadataSnapshot,
  environmentFingerprint: string,
): Promise<GatewayCatalogPool> {
  const cache = getPluginMetadataSnapshotCache(metadata);
  getPluginCacheRetirementSignal(cache).throwIfAborted();
  const pending = gatewayCatalog.rotating ?? gatewayCatalog.current?.recovery;
  if (pending) {
    await pending;
    return getGatewayCatalogPool(input, metadata, environmentFingerprint);
  }
  if (gatewayCatalog.current?.cache === cache) {
    if (gatewayCatalog.current.envFingerprint === environmentFingerprint) {
      return gatewayCatalog.current;
    }
    if ([...gatewayCatalog.current.borrowers].some((borrower) => borrower.isCurrent())) {
      throw new Error("Gateway catalog environment changed without retiring its plugin generation");
    }
  }
  if (
    gatewayCatalog.current &&
    [...gatewayCatalog.current.borrowers].some((borrower) => borrower.isCurrent())
  ) {
    throw new Error("Gateway catalog source generation changed before its previous owners retired");
  }
  gatewayCatalog.rotating = (async () => {
    await gatewayCatalog.current?.close();
    const signal = getPluginCacheRetirementSignal(cache);
    signal.throwIfAborted();
    let admissionStalled = false;
    const current: GatewayCatalogPool = {
      cache,
      envFingerprint: environmentFingerprint,
      borrowers: new Set(),
      recover: (error, options) =>
        admissionStalled
          ? Promise.resolve()
          : (current.recovery ??= (async () => {
              const borrowers = [...current.borrowers];
              const affectedBorrowers = options?.failedOwner
                ? borrowers.filter((borrower) => borrower === options.failedOwner)
                : borrowers;
              if (!signal.aborted) {
                for (const borrower of affectedBorrowers) {
                  borrower.notifyRecovery(error);
                }
              }
              // Fence every old catalog before releasing the native slot. Recovery publishes new
              // prepared owners; it never replays a failed request under its former source generation.
              const stopping = affectedBorrowers.map((borrower) => borrower.stop(error));
              await current.close(error);
              await Promise.all(stopping);
              if (gatewayCatalog.current === current) {
                gatewayCatalog.current = undefined;
              }
              if (!options?.failedOwner) {
                const { recoverPreparedModelRuntimeCatalogWorkerAtRuntime } =
                  await import("./prepared-model-runtime.catalog-recovery-runtime.js");
                await recoverPreparedModelRuntimeCatalogWorkerAtRuntime(borrowers);
              }
            })()),
      close: async (error) => {
        current.closing = true;
        signal.removeEventListener("abort", retire);
        await current.pool.close(error);
        current.validate = undefined;
        release();
      },
      validate: undefined,
      pool: new CatalogWorkerTaskPool(
        input.input.env,
        (result) => {
          const validate = current.validate;
          current.validate = undefined;
          validate?.(result);
        },
        () => signal.throwIfAborted(),
        (error) => {
          // Only the pool itself closes without its owner: its worker failed, exited or timed out.
          // Record it now, once per pool; an idle worker's exit has no request to report it.
          if (!current.closing && !signal.aborted) {
            admissionStalled = error instanceof PreparedModelCatalogAdmissionStalledError;
            gatewayCatalog.workerFailures = (gatewayCatalog.workerFailures ?? 0) + 1;
            log.warn(
              `model catalog worker failed; ${admissionStalled ? "native admission will not be retried automatically" : `${[...current.borrowers].filter((borrower) => borrower.isCurrent()).length} agent catalog(s) will be republished on a new worker`} (failure ${gatewayCatalog.workerFailures} since start): ${formatErrorMessage(error)}`,
            );
          }
        },
      ),
    };
    const retire = () => {
      void current.close(signal.reason).catch((error: unknown) => {
        process.emitWarning(`Gateway catalog worker failed to retire: ${String(error)}`);
      });
    };
    // Shutdown can refuse registration; do not expose retirement until release exists.
    const release = registerPreparedModelRuntimeClose(async (error) => {
      await current.close(error);
      if (gatewayCatalog.current === current) {
        gatewayCatalog.current = undefined;
      }
    });
    signal.addEventListener("abort", retire, { once: true });
    gatewayCatalog.current = current;
  })();
  try {
    await gatewayCatalog.rotating;
  } finally {
    gatewayCatalog.rotating = undefined;
  }
  return getGatewayCatalogPool(input, metadata, environmentFingerprint);
}

export function createPreparedModelCatalogWorkerInput(params: {
  agentFacts: PreparedModelRuntimeAgentFacts;
  pluginMetadataSnapshot: PluginMetadataSnapshot;
  preferBuiltPluginArtifacts?: boolean;
}): PreparedModelCatalogWorkerInput {
  const source = params.agentFacts.input;
  // Registries and closures stay process-local. The worker reconstructs them from this exact
  // lifecycle plan and receives only already-materialized auth facts.
  const input: PreparedModelCatalogWorkerInput["input"] = {
    ...(source.agentId ? { agentId: source.agentId } : {}),
    agentDir: source.agentDir,
    ...(source.inheritedAuthDir ? { inheritedAuthDir: source.inheritedAuthDir } : {}),
    ...(source.workspaceDir ? { workspaceDir: source.workspaceDir } : {}),
    ...(source.readOnly ? { readOnly: true } : {}),
    env: { ...params.agentFacts.env },
    ...(source.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
    config: source.config,
  };
  // Capture the authored pair now; structured cloning cannot carry process-local Ref provenance.
  const sourceConfigForSecrets = projectConfigOntoRuntimeSourceSnapshot(source.config);
  const configResolutionFacts = serializeConfigResolutionFacts(source.config);
  const sourceConfigResolutionFacts =
    getConfigResolutionFacts(source.config) === getConfigResolutionFacts(sourceConfigForSecrets)
      ? configResolutionFacts
      : serializeConfigResolutionFacts(sourceConfigForSecrets);
  const { normalizePluginId: _normalizePluginId, ...pluginMetadataSnapshot } =
    params.pluginMetadataSnapshot;
  const cache = getPluginMetadataSnapshotCache(params.pluginMetadataSnapshot);
  const index = overlayPluginNativeAdmissions(pluginMetadataSnapshot.index, cache);
  const sharedAuthStoreOwnership = getPreparedSharedAuthStoreOwnership(params.agentFacts.env);
  const value: Omit<PreparedModelCatalogWorkerInput, "generationFingerprint"> = {
    remoteCatalog: captureRemoteModelCatalogSnapshot(),
    input,
    sourceConfigForSecrets,
    configResolutionFacts,
    sourceConfigResolutionFacts,
    authStore: cloneAuthProfileStore(params.agentFacts.authStore),
    ...(sharedAuthStoreOwnership
      ? { sharedAuthStoreOwnership: { ...sharedAuthStoreOwnership } }
      : {}),
    providerIds: [...params.agentFacts.providerIds],
    catalogFacts: {
      configuredModelRefs: params.agentFacts.configuredModelRefs,
      configuredRuntimeModels: params.agentFacts.configuredRuntimeModels,
    },
    preferBuiltPluginArtifacts: params.preferBuiltPluginArtifacts === true,
    pluginMetadataSnapshot: {
      ...pluginMetadataSnapshot,
      index,
      registryIndex:
        pluginMetadataSnapshot.registryIndex === pluginMetadataSnapshot.index
          ? index
          : overlayPluginNativeAdmissions(pluginMetadataSnapshot.registryIndex, cache),
    },
  };
  return { ...value, generationFingerprint: fingerprintPreparedModelCatalogGeneration(value) };
}

type PreparedModelCatalogWorker = Readonly<{
  loadAuth: (
    scope: PreparedModelRuntimeAuthScope,
    onRecovery?: (error: Error) => void,
  ) => Promise<PreparedModelRuntimeAuth & { credentials: Readonly<AuthStorageData> }>;
  loadCatalog: (
    providerIds?: readonly string[],
    onRecovery?: (error: Error) => void,
    refresh?: boolean,
  ) => Promise<
    Pick<PreparedModelRuntimeCatalogFacts, "modelCatalog" | "configuredRuntimeModels"> & {
      runtimeModels: Map<string, Model[]>;
      providerExpiries: Map<string, number>;
      hookRows: Map<string, Set<string>>;
    }
  >;
}>;

export function createPreparedModelCatalogWorker(
  params: Parameters<typeof createPreparedModelCatalogWorkerInput>[0] & {
    isCurrent: () => boolean;
    retirementSignal: AbortSignal;
    pluginRegistry?: PluginRegistry;
  },
): PreparedModelCatalogWorker {
  const workerInput = createPreparedModelCatalogWorkerInput(params);
  // Parent probes retain the canonical generation; only the worker restores a cloned payload.
  const metadataSnapshot = params.pluginMetadataSnapshot;
  const superseded = () =>
    new PreparedModelRuntimePublicationSupersededError(
      `prepared model runtime catalog generation was superseded for ${workerInput.input.agentDir}`,
    );
  let observingRetirement = false;
  let stoppedError: Error | undefined;
  let releaseProcessLifetime: (() => void) | undefined;
  let expectedFingerprint: string | undefined;
  let pendingAuth:
    | { key: string; promise: ReturnType<PreparedModelCatalogWorker["loadAuth"]> }
    | undefined;
  const captures = new Map<AbortController, Promise<unknown>>();
  const tasks = new Map<
    Promise<PreparedModelWorkerResult>,
    { onRecovery?: (error: Error) => void }
  >();
  const assertCurrent = () => {
    if (stoppedError) {
      throw stoppedError;
    }
    if (!params.isCurrent()) {
      throw superseded();
    }
  };
  // Direct hosts can supply independent process environments; configured Gateway agents share
  // its pinned environment and plugin-inventory lifetime.
  const gatewayOwned =
    params.agentFacts.input.allowGatewaySubagentBinding === true &&
    params.agentFacts.input.env === undefined;
  const environmentFingerprint = fingerprintPreparedRuntimeFacts(workerInput.input.env);
  let pool: CatalogPool | undefined;
  let sharedOwner: GatewayCatalogPool | undefined;
  const mismatch = (
    message: Extract<PreparedModelWorkerResult, { status: "generation-mismatch" }>,
  ) => {
    const error = new PreparedModelCatalogGenerationMismatchError(
      workerInput.input.agentDir,
      message.generationFingerprint,
      message.reconstructedFingerprint,
    );
    generationMismatchBorrowers.set(error, borrower);
    return error;
  };
  const validate = (message: PreparedModelWorkerResult) => {
    if (!gatewayOwned) {
      assertCurrent();
    }
    if (message.status === "generation-mismatch") {
      // Fence before any successor dispatches: rejecting here closes the pool, so a queued
      // auth or catalog request never runs on the retired worker and rejects with this
      // same typed outcome instead of a generic failure.
      throw mismatch(message);
    }
    if (message.status === "ok" && message.generationFingerprint !== expectedFingerprint) {
      throw new Error("prepared model catalog worker returned a stale generation");
    }
  };
  const stop = async (error: Error) => {
    stoppedError ??= error;
    params.retirementSignal.removeEventListener("abort", retire);
    for (const controller of captures.keys()) {
      controller.abort(stoppedError);
    }
    // Native probes live in the parent; drain them before retiring the compute worker.
    await Promise.allSettled(captures.values());
    if (gatewayOwned) {
      await Promise.allSettled(tasks.keys());
    } else {
      await pool?.close(stoppedError);
    }
    sharedOwner?.borrowers.delete(borrower);
    releaseProcessLifetime?.();
    releaseProcessLifetime = undefined;
  };
  const retire = () => {
    // Finish synchronous owner fencing and capture registration before aborting probes.
    queueMicrotask(() => {
      void stop(superseded()).catch((error: unknown) => {
        process.emitWarning(`Prepared model catalog worker failed to retire: ${String(error)}`);
      });
    });
  };
  const borrower: CatalogPoolBorrower = {
    agentDir: workerInput.input.agentDir,
    isCurrent: params.isCurrent,
    notifyRecovery: (error) => {
      if (stoppedError || !params.isCurrent()) {
        return;
      }
      for (const task of tasks.values()) {
        task.onRecovery?.(error);
      }
    },
    stop,
  };
  const request = async (
    command: PreparedModelWorkerCommand,
    onRecovery?: (error: Error) => void,
  ): Promise<Extract<PreparedModelWorkerResult, { status: "ok" }>> => {
    let message: PreparedModelWorkerResult;
    let requestPool: typeof pool;
    let pending: Promise<PreparedModelWorkerResult> | undefined;
    const task: { onRecovery?: (error: Error) => void } = {};
    const controller = new AbortController();
    let progress: NativeReferenceProgress | undefined;
    let expire = () => controller.abort(new WorkerTaskError("worker task timed out", "timeout"));
    const timeout = setTimeout(() => expire(), PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS);
    try {
      assertCurrent();
      releaseProcessLifetime ??= registerPreparedModelRuntimeClose(stop);
      if (!observingRetirement) {
        observingRetirement = true;
        params.retirementSignal.addEventListener("abort", retire, { once: true });
        if (params.retirementSignal.aborted) {
          retire();
        }
      }
      const { input } = workerInput;
      // Worker reconstruction consumes startup auth facts even for a scoped catalog request.
      const providerScope = [...workerInput.providerIds, ...(command.providerIds ?? [])];
      const manifestRefs = listManifestSyntheticAuthProviderRefs(metadataSnapshot.index);
      const capture = withPluginRuntimeGenerationScope(
        { metadataSnapshot, pluginRegistry: params.pluginRegistry },
        () =>
          Promise.all([
            captureProviderSyntheticAuthFacts({
              config: input.config,
              env: input.env,
              workspaceDir: input.workspaceDir,
              providerRefs:
                command.kind === "catalog" && !command.providerIds
                  ? [
                      ...manifestRefs,
                      // Full discovery also runs credential-only providers, whose runtime hooks can
                      // answer for refs no manifest declares (such as the provider's own id). The
                      // closed worker cannot probe those refs, so capture them here.
                      ...listRegistrySyntheticAuthProviderRefs(params.pluginRegistry),
                      ...workerInput.providerIds,
                    ]
                  : [
                      ...providerScope,
                      ...scopeSyntheticAuthProviderRefs(manifestRefs, providerScope),
                    ],
              signal: controller.signal,
            }),
            // Codex turns run in this process, so its binary decision is what discovery reports.
            command.kind === "catalog" &&
            (!command.providerIds || command.providerIds.includes("openai"))
              ? resolveCodexClientVersion({
                  config: input.config,
                  env: input.env,
                  agentDir: input.agentDir,
                })
              : undefined,
          ]),
      );
      captures.set(controller, capture);
      let syntheticAuth: PreparedSyntheticAuthFacts;
      let codexClientVersion: string | undefined;
      try {
        [syntheticAuth, codexClientVersion] = await capture;
      } finally {
        captures.delete(controller);
      }
      controller.signal.throwIfAborted();
      const value = {
        ...command,
        syntheticAuth,
        ...(codexClientVersion ? { codexClientVersion } : {}),
      };
      const shared = gatewayOwned
        ? await getGatewayCatalogPool(workerInput, metadataSnapshot, environmentFingerprint)
        : undefined;
      if (shared) {
        sharedOwner = shared;
        shared.borrowers.add(borrower);
      }
      requestPool = pool =
        shared?.pool ?? pool ?? new CatalogWorkerTaskPool(workerInput.input.env, validate);
      pending = requestPool.run(
        () => {
          assertCurrent();
          // The existing budget now bounds idle admission, renewed only by verified members.
          expire = () => {
            const failure = new PreparedModelCatalogAdmissionStalledError(
              progress?.pluginId,
              PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS,
            );
            borrower.notifyRecovery(failure);
            void requestPool!
              .close(failure)
              .catch((error: unknown) => process.emitWarning(String(error)));
          };
          timeout.refresh();
          task.onRecovery = onRecovery;
          const workerRequest = {
            ...value,
            clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: input.env }),
          };
          expectedFingerprint = fingerprintPreparedModelWorkerRequest(workerInput, workerRequest);
          if (shared) {
            shared.validate = validate;
          }
          return { value: workerInput, request: workerRequest };
        },
        {
          signal: controller.signal,
          onNotification: (notification) => {
            // SAFETY: The native verifier is the sole producer on this task's private channel.
            const next = notification as NativeReferenceProgress;
            if (!progress || next.completed > progress.completed) {
              timeout.refresh();
            }
            progress = next;
          },
          onRequest: async () => {
            clearTimeout(timeout);
            return {
              input: !stoppedError && params.isCurrent(),
              timeoutMs: PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS,
            };
          },
        },
      );
      tasks.set(pending, task);
      message = await pending;
      assertCurrent();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (failure instanceof PreparedModelCatalogAdmissionStalledError) {
        throw failure;
      }
      if (failure instanceof WorkerTaskError && failure.code === "overloaded") {
        // Admission pressure rejects this request without retiring the prepared generation.
        throw failure;
      }
      if (gatewayOwned && requestPool && !requestPool.isClosed && params.isCurrent()) {
        controller.abort(error);
        throw error;
      }
      if (
        gatewayOwned &&
        sharedOwner &&
        sharedOwner.pool.isClosed &&
        !(failure instanceof PreparedModelRuntimePublicationSupersededError)
      ) {
        const failedOwner =
          failure instanceof PreparedModelCatalogGenerationMismatchError
            ? generationMismatchBorrowers.get(failure)
            : undefined;
        await sharedOwner
          .recover(failure, {
            // A typed mismatch must reach the catalog materialization boundary so it can rebuild
            // the exact configured owner from current plugin facts. The generic shared-pool
            // recovery deliberately retains the captured plugin generation, so stop only that
            // owner. Healthy borrowers can bind their existing owners to the replacement pool.
            failedOwner,
          })
          .catch((recoveryError: unknown) => {
            process.emitWarning(`Gateway catalog recovery failed: ${String(recoveryError)}`);
          });
        if (failedOwner && failedOwner !== borrower) {
          controller.abort(error);
          throw error;
        }
      }
      if (!gatewayOwned && failure instanceof PreparedModelCatalogGenerationMismatchError) {
        // Keep the generation open, but retire only this request's pool: a delayed rejection
        // from it must not close a replacement already serving the same lifecycle plan.
        if (pool === requestPool) {
          pool = undefined;
        }
        await requestPool?.close(failure);
        throw failure;
      }
      controller.abort(error);
      await stop(failure);
      throw error;
    } finally {
      task.onRecovery = undefined;
      if (pending) {
        tasks.delete(pending);
      }
      clearTimeout(timeout);
    }
    if (message.status === "failed") {
      throw new Error(message.error);
    }
    if (message.status === "generation-mismatch") {
      // validateResult fences this reply before the pool can resolve it.
      throw mismatch(message);
    }
    return message;
  };

  return {
    loadCatalog: async (providerIds, onRecovery, refresh) => {
      const message = await request({ kind: "catalog", providerIds, refresh }, onRecovery);
      if (message.kind !== "catalog") {
        throw new Error("prepared model catalog worker returned an auth refresh result");
      }
      const modelCatalog = markPreparedModelCatalogFull(message.snapshot);
      setPreparedModelFullCatalogAuth(modelCatalog, {
        authStore: message.authStore,
        authModes: message.authModes,
        credentials: message.credentials,
        providerAuthLabels: message.providerAuthLabels,
      });
      return {
        modelCatalog,
        configuredRuntimeModels: message.configuredRuntimeModels,
        runtimeModels: message.runtimeModels,
        providerExpiries: message.providerExpiries,
        hookRows: message.hookRows,
      };
    },
    loadAuth: async ({ providerIds, profileIds }, onRecovery) => {
      const normalizedProviderIds = [...new Set(providerIds)].toSorted((left, right) =>
        left.localeCompare(right),
      );
      const normalizedProfileIds =
        profileIds && [...new Set(profileIds)].toSorted((left, right) => left.localeCompare(right));
      const key = JSON.stringify([normalizedProviderIds, normalizedProfileIds]);
      if (pendingAuth?.key === key) {
        return pendingAuth.promise;
      }
      const promise = request(
        {
          kind: "auth-refresh",
          providerIds: normalizedProviderIds,
          ...(normalizedProfileIds ? { profileIds: normalizedProfileIds } : {}),
        },
        onRecovery,
      )
        .then((message) => {
          if (message.kind !== "auth-refresh") {
            throw new Error("prepared model auth refresh worker returned a catalog result");
          }
          return {
            authStore: message.authStore,
            authModes: message.authModes,
            credentials: message.credentials,
          };
        })
        .finally(() => {
          if (pendingAuth?.promise === promise) {
            pendingAuth = undefined;
          }
        });
      pendingAuth = { key, promise };
      return promise;
    },
  };
}
