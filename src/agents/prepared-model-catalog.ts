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
  bindPreparedModelRuntimeAuth,
} from "./prepared-model-runtime-auth.js";
import {
  PreparedModelCatalogGenerationMismatchError,
  PreparedModelRuntimePublicationSupersededError,
} from "./prepared-model-runtime.errors.js";
import { isPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquirePreparedModelRuntimeSnapshot,
  acquireReadOnlyPreparedModelRuntime,
  activateStandalonePreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  prepareModelRuntimeSnapshot,
  PreparedModelRuntimeOwnerNotPublishedError,
  preparedModelRuntimeConfigsMatch,
  replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch,
  refreshPreparedModelRuntimeCatalog,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import { prepareScopedReadOnlyModelCatalog } from "./prepared-model-runtime.scoped-catalog.js";
import { normalizeThinkingCatalogProviders } from "./thinking-runtime.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

export { withPreparedModelRuntimeReadBatch } from "./prepared-model-runtime.owner.js";

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
type PreparedModelCatalogOwner = {
  snapshot: PreparedModelRuntimeSnapshot;
  release?: () => void | Promise<void>;
};

async function preparePublishedCatalogOwner(
  input: PreparedModelRuntimeInput,
): Promise<PreparedModelCatalogOwner> {
  return { snapshot: await prepareModelRuntimeSnapshot(input) };
}

async function materializeRequestedModelCatalog(
  snapshot: PreparedModelRuntimeSnapshot,
  readOnly: boolean | undefined,
  refreshFullCatalog: LoadPreparedModelCatalogParams["refreshFullCatalog"],
  providerIds?: readonly string[],
): Promise<PreparedModelRuntimeSnapshot> {
  if (!snapshot.loadFullModelCatalog) {
    return snapshot;
  }
  let modelCatalog: ModelCatalogSnapshot | undefined;
  try {
    // Explicit refresh waits for acquisition; ordinary reads return saved rows during renewal.
    const inventoryCatalog =
      refreshFullCatalog === true
        ? await refreshPreparedModelRuntimeCatalog(snapshot, {
            refresh: readOnly !== true,
            ...(providerIds ? { providerIds } : {}),
          })
        : undefined;
    modelCatalog =
      inventoryCatalog ??
      (readOnly === true
        ? snapshot.readFullModelCatalog?.()
        : await snapshot.loadFullModelCatalog({
            refresh: refreshFullCatalog === true,
            ...(providerIds ? { providerIds } : {}),
          }));
  } catch (error) {
    if (
      error instanceof PreparedModelCatalogGenerationMismatchError &&
      error.agentDir === snapshot.agentDir &&
      (await replacePreparedModelRuntimeSnapshotAfterCatalogGenerationMismatch(snapshot))
    ) {
      throw new PreparedModelRuntimePublicationSupersededError(
        `prepared model runtime catalog generation was replaced for ${snapshot.agentDir}`,
      );
    }
    throw error;
  }
  if (!modelCatalog) {
    return snapshot;
  }
  return materializePreparedModelCatalogOwner(snapshot, modelCatalog);
}

/** Carries the published catalog and paired auth while expired inventory renews separately. */
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
  // Later explicit auth refreshes stay bound to the original owner generation. Ordinary reads
  // consume the full worker's paired auth without invoking this loader.
  bindPreparedModelRuntimeAuth(materialized, {
    store: fullAuth.authStore,
    labels: fullAuth.providerAuthLabels,
    load: async (scope) => (await loadPreparedModelRuntimeAuth(snapshot, scope)) ?? fullAuth,
    materializations: getPreparedModelRuntimeAuthMaterializations(snapshot),
  });
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
  const activationWorkspaceDir =
    params.workspaceDir ??
    (agentId ? resolveAgentWorkspaceDir(config, agentId, params.env) : undefined);
  const full: PreparedModelRuntimeInput = {
    ...(agentId ? { agentId } : {}),
    agentDir,
    config,
    ...(params.env ? { env: params.env } : {}),
    inheritedAuthDir: resolveLegacyInheritedAuthDir(config, params.env),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
  };
  const exact = params.readOnly ? { ...full, readOnly: true } : full;
  const activationFull =
    activationWorkspaceDir && activationWorkspaceDir !== full.workspaceDir
      ? { ...full, workspaceDir: activationWorkspaceDir }
      : full;
  return {
    exact,
    full,
    activationFull,
    activationExact:
      activationFull === full
        ? exact
        : params.readOnly
          ? { ...activationFull, readOnly: true }
          : activationFull,
  };
}

function findPreparedCatalogOwner(
  candidates: readonly PreparedModelRuntimeInput[],
  policy: PreparedModelCatalogConfigPolicy,
): PreparedModelRuntimeSnapshot | undefined {
  for (const candidate of new Set(candidates)) {
    const snapshot = getPreparedModelRuntimeSnapshot(candidate);
    if (snapshot && acceptsPreparedSnapshotConfig(snapshot, candidate, policy)) {
      return snapshot;
    }
  }
  return undefined;
}

/** Returns the configured lifecycle owner for the current generation without starting discovery. */
export function getPreparedModelCatalogOwnerSnapshot(
  params: LoadPreparedModelCatalogParams = {},
): PreparedModelRuntimeSnapshot | undefined {
  const { activationExact, activationFull, exact, full } = resolveInputs(params);
  return findPreparedCatalogOwner([full, activationFull, exact, activationExact], "exact");
}

/**
 * Returns the currently published lifecycle owner and its configured/static turn facts without
 * config hashing, fallback construction, or full control-plane catalog materialization.
 */
export function getPublishedPreparedModelCatalogOwnerSnapshot(
  params: GetPublishedPreparedModelCatalogOwnerParams = {},
): PreparedModelRuntimeSnapshot | undefined {
  const { activationFull, full } = resolveInputs(params);
  return findPreparedCatalogOwner([full, activationFull], "published");
}

/** Requests expiry renewal for an inventory consumer without waiting for discovery. */
export function refreshExpiredPreparedModelCatalog(
  params: LoadPreparedModelCatalogParams = {},
): ModelCatalogSnapshot | undefined {
  const owner = getPreparedModelCatalogOwnerSnapshot(params);
  owner?.refreshExpiredModelCatalog?.();
  return owner?.readFullModelCatalog?.() ?? owner?.modelCatalog;
}

/** Reads accepted inventory without starting acquisition from an observation. */
export function getPreparedModelCatalogSnapshot(
  params: LoadPreparedModelCatalogParams = {},
): ModelCatalogSnapshot | undefined {
  const owner = getPreparedModelCatalogOwnerSnapshot(params);
  return owner?.readFullModelCatalog?.() ?? owner?.modelCatalog;
}

async function resolveReadOnlyPublishedModelCatalogOwner(
  params: LoadPreparedModelCatalogParams,
  configPolicy: PreparedModelCatalogConfigPolicy,
  preparePublishedOwner = preparePublishedCatalogOwner,
  selection: "owner" | "completed-inventory" = "owner",
): Promise<PreparedModelCatalogOwner | undefined> {
  const { activationFull, full } = resolveInputs(params);
  for (const candidate of new Set([full, activationFull])) {
    try {
      // Full lifecycle owners include provider augmentation omitted by read-only fallback builds.
      const prepared = await preparePublishedOwner(candidate);
      const matches = acceptsPreparedSnapshotConfig(prepared.snapshot, candidate, configPolicy);
      if (
        matches &&
        (selection === "owner" || isPreparedModelCatalogFull(prepared.snapshot.modelCatalog))
      ) {
        return prepared;
      }
      await prepared.release?.();
      if (!matches && selection === "owner") {
        throw new PreparedModelCatalogConfigReplacedError(candidate.agentDir);
      }
    } catch (error) {
      if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
        throw error;
      }
    }
  }
  return undefined;
}

async function resolvePreparedModelCatalogOwnerSnapshotWithPolicy(
  params: LoadPreparedModelCatalogParams,
  configPolicy: PreparedModelCatalogConfigPolicy,
  preparePublishedOwner = preparePublishedCatalogOwner,
): Promise<PreparedModelCatalogOwner> {
  const { activationExact, activationFull, exact } = resolveInputs(params);
  if (params.readOnly) {
    const prepared = await resolveReadOnlyPublishedModelCatalogOwner(
      params,
      configPolicy,
      preparePublishedOwner,
    );
    if (prepared) {
      return prepared;
    }
    const lease = await acquireReadOnlyPreparedModelRuntime(activationExact);
    if (!acceptsPreparedSnapshotConfig(lease.snapshot, activationExact, configPolicy)) {
      await using _ = lease;
      throw new PreparedModelCatalogConfigReplacedError(activationExact.agentDir);
    }
    return { snapshot: lease.snapshot, release: () => lease[Symbol.asyncDispose]() };
  }
  try {
    const preparedExact = await preparePublishedOwner(exact);
    if (acceptsPreparedSnapshotConfig(preparedExact.snapshot, exact, configPolicy)) {
      return preparedExact;
    }
    await preparedExact.release?.();
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
    await using _ = lease;
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared model catalog owner was not published for the requested config (${activationFull.agentDir})`,
    );
  }
  return { snapshot: lease.snapshot, release: () => lease[Symbol.asyncDispose]() };
}

async function withPreparedModelCatalogOwnerPolicy<T>(
  params: LoadPreparedModelCatalogParams,
  configPolicy: PreparedModelCatalogConfigPolicy,
  read: (snapshot: PreparedModelRuntimeSnapshot) => T | Promise<T>,
  preparePublishedOwner = preparePublishedCatalogOwner,
): Promise<T> {
  // Ordinary reads return published rows; explicit refresh keeps its writable default.
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
    preparePublishedOwner,
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
            request.providerDiscoveryProviderIds,
          );
    // Projection must finish before releasing the selected generation's resources.
    return await read(owner);
  } finally {
    await release?.();
  }
}

async function loadScopedReadOnlyModelCatalog(
  params: LoadPreparedModelCatalogParams,
): Promise<ModelCatalogSnapshot> {
  const { activationExact } = resolveInputs(params);
  const prepared = await resolveReadOnlyPublishedModelCatalogOwner(
    params,
    "exact",
    preparePublishedCatalogOwner,
    "completed-inventory",
  );
  if (prepared) {
    return prepared.snapshot.modelCatalog;
  }
  return prepareScopedReadOnlyModelCatalog(
    activationExact,
    params.providerDiscoveryProviderIds ?? [],
    params.scopedLiveProviderDiscovery === true ? "live" : "static",
  );
}

/**
 * Missing turn-path capabilities do not authorize another inventory, even without a published
 * owner. Native harness observations keep their existing owner.
 */
export async function loadProviderScopedThinkingCatalog(params: {
  config: OpenClawConfig;
  provider: string;
  model: string;
  /** Concrete runtime selected by the turn owner, including session overrides. */
  agentRuntime?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  /** Input preparation must resolve modalities for this route, independently of reasoning. */
  requiredInputRoute?: Pick<ModelCatalogEntry, "api" | "baseUrl">;
}): Promise<ModelCatalogEntry[]> {
  const request = { ...params, readOnly: true };
  const publishedOwner = getPreparedModelCatalogOwnerSnapshot(request);
  const owner = (await resolveReadOnlyPublishedModelCatalogOwner(request, "exact"))?.snapshot;
  let snapshot: ModelCatalogSnapshot;
  if (owner?.loadNativeModelCatalog && params.agentRuntime && params.agentRuntime !== "openclaw") {
    snapshot = await owner.loadNativeModelCatalog({
      provider: params.provider,
      modelId: params.model,
      runtime: params.agentRuntime,
    });
  } else {
    const catalog = owner
      ? (publishedOwner ? await materializeRequestedModelCatalog(owner, true, undefined) : owner)
          .modelCatalog
      : { entries: [], routeVariants: [] };
    const agentId = params.agentId ?? resolveAmbientOwnerAgentId(params.config);
    const { augmentModelCatalogWithAgentHarness } = await import("./harness/model-catalog.js");
    snapshot = await augmentModelCatalogWithAgentHarness({
      cfg: params.config,
      agentId,
      agentDir: params.agentDir ?? resolveAgentDir(params.config, agentId),
      workspaceDir:
        params.workspaceDir ??
        resolveAgentWorkspaceDir(params.config, agentId) ??
        resolveDefaultAgentWorkspaceDir(),
      defaultProvider: params.provider,
      defaultModel: `${params.provider}/${params.model}`,
      agentRuntime: params.agentRuntime,
      snapshot: catalog,
    });
  }
  let entries = snapshot.entries;
  if (params.agentRuntime) {
    const entry = findModelInCatalog(entries, params.provider, params.model);
    if (entry) {
      // A logical row may belong to another picker runtime; retain only the selected donor.
      const { selectModelCatalogRuntimeEntry } = await import("./model-catalog-view.js");
      const selected = selectModelCatalogRuntimeEntry({
        entry,
        routeVariants: snapshot.routeVariants,
        runtimeId: params.agentRuntime,
      }).entry;
      entries = entries.map((candidate) => (candidate === entry ? selected : candidate));
    }
  }
  entries = normalizeThinkingCatalogProviders(entries);
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
}

/** Retains published or temporary catalog resources through an asynchronous read. */
export async function withPreparedModelCatalogOwner<T>(
  params: LoadPreparedModelCatalogParams,
  read: (snapshot: PreparedModelRuntimeSnapshot) => T | Promise<T>,
): Promise<T> {
  return await withPreparedModelCatalogOwnerPolicy(params, "exact", read, async (input) => {
    const lease = await acquirePreparedModelRuntimeSnapshot(input);
    return { snapshot: lease.snapshot, release: () => lease[Symbol.asyncDispose]() };
  });
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

export async function readPreparedModelCatalog(
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
