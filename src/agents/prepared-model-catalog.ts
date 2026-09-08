/** Lifecycle-owned model catalog access. */
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveAmbientOwnerAgentId,
} from "./agent-scope.js";
import { resolveLegacyInheritedAuthDir } from "./legacy-inherited-auth-dir.js";
import { findModelInCatalog } from "./model-catalog-lookup.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { modelTransportRoutesMatch } from "./model-compat-catalog.js";
import { resolvePublishedModelCatalogOwner } from "./prepared-model-catalog-owner.js";
import { PreparedModelCatalogConfigReplacedError } from "./prepared-model-catalog.errors.js";
import type { ResolvedPublishedModelCatalogOwner } from "./prepared-model-catalog.types.js";
import {
  getPreparedModelFullCatalogAuth,
  getPreparedModelRuntimeAuthMaterializations,
  loadPreparedModelRuntimeAuth,
  setPreparedModelRuntimeAuthMaterializations,
  setPreparedModelRuntimeAuthLoader,
  setPreparedModelRuntimeAuthStore,
} from "./prepared-model-runtime-auth.js";
import { isPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquireReadOnlyPreparedModelRuntime,
  activateStandalonePreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  prepareModelRuntimeSnapshot,
  PreparedModelRuntimeOwnerNotPublishedError,
  preparedModelRuntimeConfigsMatch,
  refreshPreparedModelRuntimeCatalog,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import {
  prepareScopedReadOnlyLiveModelCatalog,
  prepareScopedReadOnlyModelCatalog,
} from "./prepared-model-runtime.scoped-catalog.js";
import { normalizeThinkingCatalogProviders } from "./thinking-runtime.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

export type LoadPreparedModelCatalogParams = {
  agentId?: string;
  agentDir?: string;
  config?: OpenClawConfig;
  readOnly?: boolean;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  providerDiscoveryProviderIds?: readonly string[];
  /** Explicitly requests full inventory acquisition; writable reads also replace completed data. */
  refreshFullCatalog?: boolean;
  /** Scoped read-only loads may run live discovery for the scoped providers only. */
  scopedLiveProviderDiscovery?: boolean;
  allowGatewaySubagentBinding?: boolean;
};

export type GetPublishedPreparedModelCatalogOwnerParams = Omit<
  LoadPreparedModelCatalogParams,
  "readOnly"
>;

type PreparedModelCatalogConfigPolicy = "exact" | "published";

async function materializeRequestedModelCatalog(
  snapshot: PreparedModelRuntimeSnapshot,
  readOnly: boolean | undefined,
  refreshFullCatalog: LoadPreparedModelCatalogParams["refreshFullCatalog"],
): Promise<PreparedModelRuntimeSnapshot> {
  if (!snapshot.loadFullModelCatalog) {
    return snapshot;
  }
  // Only an explicit refresh request initializes or refreshes inventory.
  const inventoryCatalog =
    refreshFullCatalog === true
      ? await refreshPreparedModelRuntimeCatalog(snapshot, {
          refresh: readOnly !== true,
        })
      : undefined;
  const modelCatalog =
    inventoryCatalog ??
    (readOnly === true
      ? snapshot.readFullModelCatalog?.()
      : await snapshot.loadFullModelCatalog({ refresh: refreshFullCatalog === true }));
  if (!modelCatalog) {
    return snapshot;
  }
  return materializePreparedModelCatalogOwner(snapshot, modelCatalog);
}

/** Carries a completed catalog and its paired auth without acquiring or refreshing facts. */
export function materializePreparedModelCatalogOwner(
  snapshot: PreparedModelRuntimeSnapshot,
  modelCatalog: ModelCatalogSnapshot | undefined = snapshot.readFullModelCatalog?.(),
): PreparedModelRuntimeSnapshot {
  if (!modelCatalog) {
    return snapshot;
  }
  const fullAuth = getPreparedModelFullCatalogAuth(modelCatalog);
  if (!fullAuth) {
    throw new Error("prepared full model catalog omitted its auth generation");
  }
  const materialized = Object.freeze({
    ...snapshot,
    authModes: fullAuth.authModes,
    modelCatalog,
  });
  setPreparedModelRuntimeAuthStore(materialized, fullAuth.authStore);
  // Later explicit auth refreshes stay bound to the original owner generation. Ordinary reads
  // consume the full worker's paired auth without invoking this loader.
  setPreparedModelRuntimeAuthLoader(
    materialized,
    async (scope) => (await loadPreparedModelRuntimeAuth(snapshot, scope)) ?? fullAuth,
  );
  setPreparedModelRuntimeAuthMaterializations(
    materialized,
    getPreparedModelRuntimeAuthMaterializations(snapshot),
  );
  return materialized;
}

function acceptsPreparedSnapshotConfig(
  snapshot: PreparedModelRuntimeSnapshot,
  input: PreparedModelRuntimeInput,
  policy: PreparedModelCatalogConfigPolicy,
): boolean {
  return policy === "published" || preparedModelRuntimeConfigsMatch(snapshot.config, input.config);
}

function resolveInputs(params: LoadPreparedModelCatalogParams = {}): {
  exact: PreparedModelRuntimeInput;
  full: PreparedModelRuntimeInput;
  activationExact: PreparedModelRuntimeInput;
  activationFull: PreparedModelRuntimeInput;
} {
  const config = params.config ?? getRuntimeConfig();
  const explicitOrDefaultAgentId =
    params.agentId ??
    (params.agentDir === undefined ? resolveAmbientOwnerAgentId(config) : undefined);
  const agentDir =
    params.agentDir ?? resolveAgentDir(config, explicitOrDefaultAgentId as string, params.env);
  const matchingAgentIds =
    explicitOrDefaultAgentId !== undefined
      ? []
      : listAgentIds(config).filter(
          (candidateAgentId) => resolveAgentDir(config, candidateAgentId, params.env) === agentDir,
        );
  const agentId =
    explicitOrDefaultAgentId ?? (matchingAgentIds.length === 1 ? matchingAgentIds[0] : undefined);
  const explicitWorkspaceDir = params.workspaceDir === undefined ? undefined : params.workspaceDir;
  const activationWorkspaceDir =
    explicitWorkspaceDir ??
    (agentId ? resolveAgentWorkspaceDir(config, agentId, params.env) : undefined);
  const full: PreparedModelRuntimeInput = {
    ...(agentId ? { agentId } : {}),
    agentDir,
    config,
    ...(params.env ? { env: params.env } : {}),
    inheritedAuthDir: resolveLegacyInheritedAuthDir(config, params.env),
    ...(explicitWorkspaceDir ? { workspaceDir: explicitWorkspaceDir } : {}),
    ...(params.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
  };
  const exact = params.readOnly ? { ...full, readOnly: true } : full;
  const activationFull = activationWorkspaceDir
    ? { ...full, workspaceDir: activationWorkspaceDir }
    : full;
  return {
    exact,
    full,
    activationFull,
    activationExact: params.readOnly ? { ...activationFull, readOnly: true } : activationFull,
  };
}

/** Returns the configured lifecycle owner for the current generation without starting discovery. */
export function getPreparedModelCatalogOwnerSnapshot(
  params: LoadPreparedModelCatalogParams = {},
): PreparedModelRuntimeSnapshot | undefined {
  const { activationExact, activationFull, exact, full } = resolveInputs(params);
  const publishedFull = getPreparedModelRuntimeSnapshot(full);
  if (publishedFull && preparedModelRuntimeConfigsMatch(publishedFull.config, full.config)) {
    return publishedFull;
  }
  if (activationFull.workspaceDir !== full.workspaceDir) {
    const activatedFull = getPreparedModelRuntimeSnapshot(activationFull);
    if (activatedFull && preparedModelRuntimeConfigsMatch(activatedFull.config, full.config)) {
      return activatedFull;
    }
  }
  if (exact === full) {
    return undefined;
  }
  const publishedExact = getPreparedModelRuntimeSnapshot(exact);
  if (publishedExact && preparedModelRuntimeConfigsMatch(publishedExact.config, exact.config)) {
    return publishedExact;
  }
  if (activationExact.workspaceDir === exact.workspaceDir) {
    return undefined;
  }
  const activatedExact = getPreparedModelRuntimeSnapshot(activationExact);
  return activatedExact && preparedModelRuntimeConfigsMatch(activatedExact.config, exact.config)
    ? activatedExact
    : undefined;
}

/**
 * Returns the currently published lifecycle owner and its configured/static turn facts without
 * config hashing, fallback construction, or full control-plane catalog materialization.
 */
export function getPublishedPreparedModelCatalogOwnerSnapshot(
  params: GetPublishedPreparedModelCatalogOwnerParams = {},
): PreparedModelRuntimeSnapshot | undefined {
  const { activationFull, full } = resolveInputs(params);
  const published = getPreparedModelRuntimeSnapshot(full);
  if (published) {
    return published;
  }
  if (activationFull.workspaceDir === full.workspaceDir) {
    return undefined;
  }
  return getPreparedModelRuntimeSnapshot(activationFull);
}

/** Returns the newest published catalog without starting discovery. */
export function getPreparedModelCatalogSnapshot(
  params: LoadPreparedModelCatalogParams = {},
): ModelCatalogSnapshot | undefined {
  const owner = getPreparedModelCatalogOwnerSnapshot(params);
  return owner?.readFullModelCatalog?.() ?? owner?.modelCatalog;
}

async function resolvePreparedModelCatalogOwnerSnapshotWithPolicy(
  params: LoadPreparedModelCatalogParams,
  configPolicy: PreparedModelCatalogConfigPolicy,
): Promise<{ snapshot: PreparedModelRuntimeSnapshot; release?: () => void }> {
  const { activationExact, activationFull, exact, full } = resolveInputs(params);
  if (params.readOnly) {
    const fullCandidates =
      activationFull.workspaceDir === full.workspaceDir ? [full] : [full, activationFull];
    for (const candidate of fullCandidates) {
      try {
        // Full lifecycle owners include provider augmentation omitted by read-only fallback builds.
        const prepared = await prepareModelRuntimeSnapshot(candidate);
        if (!acceptsPreparedSnapshotConfig(prepared, candidate, configPolicy)) {
          throw new PreparedModelCatalogConfigReplacedError(candidate.agentDir);
        }
        return { snapshot: prepared };
      } catch (error) {
        if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
          throw error;
        }
      }
    }
    const lease = await acquireReadOnlyPreparedModelRuntime(activationExact);
    if (!acceptsPreparedSnapshotConfig(lease.snapshot, activationExact, configPolicy)) {
      lease.release();
      throw new PreparedModelCatalogConfigReplacedError(activationExact.agentDir);
    }
    return lease;
  }
  try {
    const preparedExact = await prepareModelRuntimeSnapshot(exact);
    if (acceptsPreparedSnapshotConfig(preparedExact, exact, configPolicy)) {
      return { snapshot: preparedExact };
    }
  } catch (error) {
    if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
      throw error;
    }
  }
  // Direct commands own a persistent standalone generation. During gateway lifetime, writable
  // publication belongs exclusively to startup/reload or agent-run admission.
  const activated = await activateStandalonePreparedModelRuntime(activationExact, {
    catalogMode: "static",
  });
  if (activated && acceptsPreparedSnapshotConfig(activated, activationExact, configPolicy)) {
    return { snapshot: activated };
  }
  if (activated) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared model catalog owner was not published for the requested config (${activationExact.agentDir})`,
    );
  }
  // Gateway pre-run selection can name a spawned workspace before embedded-run admission.
  // Lease a complete exact generation so provider catalog hooks remain visible for this read.
  const lease = await acquireAgentRunPreparedModelRuntime(activationFull);
  if (!acceptsPreparedSnapshotConfig(lease.snapshot, activationFull, configPolicy)) {
    lease.release();
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared model catalog owner was not published for the requested config (${activationFull.agentDir})`,
    );
  }
  return lease;
}

async function withPreparedModelCatalogOwnerPolicy<T>(
  params: LoadPreparedModelCatalogParams,
  configPolicy: PreparedModelCatalogConfigPolicy,
  read: (snapshot: PreparedModelRuntimeSnapshot) => T | Promise<T>,
): Promise<T> {
  // Ordinary reads stay passive; explicit refresh keeps its existing writable default.
  const request = {
    ...params,
    readOnly: params.readOnly ?? params.refreshFullCatalog !== true,
  };
  const publishedReadOnlyOwner = request.readOnly
    ? getPreparedModelCatalogOwnerSnapshot(request)
    : undefined;
  const { snapshot, release } = await resolvePreparedModelCatalogOwnerSnapshotWithPolicy(
    request,
    configPolicy,
  );
  try {
    // Only published owners expose generation caches; temporary reads use their prepared facts.
    const owner =
      request.readOnly && !publishedReadOnlyOwner
        ? snapshot
        : await materializeRequestedModelCatalog(
            snapshot,
            request.readOnly,
            request.refreshFullCatalog,
          );
    // Projection must finish before a temporary lease retires its liveness predicate.
    return await read(owner);
  } finally {
    release?.();
  }
}

async function loadScopedReadOnlyModelCatalog(
  params: LoadPreparedModelCatalogParams,
): Promise<ModelCatalogSnapshot> {
  const { activationExact, activationFull, full } = resolveInputs(params);
  const fullCandidates =
    activationFull.workspaceDir === full.workspaceDir ? [full] : [full, activationFull];
  for (const candidate of fullCandidates) {
    try {
      const prepared = await prepareModelRuntimeSnapshot(candidate);
      if (!preparedModelRuntimeConfigsMatch(prepared.config, candidate.config)) {
        continue;
      }
      if (isPreparedModelCatalogFull(prepared.modelCatalog)) {
        return prepared.modelCatalog;
      }
    } catch (error) {
      if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
        throw error;
      }
    }
  }
  const prepareScoped =
    params.scopedLiveProviderDiscovery === true
      ? prepareScopedReadOnlyLiveModelCatalog
      : prepareScopedReadOnlyModelCatalog;
  return prepareScoped(activationExact, params.providerDiscoveryProviderIds ?? []);
}

/**
 * Missing turn-path capabilities do not authorize another inventory. Keep native harness
 * observations on their existing owner and hold temporary catalog reads through projection.
 */
export async function loadProviderScopedThinkingCatalog(params: {
  config: OpenClawConfig;
  provider: string;
  model: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  /** Input preparation must resolve modalities for this route, independently of reasoning. */
  requiredInputRoute?: Pick<ModelCatalogEntry, "api" | "baseUrl">;
}): Promise<ModelCatalogEntry[]> {
  return await withPreparedModelCatalogOwner(
    {
      config: params.config,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.agentDir ? { agentDir: params.agentDir } : {}),
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      readOnly: true,
    },
    async (owner) => {
      const agentId = params.agentId ?? resolveAmbientOwnerAgentId(params.config);
      const { augmentModelCatalogWithAgentHarness } = await import("./harness/model-catalog.js");
      const snapshot = await augmentModelCatalogWithAgentHarness({
        cfg: params.config,
        agentId,
        agentDir: params.agentDir ?? resolveAgentDir(params.config, agentId),
        workspaceDir:
          params.workspaceDir ??
          resolveAgentWorkspaceDir(params.config, agentId) ??
          resolveDefaultAgentWorkspaceDir(),
        defaultProvider: params.provider,
        defaultModel: `${params.provider}/${params.model}`,
        snapshot: owner.modelCatalog,
      });
      const entries = normalizeThinkingCatalogProviders(snapshot.entries);
      if (params.requiredInputRoute !== undefined) {
        const entry = findModelInCatalog(entries, params.provider, params.model);
        if (
          entry?.input === undefined ||
          !modelTransportRoutesMatch(entry, params.requiredInputRoute)
        ) {
          return [];
        }
      }
      return entries;
    },
  );
}

/** Keeps the exact catalog owner alive through an asynchronous read. */
export async function withPreparedModelCatalogOwner<T>(
  params: LoadPreparedModelCatalogParams,
  read: (snapshot: PreparedModelRuntimeSnapshot) => T | Promise<T>,
): Promise<T> {
  return await withPreparedModelCatalogOwnerPolicy(params, "exact", read);
}

/** Resolves the lifecycle owner for an exact caller-supplied config. */
export async function loadPreparedModelCatalogOwnerSnapshot(
  params: LoadPreparedModelCatalogParams = {},
): Promise<PreparedModelRuntimeSnapshot> {
  return await withPreparedModelCatalogOwnerPolicy(params, "exact", (snapshot) => snapshot);
}

/** Resolves the currently published owner when Gateway config changes during the read. */
export async function loadPublishedPreparedModelCatalogOwnerSnapshot(
  params: LoadPreparedModelCatalogParams = {},
): Promise<PreparedModelRuntimeSnapshot> {
  return await withPreparedModelCatalogOwnerPolicy(params, "published", (snapshot) => snapshot);
}

/** Resolves a complete published owner for long-lived runtime consumers. */
export async function loadResolvedPublishedModelCatalogOwner(
  params: LoadPreparedModelCatalogParams = {},
): Promise<ResolvedPublishedModelCatalogOwner> {
  return resolvePublishedModelCatalogOwner(
    await loadPublishedPreparedModelCatalogOwnerSnapshot(params),
  );
}

/** Reads one atomic catalog generation, activating a lifecycle owner when needed. */
export async function loadPreparedModelCatalogSnapshot(
  params: LoadPreparedModelCatalogParams = {},
): Promise<ModelCatalogSnapshot> {
  const readOnly = params.readOnly ?? params.refreshFullCatalog !== true;
  if (readOnly && params.providerDiscoveryProviderIds) {
    return loadScopedReadOnlyModelCatalog({ ...params, readOnly });
  }
  return (await loadPreparedModelCatalogOwnerSnapshot(params)).modelCatalog;
}

export async function loadPreparedModelCatalog(
  params: LoadPreparedModelCatalogParams = {},
): Promise<ModelCatalogEntry[]> {
  return (await loadPreparedModelCatalogSnapshot(params)).entries;
}

/** Reads the committed owner generation for long-lived runtime work. */
export async function loadPublishedPreparedModelCatalog(
  params: LoadPreparedModelCatalogParams = {},
): Promise<ModelCatalogEntry[]> {
  return (await loadPublishedPreparedModelCatalogOwnerSnapshot(params)).modelCatalog.entries;
}
