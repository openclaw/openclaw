/** Runs complete model-catalog discovery outside the Gateway event loop. */
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getConfigResolutionFacts,
  serializeConfigResolutionFacts,
} from "../config/resolution-facts.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { WorkerTaskError, WorkerTaskPool } from "../infra/worker-task-pool.js";
import type { Model } from "../llm/types.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import {
  getPluginCacheRetirementSignal,
  getPluginMetadataSnapshotCache,
} from "../plugins/plugin-cache.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { captureProviderSyntheticAuthFacts } from "../plugins/provider-runtime.js";
import type { PreparedSyntheticAuthFacts } from "../plugins/provider-synthetic-auth.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { listManifestSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import { cloneAuthProfileStore } from "./auth-profiles/clone.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ModelCatalogAuthLabels } from "./model-catalog-auth-labels.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
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
import { scopeSyntheticAuthProviderRefs } from "./prepared-model-runtime.synthetic-auth.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";
import type { AuthStorageData } from "./sessions/auth-storage.js";

export type PreparedModelCatalogWorkerInput = Readonly<{
  kind: "catalog";
  generationFingerprint: string;
  input: PreparedModelRuntimeInput & { env: NodeJS.ProcessEnv };
  sourceConfigForSecrets: PreparedModelRuntimeInput["config"];
  configResolutionFacts: ReturnType<typeof serializeConfigResolutionFacts>;
  sourceConfigResolutionFacts: ReturnType<typeof serializeConfigResolutionFacts>;
  authStore: AuthProfileStore;
  providerIds: readonly string[];
  preferBuiltPluginArtifacts: boolean;
  pluginMetadataSnapshot: Omit<PluginMetadataSnapshot, "normalizePluginId">;
}>;

export type PreparedModelCatalogWorkerData = (
  | PreparedModelCatalogWorkerInput
  | { kind: "gateway" }
) & {
  sourceCaptureDirectory: string;
};

export type PreparedModelCatalogWorkerTask = {
  value: PreparedModelCatalogWorkerInput;
  request: PreparedModelWorkerRequest;
};

type PreparedModelWorkerCommand =
  | Readonly<{ kind: "catalog"; providerIds?: readonly string[] }>
  | Readonly<{
      kind: "auth-refresh";
      profileIds?: readonly string[];
      providerIds: readonly string[];
    }>;

export type PreparedModelWorkerRequest = PreparedModelWorkerCommand &
  Readonly<{ syntheticAuth: PreparedSyntheticAuthFacts }>;

export type PreparedModelWorkerResult =
  | Readonly<{
      status: "ok";
      kind: "catalog";
      generationFingerprint: string;
      snapshot: ModelCatalogSnapshot;
      runtimeModels: Map<string, Model[]>;
      providerExpiries: Map<string, number>;
      configuredProviderModelIds: Map<string, readonly string[]>;
      configuredRuntimeModels: PreparedModelRuntimeCatalogFacts["configuredRuntimeModels"];
      credentials: Readonly<AuthStorageData>;
      providerAuthLabels: ModelCatalogAuthLabels;
      authStore: AuthProfileStore;
      authModes: PreparedAgentCredentialModes;
    }>
  | Readonly<{
      status: "ok";
      kind: "auth-refresh";
      generationFingerprint: string;
      authStore: AuthProfileStore;
      authModes: PreparedAgentCredentialModes;
      credentials: Readonly<AuthStorageData>;
    }>
  | Readonly<{
      status: "generation-mismatch";
      generationFingerprint: string;
      reconstructedFingerprint: string;
    }>
  | Readonly<{ status: "failed"; error: string }>;

// Cold source/plugin loading can take well over a minute. Three minutes preserves exact full-view
// discovery while bounding a wedged provider; expiry rejects and never returns partial results.
export const PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS = 180_000;
const PREPARED_MODEL_CATALOG_WORKER_GENERATION_POLL_MS = 25;

const GATEWAY_CATALOG_WORKERS = 1;
type CatalogPoolInput = PreparedModelWorkerRequest | PreparedModelCatalogWorkerTask;
type CatalogPool = WorkerTaskPool<CatalogPoolInput, PreparedModelWorkerResult>;
type CatalogPoolBorrower = {
  agentDir: string;
  isCurrent: () => boolean;
  notifyRecovery: (error: Error) => void;
  stop: (error: Error) => Promise<void>;
};
type GatewayCatalogPool = {
  cache: ReturnType<typeof getPluginMetadataSnapshotCache>;
  pool: CatalogPool;
  envFingerprint: string;
  close: (error?: Error) => Promise<void>;
  borrowers: Set<CatalogPoolBorrower>;
  recovery?: Promise<void>;
  recover: (error: Error) => Promise<void>;
  validate?: (result: PreparedModelWorkerResult) => void;
};
const gatewayCatalog = resolveGlobalSingleton<{
  current?: GatewayCatalogPool;
  rotating?: Promise<void>;
}>(Symbol.for("openclaw.gatewayModelCatalogPool"), () => ({}));

export function getPreparedModelCatalogWorkerPoolSnapshot() {
  return (
    gatewayCatalog.current?.pool.getSnapshot() ?? {
      maxWorkers: GATEWAY_CATALOG_WORKERS,
      workers: 0,
      workersCreated: 0,
      activeTasks: 0,
      pendingTasks: 0,
    }
  );
}

async function getGatewayCatalogPool(
  input: PreparedModelCatalogWorkerInput,
  metadata: PluginMetadataSnapshot,
  environmentFingerprint: string,
): Promise<GatewayCatalogPool> {
  const cache = getPluginMetadataSnapshotCache(metadata);
  getPluginCacheRetirementSignal(cache).throwIfAborted();
  if (gatewayCatalog.rotating) {
    await gatewayCatalog.rotating;
    return getGatewayCatalogPool(input, metadata, environmentFingerprint);
  }
  if (gatewayCatalog.current?.recovery) {
    await gatewayCatalog.current.recovery;
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
    const env = input.input.env;
    const current: GatewayCatalogPool = {
      cache,
      envFingerprint: environmentFingerprint,
      borrowers: new Set(),
      recover: (error) =>
        (current.recovery ??= (async () => {
          const borrowers = [...current.borrowers];
          if (!signal.aborted) {
            for (const borrower of borrowers) {
              borrower.notifyRecovery(error);
            }
          }
          // Fence every old catalog before releasing the native slot. Recovery publishes new
          // prepared owners; it never replays a failed request under its former source generation.
          const stopping = borrowers.map((borrower) => borrower.stop(error));
          await current.close(error);
          await Promise.all(stopping);
          if (gatewayCatalog.current === current) {
            gatewayCatalog.current = undefined;
          }
          const { recoverPreparedModelRuntimeCatalogWorker } =
            await import("./prepared-model-runtime.js");
          await recoverPreparedModelRuntimeCatalogWorker(borrowers);
        })()),
      close: async (error) => {
        signal.removeEventListener("abort", retire);
        await current.pool.close(error);
        current.validate = undefined;
        release();
      },
      validate: undefined,
      pool: new WorkerTaskPool<CatalogPoolInput, PreparedModelWorkerResult>({
        workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog),
        maxWorkers: GATEWAY_CATALOG_WORKERS,
        // Source modules belong to this inventory, not to any one agent or idle request.
        idleTimeoutMs: 0,
        restartOnError: false,
        prepareWorker: () => {
          signal.throwIfAborted();
          const directory = fs.mkdtempSync(path.join(tmpdir(), "openclaw-model-catalog-"));
          return {
            temporaryDirectory: directory,
            options: {
              workerData: {
                kind: "gateway",
                sourceCaptureDirectory: directory,
              } satisfies PreparedModelCatalogWorkerData,
              env,
            },
          };
        },
        validateResult: (result) => {
          const validate = current.validate;
          current.validate = undefined;
          validate?.(result);
        },
      }),
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

class PreparedModelCatalogGenerationMismatchError extends Error {
  constructor(
    readonly agentDir: string,
    readonly generationFingerprint: string,
    readonly reconstructedFingerprint: string,
  ) {
    super(
      `prepared model catalog worker reconstructed a different runtime generation for ${agentDir} (owner=${generationFingerprint} worker=${reconstructedFingerprint})`,
    );
    this.name = "PreparedModelCatalogGenerationMismatchError";
  }
}

export function fingerprintPreparedModelWorkerRequest(
  input: PreparedModelCatalogWorkerInput,
  request: PreparedModelWorkerRequest,
): string {
  return fingerprintPreparedRuntimeFacts([input.generationFingerprint, request]);
}

function fingerprintPreparedModelCatalogPlugins(snapshot: PluginMetadataSnapshot): string {
  return fingerprintPreparedRuntimeFacts({
    config: snapshot.configFingerprint ?? null,
    index: resolveInstalledManifestRegistryIndexFingerprint(snapshot.index),
    pluginIds: snapshot.pluginIds ?? null,
    policy: snapshot.policyHash,
    workspaceDir: snapshot.workspaceDir ?? null,
  });
}

const immutableGenerationConfigFingerprints = new WeakMap<OpenClawConfig, string>();

function fingerprintPreparedModelCatalogConfig(config: OpenClawConfig): string {
  const immutable = isDeeplyFrozenPlainData(config);
  const cached = immutable ? immutableGenerationConfigFingerprints.get(config) : undefined;
  if (cached !== undefined) {
    return cached;
  }
  // Worker generation facts must retain the distinction between undefined and null.
  const fingerprint = fingerprintPreparedRuntimeFacts(config);
  if (immutable) {
    immutableGenerationConfigFingerprints.set(config, fingerprint);
  }
  return fingerprint;
}

export function fingerprintPreparedModelCatalogGeneration(params: {
  input: PreparedModelRuntimeInput;
  sourceConfigForSecrets: PreparedModelRuntimeInput["config"];
  configResolutionFacts: ReturnType<typeof serializeConfigResolutionFacts>;
  sourceConfigResolutionFacts: ReturnType<typeof serializeConfigResolutionFacts>;
  authStore: AuthProfileStore;
  providerIds: readonly string[];
  preferBuiltPluginArtifacts?: boolean;
  pluginMetadataSnapshot: PluginMetadataSnapshot;
}): string {
  return fingerprintPreparedRuntimeFacts({
    input: { ...params.input, config: fingerprintPreparedModelCatalogConfig(params.input.config) },
    sourceConfigForSecrets: fingerprintPreparedModelCatalogConfig(params.sourceConfigForSecrets),
    configResolutionFacts: params.configResolutionFacts,
    sourceConfigResolutionFacts: params.sourceConfigResolutionFacts,
    authStore: params.authStore,
    providerIds: params.providerIds,
    preferBuiltPluginArtifacts: params.preferBuiltPluginArtifacts === true,
    pluginFingerprint: fingerprintPreparedModelCatalogPlugins(params.pluginMetadataSnapshot),
  });
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
    skipCredentials: true,
    env: { ...params.agentFacts.env },
    ...(source.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
    ...(source.runtimePluginSelections
      ? { runtimePluginSelections: source.runtimePluginSelections }
      : {}),
    config: source.config,
  };
  // Capture the authored pair now; structured cloning cannot carry process-local Ref provenance.
  const sourceConfigForSecrets = projectConfigOntoRuntimeSourceSnapshot(source.config);
  const configResolutionFacts = serializeConfigResolutionFacts(source.config);
  const sourceConfigResolutionFacts =
    getConfigResolutionFacts(source.config) === getConfigResolutionFacts(sourceConfigForSecrets)
      ? configResolutionFacts
      : serializeConfigResolutionFacts(sourceConfigForSecrets);
  const authStore = cloneAuthProfileStore(params.agentFacts.authStore);
  const providerIds = [...params.agentFacts.providerIds];
  const { normalizePluginId: _normalizePluginId, ...pluginMetadataSnapshot } =
    params.pluginMetadataSnapshot;
  return {
    kind: "catalog",
    generationFingerprint: fingerprintPreparedModelCatalogGeneration({
      input,
      sourceConfigForSecrets,
      configResolutionFacts,
      sourceConfigResolutionFacts,
      authStore,
      providerIds,
      preferBuiltPluginArtifacts: params.preferBuiltPluginArtifacts,
      pluginMetadataSnapshot: params.pluginMetadataSnapshot,
    }),
    input,
    sourceConfigForSecrets,
    configResolutionFacts,
    sourceConfigResolutionFacts,
    authStore,
    providerIds,
    preferBuiltPluginArtifacts: params.preferBuiltPluginArtifacts === true,
    pluginMetadataSnapshot,
  };
}

type PreparedModelCatalogWorker = Readonly<{
  loadAuth: (
    scope: PreparedModelRuntimeAuthScope,
  ) => Promise<PreparedModelRuntimeAuth & { credentials: Readonly<AuthStorageData> }>;
  loadCatalog: (
    providerIds?: readonly string[],
    onRecovery?: (error: Error) => void,
  ) => Promise<
    Pick<PreparedModelRuntimeCatalogFacts, "modelCatalog" | "configuredRuntimeModels"> & {
      runtimeModels: Map<string, Model[]>;
      providerExpiries: Map<string, number>;
      configuredProviderModelIds: Map<string, readonly string[]>;
    }
  >;
}>;

export function createPreparedModelCatalogWorker(
  params: Parameters<typeof createPreparedModelCatalogWorkerInput>[0] & {
    isCurrent: () => boolean;
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
  let generationPoll: NodeJS.Timeout | undefined;
  let stoppedError: Error | undefined;
  let releaseProcessLifetime: (() => void) | undefined;
  let expectedFingerprint: string | undefined;
  const captures = new Map<AbortController, Promise<PreparedSyntheticAuthFacts>>();
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
  ) =>
    new PreparedModelCatalogGenerationMismatchError(
      workerInput.input.agentDir,
      message.generationFingerprint,
      message.reconstructedFingerprint,
    );
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
  const createPool = () =>
    new WorkerTaskPool<CatalogPoolInput, PreparedModelWorkerResult>({
      workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog),
      maxWorkers: 1,
      // Recreating this worker would import changed plugin code under the old generation.
      // Only the lifecycle owner may retire it; crashes close the generation permanently.
      idleTimeoutMs: 0,
      restartOnError: false,
      prepareWorker: () => {
        const directory = fs.mkdtempSync(path.join(tmpdir(), "openclaw-model-catalog-"));
        return {
          temporaryDirectory: directory,
          options: {
            workerData: {
              ...workerInput,
              sourceCaptureDirectory: directory,
            } satisfies PreparedModelCatalogWorkerData,
            // Establish state/config environment before module initialization reads process.env.
            env: workerInput.input.env,
          },
        };
      },
      validateResult: validate,
    });
  const stop = async (error: Error) => {
    stoppedError ??= error;
    clearInterval(generationPoll);
    generationPoll = undefined;
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
    const timeout = setTimeout(
      () => controller.abort(new WorkerTaskError("worker task timed out", "timeout")),
      PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS,
    );
    try {
      assertCurrent();
      releaseProcessLifetime ??= registerPreparedModelRuntimeClose(stop);
      generationPoll ??= setInterval(() => {
        if (!params.isCurrent()) {
          void stop(superseded());
        }
      }, PREPARED_MODEL_CATALOG_WORKER_GENERATION_POLL_MS);
      generationPoll.unref();
      const { input } = workerInput;
      // Worker reconstruction consumes startup auth facts even for a scoped catalog request.
      const providerScope = [...workerInput.providerIds, ...(command.providerIds ?? [])];
      const capture = withPluginRuntimeGenerationScope(
        { metadataSnapshot, pluginRegistry: params.pluginRegistry },
        () =>
          captureProviderSyntheticAuthFacts({
            config: input.config,
            env: input.env,
            workspaceDir: input.workspaceDir,
            providerRefs:
              command.kind === "catalog" && !command.providerIds
                ? [
                    ...listManifestSyntheticAuthProviderRefs(metadataSnapshot.index),
                    ...workerInput.providerIds,
                  ]
                : [
                    ...providerScope,
                    ...scopeSyntheticAuthProviderRefs(
                      listManifestSyntheticAuthProviderRefs(metadataSnapshot.index),
                      providerScope,
                    ),
                  ],
            signal: controller.signal,
          }),
      );
      captures.set(controller, capture);
      let syntheticAuth: PreparedSyntheticAuthFacts;
      try {
        syntheticAuth = await capture;
      } finally {
        captures.delete(controller);
      }
      controller.signal.throwIfAborted();
      const value = { ...command, syntheticAuth };
      const shared = gatewayOwned
        ? await getGatewayCatalogPool(workerInput, metadataSnapshot, environmentFingerprint)
        : undefined;
      if (shared) {
        sharedOwner = shared;
        shared.borrowers.add(borrower);
      }
      requestPool = pool = shared?.pool ?? pool ?? createPool();
      pending = requestPool.run(
        () => {
          assertCurrent();
          task.onRecovery = onRecovery;
          expectedFingerprint = fingerprintPreparedModelWorkerRequest(workerInput, value);
          if (shared) {
            shared.validate = validate;
          }
          return shared ? { value: workerInput, request: value } : value;
        },
        { timeoutMs: PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS, signal: controller.signal },
      );
      tasks.set(pending, task);
      message = await pending;
      assertCurrent();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
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
        requestPool?.isClosed &&
        !(failure instanceof PreparedModelRuntimePublicationSupersededError)
      ) {
        await sharedOwner.recover(failure).catch((recoveryError: unknown) => {
          process.emitWarning(`Gateway catalog recovery failed: ${String(recoveryError)}`);
        });
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
    loadCatalog: async (providerIds, onRecovery) => {
      const message = await request(
        { kind: "catalog", ...(providerIds ? { providerIds } : {}) },
        onRecovery,
      );
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
        configuredProviderModelIds: message.configuredProviderModelIds,
      };
    },
    loadAuth: async ({ providerIds, profileIds }) => {
      const normalizedProviderIds = [...new Set(providerIds)].toSorted((left, right) =>
        left.localeCompare(right),
      );
      const normalizedProfileIds = profileIds
        ? [...new Set(profileIds)].toSorted((left, right) => left.localeCompare(right))
        : undefined;
      const message = await request({
        kind: "auth-refresh",
        providerIds: normalizedProviderIds,
        ...(normalizedProfileIds ? { profileIds: normalizedProfileIds } : {}),
      });
      if (message.kind !== "auth-refresh") {
        throw new Error("prepared model auth refresh worker returned a catalog result");
      }
      return {
        authStore: message.authStore,
        authModes: message.authModes,
        credentials: message.credentials,
      };
    },
  };
}
