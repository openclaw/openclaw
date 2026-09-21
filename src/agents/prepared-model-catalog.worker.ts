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
import { listRuntimePluginIdsFromRegistry } from "../plugins/active-runtime-registry.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import { restorePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withPluginSourceCaptureDirectory } from "../plugins/plugin-package-metadata-capture.js";
import { captureProviderCatalogExpiries } from "../plugins/provider-catalog-expiry.js";
import { planRuntimePluginDiscovery } from "../plugins/provider-discovery.js";
import { restorePreparedSyntheticAuthFacts } from "../plugins/provider-synthetic-auth.js";
import { manifestPluginResolvesRuntimeModelCatalogAugment } from "../plugins/providers.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveRuntimeSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import { normalizeAgentId } from "../routing/session-key.js";
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
import {
  PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS,
  fingerprintPreparedModelCatalogGeneration,
  fingerprintPreparedModelWorkerRequest,
  type PreparedModelCatalogWorkerInput,
  type PreparedModelCatalogWorkerData,
  type PreparedModelCatalogWorkerTask,
  type PreparedModelWorkerRequest,
  type PreparedModelWorkerResult,
} from "./prepared-model-catalog-worker.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import { prepareOwnedPluginLoadContext } from "./prepared-model-runtime.plugin-context.js";
import {
  discardPreparedPluginGeneration,
  ownPreparedPluginGeneration,
  retainPreparedPluginRegistry,
} from "./prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";
import { scopeSyntheticAuthProviderRefs } from "./prepared-model-runtime.synthetic-auth.js";
import type { PreparedModelRuntimePluginGeneration } from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";

type WorkerGeneration = {
  agentFacts: PreparedModelRuntimeAgentFacts;
  pluginGeneration: PreparedModelRuntimePluginGeneration;
  reconstructedFingerprint: string;
  discovery?: {
    key: string;
    registry: PluginRegistry;
    release: () => Promise<void>;
  };
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
): Promise<WorkerGeneration> {
  const { prepareWorkspaceBuildGroup } = await import("./prepared-model-runtime.facts.js");
  // Rediscovery under agent workspaces or runtime activation overlays loses the owner's
  // metadata generation. Its source/built artifact selection must survive reconstruction too.
  const metadata = restorePluginMetadataSnapshot(value.pluginMetadataSnapshot);
  // The parent owns native harness observations; this worker owns provider catalog hooks.
  // An empty eligible set stays empty instead of reopening unscoped plugin discovery.
  const normalizedConfig = normalizePluginsConfig(value.input.config.plugins);
  const basePluginIds = metadata.plugins
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
  const prepared = await prepareWorkspaceBuildGroup(
    [value.input],
    "static",
    {
      preferBuiltPluginArtifacts: value.preferBuiltPluginArtifacts,
      basePluginIds,
      providerDiscoveryProviderIds: value.providerIds,
      purpose: "model-catalog",
    },
    undefined,
    undefined,
    metadata,
  );
  const agentFacts = prepared.agentFacts[0];
  if (!agentFacts) {
    throw new Error("prepared model catalog worker produced no agent facts");
  }
  const reconstructedFingerprint = fingerprintPreparedModelCatalogGeneration({
    input: value.input,
    sourceConfigForSecrets: value.sourceConfigForSecrets,
    configResolutionFacts: value.configResolutionFacts,
    sourceConfigResolutionFacts: value.sourceConfigResolutionFacts,
    authStore: value.authStore,
    providerIds: value.providerIds,
    preferBuiltPluginArtifacts: prepared.pluginGeneration.preferBuiltPluginArtifacts,
    pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
  });
  return { agentFacts, pluginGeneration: prepared.pluginGeneration, reconstructedFingerprint };
}

export async function runPreparedModelCatalogWorkerRequest(
  value: PreparedModelCatalogWorkerInput,
  request: PreparedModelWorkerRequest,
  prepareGeneration?: () => Promise<WorkerGeneration>,
): Promise<PreparedModelWorkerResult> {
  return withClawInstallSchemaVersionFacts(request.clawInstallSchemaVersions, () =>
    runCatalogRequest(value, request, prepareGeneration),
  );
}

async function runCatalogRequest(
  value: PreparedModelCatalogWorkerInput,
  request: PreparedModelWorkerRequest,
  prepareGeneration?: () => ReturnType<typeof prepareWorkerGeneration>,
): Promise<PreparedModelWorkerResult> {
  const directoryOwner = value.input.agentId
    ? { agentId: value.input.agentId, agentDir: value.input.agentDir, env: value.input.env }
    : undefined;
  let registeredDirectoryOwner = false;
  let prepared: WorkerGeneration | undefined;
  let acquiredDiscovery: WorkerGeneration["discovery"];
  let completed = false;
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
    prepared = await (prepareGeneration ? prepareGeneration() : prepareWorkerGeneration(value));
    // Every ok reply is cached under the owner's generation. Facts rebuilt under another
    // fingerprint leave only as this typed outcome, so the owner retires the worker instead.
    if (prepared.reconstructedFingerprint !== value.generationFingerprint) {
      return {
        status: "generation-mismatch",
        generationFingerprint: value.generationFingerprint,
        reconstructedFingerprint: prepared.reconstructedFingerprint,
      };
    }
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
    if (request.kind === "auth-refresh") {
      const authStore = refreshAuthStore({
        agentDir: value.input.agentDir,
        inheritedAuthDir: value.input.inheritedAuthDir,
        authStore: value.authStore,
        config: value.input.config,
        env: value.input.env ?? process.env,
        ...(request.profileIds ? { profileIds: request.profileIds } : {}),
        providerIds: request.providerIds,
        pluginGeneration: prepared.pluginGeneration,
      });
      const credentials = {
        ...resolveSyntheticCredentials(request.providerIds),
        ...resolveAgentCredentialMapFromStore(authStore, { config: value.input.config }),
      };
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
    // Full discovery is one point-in-time operation: refresh first, then let every provider hook
    // and the returned availability projection consume the same exact store.
    const authStore = refreshAuthStore({
      agentDir: value.input.agentDir,
      inheritedAuthDir: value.input.inheritedAuthDir,
      authStore: value.authStore,
      config: value.input.config,
      env: value.input.env ?? process.env,
      providerIds: request.providerIds ?? listExternalCliSyncProviderIds(),
      pluginGeneration: prepared.pluginGeneration,
    });
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: value.input.agentDir, store: authStore }]);
    const ambientCredentials = resolveSyntheticCredentials(
      request.providerIds ?? value.providerIds,
    );
    const startupProviderIds = new Set(value.providerIds.map(normalizeProviderId));
    const credentials = {
      ...ambientCredentials,
      ...resolveAgentCredentialMapFromStore(authStore, { config: value.input.config }),
    };
    const exactAgentFacts = {
      ...prepared.agentFacts,
      input: value.input,
      env: value.input.env,
      authStore,
      templateAuthStorage: AuthStorage.inMemory(credentials),
      credentials,
      providerIds: [
        ...new Set(request.providerIds ?? [...value.providerIds, ...Object.keys(credentials)]),
      ].toSorted((left, right) => left.localeCompare(right)),
    };
    const { pluginMetadataSnapshot, pluginRegistry } = prepared.pluginGeneration;
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
      // Refresh can reveal credential-only providers absent at startup. Materialize their
      // catalog owners from the captured metadata before binding the authoritative registry.
      const pluginIds = [
        ...new Set([
          ...(pluginRegistry ? listRuntimePluginIdsFromRegistry(pluginRegistry) : []),
          ...(discoveryPlan.pluginIds ?? discoveryPluginIds),
        ]),
      ].toSorted();
      const key = JSON.stringify(pluginIds);
      if (prepared.discovery?.key !== key) {
        await using resources = new PreparedModelRuntimeBuildResources(
          retainPreparedPluginRegistry,
        );
        const registry = await resources.load(
          {
            ...value.input,
            purpose: "model-catalog",
            metadataSnapshot: pluginMetadataSnapshot,
            preferBuiltPluginArtifacts: value.preferBuiltPluginArtifacts,
            reusableRegistry: pluginRegistry,
            basePluginIds: pluginIds,
          },
          () => {},
        );
        const release = retainPreparedPluginRegistry(registry);
        acquiredDiscovery = {
          key,
          registry,
          release: async () => {
            await release?.();
          },
        };
      }
      const catalogRegistry = (acquiredDiscovery ?? prepared.discovery)!.registry;
      prepareOwnedPluginLoadContext(
        value.input,
        value.input.env ?? process.env,
        catalogRegistry,
        pluginMetadataSnapshot,
        value.preferBuiltPluginArtifacts,
      );
      pluginGenerationScope.pluginRegistry = catalogRegistry;
      catalogGeneration = Object.freeze({
        ...catalogGeneration,
        pluginRegistry: catalogRegistry,
        providerStaticModels: undefined,
      });
    }
    const configuredProviderModelIds = new Map<string, readonly string[]>();
    const { value: source, providerExpiries } = await captureProviderCatalogExpiries(() =>
      prepareAgentCatalogSource(exactAgentFacts, catalogGeneration, "live", false, {
        authStore,
        providerDiscoveryProviderIds: request.providerIds,
        providerDiscoveryTimeoutMs: PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS,
        providerCatalogInventory: { agentId: value.input.agentId, configuredProviderModelIds },
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
      configuredProviderModelIds,
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
    if (acquiredDiscovery) {
      const previous = prepared.discovery;
      prepared.discovery = acquiredDiscovery;
      await previous?.release();
    }
    completed = true;
    return result;
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      if (acquiredDiscovery && !completed) {
        if (prepared?.discovery === acquiredDiscovery) {
          prepared.discovery = undefined;
        }
        await acquiredDiscovery.release();
      }
      if (prepared && !prepareGeneration) {
        try {
          await prepared.discovery?.release();
        } finally {
          await discardPreparedPluginGeneration(prepared.pluginGeneration);
        }
      }
    } finally {
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

// Keep custody outside the request scope: an inline closure also retains `previous`,
// chaining every superseded generation through the worker's one current entry.
function retainWorkerGeneration(prepared: WorkerGeneration): () => Promise<void> {
  const releaseBase = ownPreparedPluginGeneration(prepared.pluginGeneration).retain();
  return async () => {
    try {
      await prepared.discovery?.release();
    } finally {
      await releaseBase();
    }
  };
}

if (parentPort) {
  const data = workerData as PreparedModelCatalogWorkerData;
  // Serial worker tasks share one successful generation, including across fleet changes.
  let current:
    | { fingerprint: string; prepared: WorkerGeneration; release: () => Promise<void> }
    | undefined;
  serveWorkerTasks(async (input) => {
    // SAFETY: The Gateway pool is the sole producer of this private task envelope.
    const task = data.kind === "gateway" ? (input as PreparedModelCatalogWorkerTask) : undefined;
    const value = task?.value ?? data;
    const request = task?.request ?? input;
    if (value.kind !== "catalog" || !isWorkerRequest(request)) {
      throw new Error("invalid prepared model catalog worker request");
    }
    return withPluginSourceCaptureDirectory(
      data.sourceCaptureDirectory,
      async () => {
        const previous = current;
        let attempted: WorkerGeneration | undefined;
        let release: (() => Promise<void>) | undefined;
        try {
          const result = await runPreparedModelCatalogWorkerRequest(value, request, async () => {
            if (previous?.fingerprint === value.generationFingerprint) {
              return previous.prepared;
            }
            const prepared = (attempted = await prepareWorkerGeneration(value));
            if (prepared.reconstructedFingerprint === value.generationFingerprint) {
              release = retainWorkerGeneration(prepared);
            }
            return prepared;
          });
          if (attempted && release && result.status === "ok") {
            current = {
              fingerprint: value.generationFingerprint,
              prepared: attempted,
              release,
            };
            attempted = undefined;
            release = undefined;
            // Acquire the replacement before releasing shared source registrations.
            await previous?.release();
          }
          return result;
        } finally {
          if (release) {
            await release();
          } else if (attempted) {
            await discardPreparedPluginGeneration(attempted.pluginGeneration);
          }
        }
      },
      data.sourceCaptureManagedRoot,
    );
  });
}
