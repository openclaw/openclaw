/** Worker-thread entrypoint for complete model-catalog discovery. */
import { parentPort, workerData } from "node:worker_threads";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withClawInstallSchemaVersionFacts } from "../claws/provenance-runtime-read.js";
import {
  copyConfigResolutionFacts,
  restoreConfigResolutionFacts,
} from "../config/resolution-facts.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { serveWorkerTasks } from "../infra/worker-task-server.js";
import type { Model } from "../llm/types.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import { restorePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withPluginSourceCaptureDirectory } from "../plugins/plugin-package-metadata-capture.js";
import { captureProviderCatalogExpiries } from "../plugins/provider-catalog-expiry.js";
import { planRuntimePluginDiscovery } from "../plugins/provider-discovery.js";
import { restorePreparedSyntheticAuthFacts } from "../plugins/provider-synthetic-auth.js";
import { manifestPluginResolvesRuntimeModelCatalogAugment } from "../plugins/providers.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveRuntimeSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  resolveAgentCredentialMapFromStore,
  resolveUsableAgentCredentialModes,
} from "./agent-auth-credentials.js";
import { resolveAmbientAgentCredentialsForDiscovery } from "./agent-auth-discovery.js";
import {
  registerResolvedAgentDir,
  resolveRegisteredAgentIdForDir,
  unregisterResolvedAgentDir,
} from "./agent-dir-registry.js";
import { overlayExternalAuthProfiles } from "./auth-profiles/external-auth-runtime.js";
import { listExternalCliSyncProviderIds } from "./auth-profiles/external-cli-sync.js";
import { mergeRuntimeExternalProfileReferences } from "./auth-profiles/runtime-external-profile-references.js";
import { replaceRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "./auth-profiles/store-runtime.js";
import { preserveResolvedSecretBackedCredentials } from "./auth-profiles/store.js";
import { prepareModelCatalogAuthLabels } from "./model-catalog-auth-labels.js";
import { resolveImplicitProviderDiscoveryScope } from "./models-config.providers.discovery-scope.js";
import { prepareImplicitProviderStaticCatalog } from "./models-config.providers.implicit.js";
import {
  PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS,
  fingerprintPreparedModelCatalogGeneration,
  fingerprintPreparedModelCatalogPluginContext,
  fingerprintPreparedModelWorkerRequest,
  type PreparedModelCatalogWorkerInput,
  type PreparedModelCatalogWorkerData,
  type PreparedModelCatalogWorkerTask,
  type PreparedModelWorkerRequest,
  type PreparedModelWorkerResult,
} from "./prepared-model-catalog-worker.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import {
  ownPreparedPluginGeneration,
  retainPreparedPluginRegistry,
} from "./prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";
import { scopeSyntheticAuthProviderRefs } from "./prepared-model-runtime.synthetic-auth.js";
import type { PreparedModelRuntimePluginGeneration } from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";

type WorkerGeneration = {
  pluginGeneration: PreparedModelRuntimePluginGeneration;
  pluginIds: ReadonlySet<string>;
  staticProviderIds: ReadonlySet<string>;
  release: () => void | Promise<void>;
};

function refreshAuthStore(params: {
  agentDir: string;
  inheritedAuthDir?: string;
  authStore: PreparedModelCatalogWorkerInput["authStore"];
  config: PreparedModelCatalogWorkerInput["input"]["config"];
  env: NodeJS.ProcessEnv;
  profileIds?: readonly string[];
  providerIds?: readonly string[];
  pluginGeneration: PreparedModelRuntimePluginGeneration;
}) {
  const durable = preserveResolvedSecretBackedCredentials({
    next: loadAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
      allowKeychainPrompt: false,
      ...(params.inheritedAuthDir ? { inheritedAuthDir: params.inheritedAuthDir } : {}),
    }),
    existing: params.authStore,
  });
  const persistedProfileIds = new Set(params.authStore.runtimePersistedProfileIds ?? []);
  const externalProfileIds = new Set(params.authStore.runtimeExternalProfileIds ?? []);
  for (const [profileId, credential] of Object.entries(params.authStore.profiles)) {
    if (
      !persistedProfileIds.has(profileId) &&
      !externalProfileIds.has(profileId) &&
      durable.profiles[profileId] === undefined
    ) {
      durable.profiles[profileId] = credential;
    }
  }
  const prepared = mergeRuntimeExternalProfileReferences({
    next: durable,
    existing: params.authStore,
  });
  return withPluginRuntimeGenerationScope(
    {
      metadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
      pluginRegistry: params.pluginGeneration.pluginRegistry,
    },
    () =>
      overlayExternalAuthProfiles(prepared, {
        config: params.config,
        env: params.env,
        ...(params.providerIds ? { externalCliProviderIds: params.providerIds } : {}),
        ...(params.profileIds ? { externalCliProfileIds: params.profileIds } : {}),
        allowKeychainPrompt: false,
      }),
  );
}

function restoreWorkerConfig(value: PreparedModelCatalogWorkerInput) {
  // Restore the captured pair before discovery, including known-empty facts and shared identity.
  // Without loader facts, decoded literal strings can be reparsed as references.
  restoreConfigResolutionFacts(value.input.config, value.configResolutionFacts);
  if (value.sourceConfigResolutionFacts === value.configResolutionFacts) {
    copyConfigResolutionFacts(value.input.config, value.sourceConfigForSecrets);
  } else {
    restoreConfigResolutionFacts(value.sourceConfigForSecrets, value.sourceConfigResolutionFacts);
  }
  setRuntimeConfigSnapshot(value.input.config, value.sourceConfigForSecrets);
}

async function prepareWorkerGeneration(
  value: PreparedModelCatalogWorkerInput,
  previous?: WorkerGeneration,
  pluginIds?: readonly string[],
): Promise<WorkerGeneration> {
  const { prepareConfiguredModelFacts } = await import("./prepared-model-runtime.facts.js");
  // Rediscovery under agent workspaces or runtime activation overlays loses the owner's
  // metadata generation. Its source/built artifact selection must survive reconstruction too.
  const metadata =
    previous?.pluginGeneration.pluginMetadataSnapshot ??
    restorePluginMetadataSnapshot(value.pluginMetadataSnapshot);
  // The parent owns native harness observations; this worker owns provider catalog hooks.
  // An empty eligible set stays empty instead of reopening unscoped plugin discovery.
  const normalizedConfig = normalizePluginsConfig(value.input.config.plugins);
  const basePluginIds =
    pluginIds ??
    metadata.plugins
      .filter(
        (plugin) =>
          manifestPluginResolvesRuntimeModelCatalogAugment(plugin) &&
          isManifestPluginAvailableForControlPlane({
            snapshot: metadata,
            plugin,
            config: value.input.config,
            normalizedConfig,
            ...(value.input.env ? { env: value.input.env } : {}),
          }),
      )
      .map((plugin) => plugin.id)
      .toSorted((left, right) => left.localeCompare(right));
  await using resources = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
  const pluginRegistry = await resources.load(
    {
      ...value.input,
      metadataSnapshot: metadata,
      preferBuiltPluginArtifacts: value.preferBuiltPluginArtifacts,
      basePluginIds,
      reusableRegistry: previous?.pluginGeneration.pluginRegistry,
      purpose: "model-catalog",
    },
    () => {},
  );
  prepareOwnedPluginLoadContext(
    value.input,
    value.input.env,
    pluginRegistry,
    metadata,
    value.preferBuiltPluginArtifacts,
  );
  const pluginGeneration = Object.freeze({
    ...(previous?.pluginGeneration ?? prepareConfiguredModelFacts(value.input.config, metadata)),
    pluginMetadataSnapshot: metadata,
    pluginRegistry,
    preparedStaticProviderCatalog: undefined,
    preferBuiltPluginArtifacts: value.preferBuiltPluginArtifacts,
  });
  return {
    pluginGeneration,
    pluginIds: new Set([...basePluginIds, ...pluginRegistry.plugins.map((plugin) => plugin.id)]),
    staticProviderIds: previous?.staticProviderIds ?? new Set(),
    release: ownPreparedPluginGeneration(pluginGeneration).retain(),
  };
}

async function runCatalogRequest(
  value: PreparedModelCatalogWorkerInput,
  request: PreparedModelWorkerRequest,
  work: AsyncWorkScope,
  prepareGeneration: () => Promise<WorkerGeneration>,
): Promise<PreparedModelWorkerResult> {
  const directoryOwner = value.input.agentId
    ? { agentId: value.input.agentId, agentDir: value.input.agentDir, env: value.input.env }
    : undefined;
  let registeredDirectoryOwner = false;
  let prepared: WorkerGeneration | undefined;
  let acquiredGeneration: WorkerGeneration | undefined;
  try {
    if (directoryOwner) {
      registeredDirectoryOwner = registerResolvedAgentDir(directoryOwner);
      if (
        resolveRegisteredAgentIdForDir(directoryOwner.agentDir, directoryOwner.env) !==
        normalizeAgentId(directoryOwner.agentId)
      ) {
        throw new Error(`Conflicting registered agent owners for ${directoryOwner.agentDir}`);
      }
    }
    // Structured-cloned requests need their own provenance even when preparation is reused.
    restoreWorkerConfig(value);
    restorePreparedSyntheticAuthFacts(value.input.config, request.syntheticAuth, {
      env: value.input.env,
      workspaceDir: value.input.workspaceDir,
    });
    restorePreparedSyntheticAuthFacts(value.input.config, request.syntheticAuth, {
      workspaceDir: value.input.workspaceDir,
    });
    const generationFingerprint = fingerprintPreparedModelWorkerRequest(value, request);
    prepared = await prepareGeneration();
    // Sharing plugin registrations does not relax the exact agent/config publication contract.
    // Mismatched transferred facts still retire this request's worker through the owner.
    const reconstructedFingerprint = fingerprintPreparedModelCatalogGeneration({
      ...value,
      preferBuiltPluginArtifacts: prepared.pluginGeneration.preferBuiltPluginArtifacts === true,
      pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
    });
    if (reconstructedFingerprint !== value.generationFingerprint) {
      return {
        status: "generation-mismatch",
        generationFingerprint: value.generationFingerprint,
        reconstructedFingerprint,
      };
    }
    // Cached registrations retain their code, while request lookups use this clone's
    // config/environment objects and the synthetic-auth facts restored on them above.
    prepareOwnedPluginLoadContext(
      value.input,
      value.input.env,
      prepared.pluginGeneration.pluginRegistry,
      prepared.pluginGeneration.pluginMetadataSnapshot,
      value.preferBuiltPluginArtifacts,
    );
    const pluginGenerationScope = {
      metadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
      pluginRegistry: prepared.pluginGeneration.pluginRegistry,
    };
    const resolveSyntheticCredentials = (providerIds: readonly string[]) =>
      withPluginRuntimeGenerationScope(pluginGenerationScope, () =>
        resolveAmbientAgentCredentialsForDiscovery({
          config: value.input.config,
          env: value.input.env,
          authoritativeSyntheticAuthProviderRefs:
            pluginGenerationScope.metadataSnapshot.owners.cliBackends.keys(),
          syntheticAuthProviderRefs: scopeSyntheticAuthProviderRefs(
            [
              ...new Set([
                ...resolveRuntimeSyntheticAuthProviderRefs(),
                ...request.syntheticAuth.map(({ providerRef }) => providerRef),
              ]),
            ],
            providerIds,
          ),
          ...(value.input.workspaceDir ? { workspaceDir: value.input.workspaceDir } : {}),
        }),
      );
    // Full discovery is one point-in-time operation: refresh first, then let every provider hook
    // and the returned availability projection consume the same exact store.
    const authStore = refreshAuthStore({
      agentDir: value.input.agentDir,
      inheritedAuthDir: value.input.inheritedAuthDir,
      authStore: value.authStore,
      config: value.input.config,
      env: value.input.env,
      ...(request.kind === "auth-refresh" && request.profileIds
        ? { profileIds: request.profileIds }
        : {}),
      providerIds: request.providerIds ?? listExternalCliSyncProviderIds(),
      pluginGeneration: prepared.pluginGeneration,
    });
    if (request.kind === "catalog") {
      replaceRuntimeAuthProfileStoreSnapshots([
        { agentDir: value.input.agentDir, store: authStore },
      ]);
    }
    const credentials = {
      ...resolveSyntheticCredentials(request.providerIds ?? value.providerIds),
      ...resolveAgentCredentialMapFromStore(authStore, { config: value.input.config }),
    };
    if (request.kind === "auth-refresh") {
      return {
        status: "ok",
        kind: "auth-refresh",
        generationFingerprint,
        authStore,
        credentials,
        authModes: resolveUsableAgentCredentialModes(credentials),
      };
    }
    const { prepareAgentCatalogSource } =
      await import("./prepared-model-runtime.scoped-catalog.js");
    const { prepareFullCatalogFacts } = await import("./prepared-model-runtime.full-catalog.js");
    const startupProviderIds = new Set(value.providerIds.map(normalizeProviderId));
    const exactAgentFacts = {
      ...value.catalogFacts,
      input: value.input,
      env: value.input.env,
      templateAuthStorage: AuthStorage.inMemory(credentials),
      credentials,
      providerIds: [
        ...new Set(request.providerIds ?? [...value.providerIds, ...Object.keys(credentials)]),
      ].toSorted((left, right) => left.localeCompare(right)),
    };
    const { pluginMetadataSnapshot } = prepared.pluginGeneration;
    const discoveryScope = resolveImplicitProviderDiscoveryScope({
      config: value.input.config,
      env: value.input.env,
      workspaceDir: value.input.workspaceDir,
      pluginMetadataSnapshot,
      providerDiscoveryProviderIds: exactAgentFacts.providerIds,
    });
    const discoveryPluginIds = [...(discoveryScope?.keys() ?? [])];
    const discoveryPlan = await withPluginRuntimeGenerationScope(pluginGenerationScope, () =>
      planRuntimePluginDiscovery({
        config: value.input.config,
        env: value.input.env,
        workspaceDir: value.input.workspaceDir,
        pluginMetadataSnapshot,
        onlyPluginIds: discoveryPluginIds,
      }),
    );
    let catalogGeneration = prepared.pluginGeneration;
    if (discoveryPlan.kind === "runtime") {
      // Keep newly observed owners in this bounded metadata generation. Alternating agents
      // must not reconstruct each other's registrations or retry recorded load failures.
      const pluginIds = [
        ...new Set([...prepared.pluginIds, ...(discoveryPlan.pluginIds ?? discoveryPluginIds)]),
      ].toSorted();
      if (pluginIds.length > prepared.pluginIds.size) {
        acquiredGeneration = await prepareWorkerGeneration(value, prepared, pluginIds);
        catalogGeneration = acquiredGeneration.pluginGeneration;
        pluginGenerationScope.pluginRegistry = catalogGeneration.pluginRegistry;
      }
    }
    const staticOwner = acquiredGeneration ?? prepared;
    const staticProviderIds = new Set([
      ...staticOwner.staticProviderIds,
      ...exactAgentFacts.providerIds,
    ]);
    // Static preparation grows only with requested provider scope. Registry replacement
    // clears its result so retired provider handles cannot survive in the next generation.
    if (
      !catalogGeneration.preparedStaticProviderCatalog ||
      staticProviderIds.size > staticOwner.staticProviderIds.size
    ) {
      staticOwner.pluginGeneration = Object.freeze({
        ...catalogGeneration,
        preparedStaticProviderCatalog: await withPluginRuntimeGenerationScope(
          pluginGenerationScope,
          () =>
            prepareImplicitProviderStaticCatalog({
              config: value.input.config,
              env: value.input.env,
              workspaceDir: value.input.workspaceDir,
              pluginMetadataSnapshot,
              providerDiscoveryProviderIds: [...staticProviderIds],
            }),
        ),
      });
      staticOwner.staticProviderIds = staticProviderIds;
    }
    catalogGeneration = staticOwner.pluginGeneration;
    const { value: source, providerExpiries } = await captureProviderCatalogExpiries(() =>
      prepareAgentCatalogSource(exactAgentFacts, catalogGeneration, "live", false, {
        authStore,
        providerDiscoveryProviderIds: request.providerIds,
        providerDiscoveryTimeoutMs: PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS,
      }),
    );
    const facts = await prepareFullCatalogFacts(
      exactAgentFacts,
      catalogGeneration,
      "live",
      source,
      {
        includeNative: false,
        providerIds: request.providerIds,
      },
    );
    // Full discovery can publish routes absent from startup config. Pair those exact rows with
    // provider-owned synthetic auth before the catalog and auth modes cross the worker boundary.
    const catalogCredentials = {
      ...resolveSyntheticCredentials(
        [...facts.modelCatalog.entries, ...facts.modelCatalog.routeVariants]
          .map((entry) => entry.provider)
          .filter(
            (provider) =>
              !request.providerIds || request.providerIds.includes(normalizeProviderId(provider)),
          )
          .filter((provider) => !startupProviderIds.has(normalizeProviderId(provider))),
      ),
      ...credentials,
    };
    const runtimeModels = new Map<string, Model[]>();
    // Lazy normalization must keep provider hooks on the selected catalog generation.
    const catalogModels = withPluginRuntimeGenerationScope(pluginGenerationScope, () =>
      facts.templateModelRegistry.getAll(),
    );
    for (const model of catalogModels) {
      const provider = normalizeProviderId(model.provider);
      const models = runtimeModels.get(provider) ?? [];
      models.push(model);
      runtimeModels.set(provider, models);
    }
    for (const outcome of facts.modelCatalog.providerOutcomes ?? []) {
      const provider = normalizeProviderId(outcome.provider);
      if (!runtimeModels.has(provider)) {
        runtimeModels.set(provider, []);
      }
    }
    const result: PreparedModelWorkerResult = {
      status: "ok",
      kind: "catalog",
      generationFingerprint,
      snapshot: facts.modelCatalog,
      runtimeModels,
      providerExpiries,
      configuredRuntimeModels: facts.configuredRuntimeModels,
      credentials: catalogCredentials,
      providerAuthLabels: withPluginRuntimeGenerationScope(pluginGenerationScope, () =>
        prepareModelCatalogAuthLabels({
          config: value.input.config,
          agentDir: value.input.agentDir,
          workspaceDir: value.input.workspaceDir,
          env: value.input.env,
          store: authStore,
          providers: [
            ...exactAgentFacts.providerIds,
            ...Object.keys(catalogCredentials),
            ...Object.keys(value.input.config.models?.providers ?? {}),
            ...facts.modelCatalog.entries.map((entry) => entry.provider),
            ...facts.modelCatalog.routeVariants.map((entry) => entry.provider),
            ...(facts.modelCatalog.staticEntries ?? []).map((entry) => entry.provider),
            ...Object.values(authStore.profiles).map((profile) => profile.provider),
          ],
        }),
      ),
      authStore,
      authModes: resolveUsableAgentCredentialModes(catalogCredentials),
    };
    work.beginClose();
    await work.runWhenIdle(() => undefined);
    if (acquiredGeneration) {
      const releasePrevious = prepared.release;
      prepared.pluginGeneration = acquiredGeneration.pluginGeneration;
      prepared.pluginIds = acquiredGeneration.pluginIds;
      prepared.staticProviderIds = acquiredGeneration.staticProviderIds;
      prepared.release = acquiredGeneration.release;
      acquiredGeneration = undefined;
      await releasePrevious();
    }
    return result;
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      // A catalog deadline can finish observing OAuth before its credential write settles.
      // Join that admitted work before releasing its plugin generation and source context.
      work.beginClose();
      await work.runWhenIdle(() => undefined);
      await acquiredGeneration?.release();
    } finally {
      // Registry retirement is admitted cleanup in this request; close only after it settles.
      await work.drain();
      if (directoryOwner && registeredDirectoryOwner) {
        unregisterResolvedAgentDir(directoryOwner);
      }
    }
  }
}

function isWorkerRequest(value: unknown): value is PreparedModelWorkerRequest {
  return (
    isRecord(value) &&
    Array.isArray(value.syntheticAuth) &&
    isRecord(value.clawInstallSchemaVersions) &&
    typeof value.clawInstallSchemaVersions.path === "string" &&
    isRecord(value.clawInstallSchemaVersions.snapshot) &&
    ((value.kind === "catalog" &&
      (value.providerIds === undefined ||
        (Array.isArray(value.providerIds) &&
          value.providerIds.every((id) => typeof id === "string")))) ||
      (value.kind === "auth-refresh" &&
        Array.isArray(value.providerIds) &&
        value.providerIds.every((providerId) => typeof providerId === "string") &&
        (value.profileIds === undefined ||
          (Array.isArray(value.profileIds) &&
            value.profileIds.every((profileId) => typeof profileId === "string")))))
  );
}

if (parentPort) {
  const data = workerData as PreparedModelCatalogWorkerData;
  // Agent/auth requests share registrations only when the complete plugin context matches.
  let current: { fingerprint: string; prepared: WorkerGeneration } | undefined;
  serveWorkerTasks(async (input) => {
    // SAFETY: The typed catalog host is the sole producer of this private task envelope.
    const { value, request } = input as PreparedModelCatalogWorkerTask;
    if (!isRecord(value) || !isWorkerRequest(request)) {
      throw new Error("invalid prepared model catalog worker request");
    }
    return withPluginSourceCaptureDirectory(
      data.sourceCaptureDirectory,
      async () => {
        let previous = current;
        const fingerprint = fingerprintPreparedModelCatalogPluginContext(value);
        let attempted: WorkerGeneration | undefined;
        try {
          const work = new AsyncWorkScope();
          const result = await withClawInstallSchemaVersionFacts(
            request.clawInstallSchemaVersions,
            () =>
              work.run(() =>
                runCatalogRequest(value, request, work, async () => {
                  if (previous?.fingerprint === fingerprint) {
                    return previous.prepared;
                  }
                  return (attempted = await prepareWorkerGeneration(value));
                }),
              ),
          );
          if (attempted && result.status === "ok") {
            current = { fingerprint, prepared: attempted };
            attempted = undefined;
            // Acquire the replacement before releasing shared source registrations.
            await previous?.prepared.release();
            // Registry custody can retain this request's async context until retirement.
            // Drop the settled predecessor instead of retaining its callbacks through that scope.
            previous = undefined;
          }
          return result;
        } finally {
          await attempted?.release();
        }
      },
      data.sourceCaptureManagedRoot,
    );
  });
}
