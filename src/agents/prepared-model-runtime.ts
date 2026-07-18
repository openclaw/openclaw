/** Lifecycle-owned auth/model discovery snapshots for agent runs. */
import path from "node:path";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import { MODEL_APIS } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withTimeout } from "../node-host/with-timeout.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { discoverAuthStorage, discoverModels } from "./agent-model-discovery.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from "./agent-scope.js";
import { registerRuntimeAuthProfileStoreMutationListener } from "./auth-profiles/runtime-snapshots.js";
import { loadBundledProviderStaticCatalogContextModels } from "./embedded-agent-runner/model.static-catalog.js";
import {
  buildPreparedModelCatalogSnapshot,
  type ModelCatalogEntry,
  type ModelCatalogSnapshot,
} from "./model-catalog.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { ensureRuntimePluginsLoaded } from "./runtime-plugins.js";
import { AuthStorage, type ModelRegistry } from "./sessions/index.js";

const log = createSubsystemLogger("agents/prepared-model-runtime");
const MODEL_RUNTIME_PROVIDER_DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_MODEL_RUNTIME_BUILD_TIMEOUT_MS = 30_000;
let modelRuntimeBuildTimeoutMs = DEFAULT_MODEL_RUNTIME_BUILD_TIMEOUT_MS;

export type PreparedModelRuntimeSnapshot = Readonly<{
  agentId?: string;
  agentDir: string;
  inheritedAuthDir?: string;
  workspaceDir?: string;
  config: OpenClawConfig;
  metadataSnapshot: PluginMetadataSnapshot;
  modelCatalog: ModelCatalogSnapshot;
  createStores: () => PreparedModelRuntimeStores;
}>;

export type PreparedModelRuntimeStores = {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
};

export type PreparedModelRuntimeInput = {
  agentId?: string;
  agentDir: string;
  inheritedAuthDir?: string;
  workspaceDir?: string;
  preserveWorkspaceDirOnRefresh?: boolean;
  readOnly?: boolean;
  skipCredentials?: boolean;
  env?: NodeJS.ProcessEnv;
  config: OpenClawConfig;
};

type PreparedModelRuntimeOwner = {
  input: PreparedModelRuntimeInput;
  environmentFingerprint: string;
  provenance: "configured" | "standalone" | "explicit" | "run" | "ephemeral";
  generation: number;
  needsRefresh: boolean;
  refreshError?: Error;
  snapshot?: PreparedModelRuntimeSnapshot;
  pending?: Promise<PreparedModelRuntimeSnapshot>;
  buildCompletion?: Promise<void>;
  leaseCount?: number;
};

export type PreparedModelRuntimeLease = Readonly<{
  snapshot: PreparedModelRuntimeSnapshot;
  release: () => void;
}>;

const owners = new Map<string, PreparedModelRuntimeOwner>();
const agentBuildCompletions = new Map<string, Promise<void>>();
let gatewayLifecycleActive = false;
let refreshTail: Promise<void> = Promise.resolve();
let refreshRequestEpoch = 0;
type PreparedModelRuntimeReplacement = {
  gateId: PreparedModelRuntimeReplacementGateId;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};
export type PreparedModelRuntimeReplacementGateId = symbol;
let pendingModelRuntimeReplacement: PreparedModelRuntimeReplacement | undefined;
type AuthMutationEvent = { agentDir?: string; affectsInheritedStores: boolean };
const pendingAuthMutations: AuthMutationEvent[] = [];

export class PreparedModelRuntimeOwnerNotPublishedError extends Error {}

class PreparedModelRuntimePublicationSupersededError extends PreparedModelRuntimeOwnerNotPublishedError {}

function rebindInputToCommittedConfiguredOwner(
  rawInput: PreparedModelRuntimeInput,
): PreparedModelRuntimeInput {
  const input = normalizeInput(rawInput);
  const candidates = [...owners.values()].filter(
    (owner) =>
      owner.provenance === "configured" &&
      owner.snapshot &&
      !owner.needsRefresh &&
      !owner.pending &&
      (input.agentId === undefined
        ? owner.input.agentDir === input.agentDir
        : owner.input.agentId === input.agentId),
  );
  if (candidates.length !== 1) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared model runtime owner was not committed after replacement for ${input.agentDir}`,
    );
  }
  const owner = candidates[0]!;
  const preserveWorkspaceDir =
    input.preserveWorkspaceDirOnRefresh === true && input.workspaceDir !== undefined;
  return normalizeInput({
    ...input,
    ...(owner.input.agentId ? { agentId: owner.input.agentId } : {}),
    agentDir: owner.input.agentDir,
    config: owner.input.config,
    inheritedAuthDir: owner.input.inheritedAuthDir,
    env: owner.input.env,
    workspaceDir: preserveWorkspaceDir ? input.workspaceDir : owner.input.workspaceDir,
    preserveWorkspaceDirOnRefresh: preserveWorkspaceDir,
  });
}

/** Accepts canonical config clones without weakening projected-config isolation. */
export function preparedModelRuntimeConfigsMatch(
  left: OpenClawConfig,
  right: OpenClawConfig,
): boolean {
  if (left === right) {
    return true;
  }
  try {
    return hashRuntimeConfigValue(left) === hashRuntimeConfigValue(right);
  } catch {
    return false;
  }
}

function normalizeOptionalDir(dirname: string | undefined): string | undefined {
  return dirname ? path.resolve(dirname) : undefined;
}

/** Resolves a published owner or activates a standalone lifecycle owner. */
export async function loadPreparedModelRuntimeSnapshot(
  rawInput: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeSnapshot> {
  let input = normalizeInput({
    ...rawInput,
    preserveWorkspaceDirOnRefresh:
      rawInput.preserveWorkspaceDirOnRefresh ?? rawInput.workspaceDir !== undefined,
  });
  for (;;) {
    const replacement = pendingModelRuntimeReplacement;
    if (replacement) {
      await replacement.promise;
      if (pendingModelRuntimeReplacement) {
        continue;
      }
      input = rebindInputToCommittedConfiguredOwner(input);
      continue;
    }
    try {
      return await prepareModelRuntimeSnapshot(input);
    } catch (error) {
      if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
        throw error;
      }
    }
    const activationGate = pendingModelRuntimeReplacement;
    if (activationGate) {
      await activationGate.promise;
      if (pendingModelRuntimeReplacement) {
        continue;
      }
      input = rebindInputToCommittedConfiguredOwner(input);
      continue;
    }
    const activated = await activateStandalonePreparedModelRuntime(input);
    const replacementAfterActivation = pendingModelRuntimeReplacement;
    if (replacementAfterActivation) {
      await replacementAfterActivation.promise;
      if (pendingModelRuntimeReplacement) {
        continue;
      }
      input = rebindInputToCommittedConfiguredOwner(input);
      continue;
    }
    if (!activated) {
      return await prepareModelRuntimeSnapshot(input);
    }
    try {
      return await prepareModelRuntimeSnapshot(input);
    } catch (error) {
      if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
        throw error;
      }
      // A concurrent publication boundary may retire the standalone owner between build and read.
      // Retry only after proving that no replacement gate owns the next generation.
    }
  }
}

/** Returns an already-published generation without starting discovery. */
export function getPreparedModelRuntimeSnapshot(
  rawInput: PreparedModelRuntimeInput,
): PreparedModelRuntimeSnapshot | undefined {
  if (pendingModelRuntimeReplacement) {
    return undefined;
  }
  const input = normalizeInput(rawInput);
  const owner = resolvePublishedOwner(input, {
    allowConfiguredWorkspaceFallback:
      rawInput.workspaceDir === undefined || rawInput.agentId === undefined,
  });
  if (!owner?.snapshot || owner.needsRefresh || owner.pending) {
    return undefined;
  }
  if (input.readOnly && !preparedModelRuntimeConfigsMatch(owner.input.config, input.config)) {
    return undefined;
  }
  return owner.snapshot;
}

function normalizeInput(input: PreparedModelRuntimeInput): PreparedModelRuntimeInput {
  const {
    inheritedAuthDir: _inheritedAuthDir,
    readOnly,
    skipCredentials,
    workspaceDir: _workspaceDir,
    ...rest
  } = input;
  const inheritedAuthDir = normalizeOptionalDir(
    input.inheritedAuthDir ?? resolveDefaultAgentDir(input.config, input.env),
  );
  const workspaceDir = normalizeOptionalDir(input.workspaceDir);
  const env = input.env ? Object.freeze({ ...input.env }) : undefined;
  return {
    ...rest,
    agentDir: path.resolve(input.agentDir),
    ...(inheritedAuthDir ? { inheritedAuthDir } : {}),
    ...(readOnly === true ? { readOnly: true } : {}),
    ...(skipCredentials === true ? { skipCredentials: true } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(env ? { env } : {}),
  };
}

function environmentFingerprint(env: NodeJS.ProcessEnv | undefined): string | undefined {
  return env ? hashRuntimeConfigValue(env) : undefined;
}

function effectiveEnvironmentFingerprint(input: PreparedModelRuntimeInput): string {
  return hashRuntimeConfigValue(input.env ?? process.env);
}

function isCatalogModelApi(
  value: string | undefined,
): value is NonNullable<ModelCatalogEntry["api"]> {
  return value !== undefined && (MODEL_APIS as readonly string[]).includes(value);
}

function toStaticCatalogEntry(
  model: Awaited<ReturnType<typeof loadBundledProviderStaticCatalogContextModels>>[number],
): ModelCatalogEntry {
  return {
    id: model.id,
    name: model.name ?? model.id,
    provider: model.provider,
    ...(isCatalogModelApi(model.api) ? { api: model.api } : {}),
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.contextTokens ? { contextTokens: model.contextTokens } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.input ? { input: model.input } : {}),
    ...(model.params ? { params: model.params } : {}),
    ...(model.compat ? { compat: model.compat } : {}),
    ...(model.mediaInput ? { mediaInput: model.mediaInput } : {}),
  };
}

function ownerKey(input: PreparedModelRuntimeInput): string {
  return JSON.stringify({
    agentId: input.agentId,
    agentDir: input.agentDir,
    inheritedAuthDir: input.inheritedAuthDir,
    readOnly: input.readOnly === true,
    skipCredentials: input.skipCredentials === true,
    workspaceDir: input.workspaceDir,
    env: environmentFingerprint(input.env),
    config: input.readOnly ? hashRuntimeConfigValue(input.config) : undefined,
  });
}

function resolvePublishedOwner(
  input: PreparedModelRuntimeInput,
  options: { allowConfiguredWorkspaceFallback?: boolean } = {},
): PreparedModelRuntimeOwner | undefined {
  const exact = owners.get(ownerKey(input));
  if (exact) {
    return exact;
  }
  if (!options.allowConfiguredWorkspaceFallback) {
    return undefined;
  }
  // Gateway launch may supply an authoritative workspace outside config. Request readers still
  // resolve the one configured lifecycle owner by agent; standalone/explicit owners remain exact.
  const candidates = [...owners.values()].filter(
    (owner) =>
      owner.provenance === "configured" &&
      (input.agentId === undefined || owner.input.agentId === input.agentId) &&
      owner.input.agentDir === input.agentDir &&
      owner.input.inheritedAuthDir === input.inheritedAuthDir &&
      owner.input.readOnly === input.readOnly &&
      owner.input.skipCredentials === input.skipCredentials &&
      (input.env === undefined ||
        owner.environmentFingerprint === environmentFingerprint(input.env)) &&
      (input.workspaceDir === undefined || owner.input.workspaceDir === input.workspaceDir),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function hasSameLifecycleInput(
  left: PreparedModelRuntimeInput,
  right: PreparedModelRuntimeInput,
): boolean {
  return (
    left.config === right.config &&
    left.agentId === right.agentId &&
    left.inheritedAuthDir === right.inheritedAuthDir &&
    left.readOnly === right.readOnly &&
    left.skipCredentials === right.skipCredentials &&
    left.workspaceDir === right.workspaceDir &&
    environmentFingerprint(left.env) === environmentFingerprint(right.env) &&
    left.preserveWorkspaceDirOnRefresh === right.preserveWorkspaceDirOnRefresh
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createPreparedModelRuntimeReplacement(): PreparedModelRuntimeReplacement {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // Readers await the original promise. This handler only prevents an unobserved rejected gate
  // when a reload fails before any request reaches the stale generation.
  void promise.catch(() => undefined);
  return { gateId: Symbol("prepared-model-runtime-replacement"), promise, resolve, reject };
}

function listConfiguredOwnerInputs(
  config: OpenClawConfig,
  defaultWorkspaceDir?: string,
): PreparedModelRuntimeInput[] {
  const inheritedAuthDir = resolveDefaultAgentDir(config);
  const defaultAgentId = resolveDefaultAgentId(config);
  return listAgentIds(config).map((agentId) => {
    const preserveWorkspaceDirOnRefresh = agentId === defaultAgentId && defaultWorkspaceDir;
    const input: PreparedModelRuntimeInput = {
      agentId,
      agentDir: resolveAgentDir(config, agentId),
      config,
      inheritedAuthDir,
      workspaceDir: preserveWorkspaceDirOnRefresh
        ? defaultWorkspaceDir
        : resolveAgentWorkspaceDir(config, agentId),
    };
    if (preserveWorkspaceDirOnRefresh) {
      input.preserveWorkspaceDirOnRefresh = true;
    }
    return input;
  });
}

async function buildSnapshot(
  input: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeSnapshot> {
  const env = input.env ?? process.env;
  if (!input.readOnly) {
    // Writable lifecycle publication owns process-global runtime plugin activation. Read-only
    // drafts consume manifest metadata only and must not mutate live hooks outside that gate.
    ensureRuntimePluginsLoaded({
      config: input.config,
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    });
  }
  const pluginMetadataSnapshot = resolvePluginMetadataSnapshot({
    config: input.config,
    env,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  if (!input.readOnly) {
    await ensureOpenClawModelsJson(input.config, input.agentDir, {
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
      ...(input.env ? { env } : {}),
      providerDiscoveryTimeoutMs: MODEL_RUNTIME_PROVIDER_DISCOVERY_TIMEOUT_MS,
    });
  }
  const templateAuthStorage = discoverAuthStorage(input.agentDir, {
    config: input.config,
    // Snapshot construction never initializes, migrates, or externally syncs auth. A writable
    // generation performs its file preparation above; ModelRegistry discovery only parses it.
    readOnly: true,
    ...(input.skipCredentials ? { skipCredentials: true } : {}),
    ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    ...(input.env ? { env } : {}),
  });
  const templateModelRegistry = discoverModels(templateAuthStorage, input.agentDir, {
    config: input.config,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
  });
  const credentials = templateAuthStorage.getAll();
  const modelCatalog = await buildPreparedModelCatalogSnapshot({
    agentDir: input.agentDir,
    authCredentials: credentials,
    config: input.config,
    modelRegistry: templateModelRegistry,
    metadataSnapshot: pluginMetadataSnapshot,
    ...(input.env ? { env } : {}),
    ...(input.readOnly ? { readOnly: true } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  const staticEntries = (
    await loadBundledProviderStaticCatalogContextModels({
      cfg: input.config,
      env,
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    })
  ).map(toStaticCatalogEntry);
  const createStores = (): PreparedModelRuntimeStores => {
    // Runtime API keys and session extensions mutate these objects. Fork them per run while the
    // credential map and parsed catalog remain owned by the lifecycle snapshot.
    const authStorage = AuthStorage.inMemory(credentials);
    return { authStorage, modelRegistry: templateModelRegistry.fork(authStorage) };
  };
  return Object.freeze({
    ...(input.agentId ? { agentId: input.agentId } : {}),
    agentDir: input.agentDir,
    ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    config: input.config,
    metadataSnapshot: pluginMetadataSnapshot,
    modelCatalog: { ...modelCatalog, staticEntries },
    createStores,
  });
}

function startSerializedSnapshotBuild(input: PreparedModelRuntimeInput): {
  pending: Promise<PreparedModelRuntimeSnapshot>;
  completion: Promise<void>;
} {
  const previousBuildCompletion = agentBuildCompletions.get(input.agentDir);
  // Lifecycle events may overlap. The timeout covers queueing plus this build, while completion
  // follows the real work so a timed-out generation can never overlap a replacement.
  const startBuild = (async () => {
    if (previousBuildCompletion) {
      await previousBuildCompletion;
    }
    return { actualBuild: buildSnapshot(input) };
  })();
  const completion = startBuild
    .then(async ({ actualBuild }) => await actualBuild)
    .then(
      () => undefined,
      () => undefined,
    );
  agentBuildCompletions.set(input.agentDir, completion);
  void completion.then(() => {
    if (agentBuildCompletions.get(input.agentDir) === completion) {
      agentBuildCompletions.delete(input.agentDir);
    }
  });
  return {
    pending: withTimeout(
      async () => {
        const { actualBuild } = await startBuild;
        return await actualBuild;
      },
      modelRuntimeBuildTimeoutMs,
      "prepared model runtime publication",
    ),
    completion,
  };
}

async function publishModelRuntimeSnapshot(
  input: PreparedModelRuntimeInput,
  existing?: PreparedModelRuntimeOwner,
  provenance: PreparedModelRuntimeOwner["provenance"] = "explicit",
): Promise<PreparedModelRuntimeSnapshot> {
  const key = ownerKey(input);
  const owner: PreparedModelRuntimeOwner = existing ?? {
    input,
    environmentFingerprint: effectiveEnvironmentFingerprint(input),
    provenance,
    generation: 0,
    needsRefresh: false,
  };
  owner.input = input;
  owner.environmentFingerprint = effectiveEnvironmentFingerprint(input);
  owner.provenance = provenance;
  owner.generation += 1;
  owner.needsRefresh = true;
  owner.refreshError = undefined;
  const generation = owner.generation;
  const build = startSerializedSnapshotBuild(input);
  owner.buildCompletion = build.completion;
  void build.completion.then(() => {
    if (owner.buildCompletion === build.completion) {
      owner.buildCompletion = undefined;
    }
  });
  owners.set(key, owner);
  const publication = (async () => {
    try {
      const snapshot = await build.pending;
      if (owner.generation !== generation || owners.get(key) !== owner) {
        throw new PreparedModelRuntimePublicationSupersededError(
          `prepared model runtime publication was superseded for ${input.agentDir}`,
        );
      }
      owner.snapshot = snapshot;
      owner.pending = undefined;
      owner.needsRefresh = false;
      return snapshot;
    } catch (error) {
      const refreshError = toError(error);
      if (owner.generation === generation && owners.get(key) === owner) {
        owner.pending = undefined;
        owner.needsRefresh = true;
        owner.refreshError = refreshError;
      }
      throw refreshError;
    }
  })();
  // Every waiter observes the publication guard, not the underlying discovery result. This keeps
  // invalidated generations from escaping even when callers deduplicate against pending work.
  owner.pending = publication;
  return await publication;
}

/** Publishes one owner from an explicit startup/activation lifecycle boundary. */
export async function publishPreparedModelRuntimeSnapshot(
  rawInput: PreparedModelRuntimeInput,
  options: {
    force?: boolean;
    provenance?: PreparedModelRuntimeOwner["provenance"];
  } = {},
): Promise<PreparedModelRuntimeSnapshot> {
  const input = normalizeInput(rawInput);
  const existing = owners.get(ownerKey(input));
  if (existing?.pending) {
    if (!options.force && hasSameLifecycleInput(existing.input, input)) {
      return await existing.pending;
    }
    return await publishModelRuntimeSnapshot(input, existing, options.provenance);
  }
  if (existing?.buildCompletion) {
    throw (
      existing.refreshError ??
      new Error(`prepared model runtime build is still settling for ${input.agentDir}`)
    );
  }
  if (
    existing?.snapshot &&
    !existing.needsRefresh &&
    !options.force &&
    hasSameLifecycleInput(existing.input, input)
  ) {
    return existing.snapshot;
  }
  return await publishModelRuntimeSnapshot(input, existing, options.provenance);
}

/** Activates lifecycle publication for direct embedded runtimes without a gateway startup. */
export async function activateStandalonePreparedModelRuntime(
  rawInput: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeSnapshot | undefined> {
  for (;;) {
    if (gatewayLifecycleActive && !rawInput.readOnly) {
      return undefined;
    }
    try {
      return await publishPreparedModelRuntimeSnapshot(
        {
          ...rawInput,
          preserveWorkspaceDirOnRefresh: rawInput.workspaceDir !== undefined,
        },
        { provenance: "standalone" },
      );
    } catch (error) {
      if (!(error instanceof PreparedModelRuntimePublicationSupersededError)) {
        throw error;
      }
      const replacement = pendingModelRuntimeReplacement;
      if (replacement) {
        await replacement.promise;
      }
    }
  }
}

async function acquirePreparedModelRuntimeLease(
  rawInput: PreparedModelRuntimeInput,
  provenance: "run" | "ephemeral",
): Promise<PreparedModelRuntimeLease> {
  let input = normalizeInput({
    ...rawInput,
    preserveWorkspaceDirOnRefresh:
      rawInput.preserveWorkspaceDirOnRefresh ?? rawInput.workspaceDir !== undefined,
  });
  let key = ownerKey(input);
  let owner: PreparedModelRuntimeOwner;
  let snapshot: PreparedModelRuntimeSnapshot;
  for (;;) {
    // Replacement owns publication from synchronous staling through atomic generation commit.
    // Dynamic work arriving inside that window must retry after the new owners become visible.
    const replacement = pendingModelRuntimeReplacement;
    if (replacement) {
      await replacement.promise;
      if (pendingModelRuntimeReplacement) {
        continue;
      }
      input = rebindInputToCommittedConfiguredOwner(input);
      key = ownerKey(input);
      continue;
    }
    let existing = owners.get(key);
    let staleDynamicOwner =
      existing?.needsRefresh &&
      !existing.pending &&
      (existing.provenance === "run" || existing.provenance === "ephemeral");
    if (gatewayLifecycleActive && provenance === "run" && (!existing || staleDynamicOwner)) {
      // Dynamic workspaces still inherit the committed agent/config generation. Only their
      // explicitly pinned workspace may differ from the configured owner. A stale leased owner
      // can share this key, so rebase its input before publishing a replacement generation.
      input = rebindInputToCommittedConfiguredOwner(input);
      key = ownerKey(input);
      existing = owners.get(key);
      staleDynamicOwner =
        existing?.needsRefresh &&
        !existing.pending &&
        (existing.provenance === "run" || existing.provenance === "ephemeral");
    }
    try {
      if (staleDynamicOwner) {
        // Existing leases retain their immutable snapshot. Publish a distinct owner so their release
        // cannot delete the replacement generation admitted for new work at the same dynamic key.
        snapshot = await publishModelRuntimeSnapshot(input, undefined, provenance);
      } else if (existing) {
        snapshot = await prepareModelRuntimeSnapshot(input);
      } else {
        snapshot = await publishPreparedModelRuntimeSnapshot(input, { provenance });
      }
    } catch (error) {
      if (error instanceof PreparedModelRuntimePublicationSupersededError) {
        continue;
      }
      throw error;
    }
    const published = owners.get(key);
    if (
      pendingModelRuntimeReplacement ||
      !published ||
      published.snapshot !== snapshot ||
      published.needsRefresh ||
      published.pending
    ) {
      continue;
    }
    owner = published;
    break;
  }
  if (owner.provenance !== provenance) {
    return { snapshot, release: () => {} };
  }
  owner.leaseCount = (owner.leaseCount ?? 0) + 1;
  let released = false;
  return {
    snapshot,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      owner.leaseCount = Math.max(0, (owner.leaseCount ?? 1) - 1);
      // Dynamic generations live exactly as long as their admitted run or metadata read. The
      // identity check prevents an old lease from deleting a replacement at the same key.
      if (owner.leaseCount === 0 && owners.get(key) === owner) {
        owners.delete(key);
      }
    },
  };
}

/** Acquires the exact writable workspace generation at agent-run admission. */
export async function acquireAgentRunPreparedModelRuntime(
  rawInput: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeLease> {
  return await acquirePreparedModelRuntimeLease(rawInput, "run");
}

/** Acquires a one-read metadata generation without retaining a dynamic workspace owner. */
export async function acquireReadOnlyPreparedModelRuntime(
  rawInput: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeLease> {
  return await acquirePreparedModelRuntimeLease({ ...rawInput, readOnly: true }, "ephemeral");
}

/** Returns the snapshot published by the lifecycle owner. Request config cannot replace it. */
export async function prepareModelRuntimeSnapshot(
  rawInput: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeSnapshot> {
  const replacement = pendingModelRuntimeReplacement;
  if (replacement) {
    // Individual owners may finish before a multi-owner publication commits. The lifecycle gate
    // makes the generation visible atomically only after every owner and auth mutation is ready.
    await replacement.promise;
    return await prepareModelRuntimeSnapshot(rawInput);
  }
  const input = normalizeInput(rawInput);
  const existing = resolvePublishedOwner(input, {
    allowConfiguredWorkspaceFallback:
      rawInput.workspaceDir === undefined || rawInput.agentId === undefined,
  });
  if (
    input.readOnly &&
    existing &&
    !preparedModelRuntimeConfigsMatch(existing.input.config, input.config)
  ) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared read-only model runtime owner was not published for the requested config (${input.agentDir})`,
    );
  }
  // Generated catalogs are lifecycle artifacts, not a live-edit surface. Config/plugin reload,
  // doctor/auth repair, and auth publication replace owners; external edits require restart.
  if (existing?.pending) {
    try {
      await existing.pending;
    } catch {
      // Re-read the owner below so a superseding generation wins over this result or error.
    }
    return await prepareModelRuntimeSnapshot(rawInput);
  }
  if (existing?.needsRefresh) {
    throw existing.refreshError ?? new Error("prepared model runtime refresh is pending");
  }
  if (existing?.snapshot) {
    return existing.snapshot;
  }
  throw new PreparedModelRuntimeOwnerNotPublishedError(
    `prepared model runtime owner was not published for ${input.agentDir}`,
  );
}

/** Invalidates every published generation before config/plugin runtime replacement. */
export function markPreparedModelRuntimeSnapshotsStale(
  reason = "prepared model runtime owner is stale after config publication",
  options: { waitForReplacement?: boolean; preserveReplacementWait?: boolean } = {},
): PreparedModelRuntimeReplacementGateId | undefined {
  if (options.waitForReplacement) {
    const superseded = pendingModelRuntimeReplacement;
    pendingModelRuntimeReplacement = createPreparedModelRuntimeReplacement();
    // Superseded readers retry against the newer replacement gate.
    superseded?.resolve();
  } else if (!options.preserveReplacementWait && pendingModelRuntimeReplacement) {
    const cancelled = pendingModelRuntimeReplacement;
    pendingModelRuntimeReplacement = undefined;
    cancelled.resolve();
  }
  refreshRequestEpoch += 1;
  const staleError = new Error(reason);
  for (const [key, owner] of owners) {
    // Standalone owners have no publication controller to rebuild them. Retire them so the next
    // standalone lifecycle boundary can activate a fresh generation after publication changes.
    if (owner.provenance === "standalone") {
      owner.generation += 1;
      owners.delete(key);
      continue;
    }
    owner.generation += 1;
    owner.needsRefresh = true;
    owner.refreshError = staleError;
  }
  return pendingModelRuntimeReplacement?.gateId;
}

/** Rejects readers waiting for a replacement when its owning reload cannot continue. */
export function rejectPendingPreparedModelRuntimeReplacement(
  gateId: PreparedModelRuntimeReplacementGateId | undefined,
  error: unknown,
): void {
  const replacement = pendingModelRuntimeReplacement;
  if (!replacement || !gateId || replacement.gateId !== gateId) {
    return;
  }
  pendingModelRuntimeReplacement = undefined;
  replacement.reject(toError(error));
}

/** Rebuilds active owners after config/plugin runtime publication. */
async function refreshPreparedModelRuntimeSnapshotsNow(
  config: OpenClawConfig,
  options: { gatewayLifecycle?: boolean; defaultWorkspaceDir?: string } = {},
): Promise<void> {
  if (options.gatewayLifecycle) {
    gatewayLifecycleActive = true;
  }
  const staleError = new Error("prepared model runtime owner is stale after config publication");
  for (const owner of owners.values()) {
    // Invalidate every prior generation before starting any replacement. A failed reload must
    // never leave an old-config snapshot available beside partially published new owners.
    owner.generation += 1;
    owner.needsRefresh = true;
    owner.refreshError = staleError;
  }
  const entries: Array<{ owner?: PreparedModelRuntimeOwner; input: PreparedModelRuntimeInput }> =
    [];
  const knownKeys = new Set<string>();
  for (const rawInput of listConfiguredOwnerInputs(config, options.defaultWorkspaceDir)) {
    let input = normalizeInput(rawInput);
    const preservedOwner = [...owners.values()].find(
      (owner) =>
        owner.provenance === "configured" &&
        owner.input.agentId === input.agentId &&
        owner.input.agentDir === input.agentDir &&
        owner.input.preserveWorkspaceDirOnRefresh &&
        owner.input.workspaceDir,
    );
    if (preservedOwner?.input.workspaceDir) {
      input = {
        ...input,
        workspaceDir: preservedOwner.input.workspaceDir,
        preserveWorkspaceDirOnRefresh: true,
      };
    }
    const key = ownerKey(input);
    if (knownKeys.has(key)) {
      continue;
    }
    knownKeys.add(key);
    const owner = owners.get(key);
    entries.push({ owner, input });
  }
  for (const [key, owner] of owners) {
    if (!knownKeys.has(key) && (gatewayLifecycleActive || owner.provenance === "configured")) {
      owners.delete(key);
    }
  }
  const candidates = entries.map(({ owner: existing, input }) => {
    // Dynamic and standalone owners have different lifetime contracts. A configured publication
    // must replace them so an older lease release cannot remove the committed generation.
    const owner: PreparedModelRuntimeOwner =
      existing?.provenance === "configured"
        ? existing
        : {
            input,
            environmentFingerprint: effectiveEnvironmentFingerprint(input),
            provenance: "configured",
            generation: 0,
            needsRefresh: true,
          };
    owner.input = input;
    owner.environmentFingerprint = effectiveEnvironmentFingerprint(input);
    owner.provenance = "configured";
    owner.generation += 1;
    owner.needsRefresh = true;
    owner.refreshError = undefined;
    const generation = owner.generation;
    const build = startSerializedSnapshotBuild(input);
    owner.buildCompletion = build.completion;
    owners.set(ownerKey(input), owner);
    void build.completion.then(() => {
      if (owner.buildCompletion === build.completion) {
        owner.buildCompletion = undefined;
      }
    });
    return { build, generation, owner };
  });
  const publication = (async () => {
    try {
      const snapshots = await Promise.all(candidates.map(({ build }) => build.pending));
      for (const [index, candidate] of candidates.entries()) {
        if (candidate.owner.generation !== candidate.generation) {
          continue;
        }
        candidate.owner.snapshot = snapshots[index]!;
        candidate.owner.pending = undefined;
        candidate.owner.needsRefresh = false;
      }
      return snapshots;
    } catch (error) {
      const refreshError = toError(error);
      await Promise.allSettled(candidates.map(({ build }) => build.pending));
      for (const candidate of candidates) {
        if (candidate.owner.generation !== candidate.generation) {
          continue;
        }
        candidate.owner.pending = undefined;
        candidate.owner.needsRefresh = true;
        candidate.owner.refreshError = refreshError;
      }
      throw refreshError;
    }
  })();
  for (const [index, candidate] of candidates.entries()) {
    const pending = publication.then((snapshots) => snapshots[index]!);
    candidate.owner.pending = pending;
    void pending.catch(() => undefined);
  }
  await publication;
}

/** Serializes config/plugin publications so only the latest completed refresh retires owners. */
export function refreshPreparedModelRuntimeSnapshots(
  config: OpenClawConfig,
  options: { gatewayLifecycle?: boolean; defaultWorkspaceDir?: string } = {},
): Promise<void> {
  // Stale synchronously. Queued publication must never leave the prior generation request-visible.
  markPreparedModelRuntimeSnapshotsStale(undefined, { waitForReplacement: true });
  const requestEpoch = refreshRequestEpoch;
  const replacement = pendingModelRuntimeReplacement;
  const publication = enqueuePreparedModelRuntimePublication(async () => {
    if (requestEpoch !== refreshRequestEpoch) {
      return;
    }
    await refreshPreparedModelRuntimeSnapshotsNow(config, options);
    if (requestEpoch !== refreshRequestEpoch) {
      return;
    }
    await drainPendingAuthMutations();
  });
  return publication.then(
    () => {
      if (
        requestEpoch === refreshRequestEpoch &&
        replacement &&
        pendingModelRuntimeReplacement === replacement
      ) {
        pendingModelRuntimeReplacement = undefined;
        replacement.resolve();
      }
    },
    (error: unknown) => {
      const refreshError = toError(error);
      if (requestEpoch === refreshRequestEpoch) {
        // Candidate and queued auth builds may finish independently. A failed transaction must
        // leave no owner from its partially published generation request-visible.
        for (const owner of owners.values()) {
          owner.generation += 1;
          owner.pending = undefined;
          owner.needsRefresh = true;
          owner.refreshError = refreshError;
        }
      }
      if (
        requestEpoch === refreshRequestEpoch &&
        replacement &&
        pendingModelRuntimeReplacement === replacement
      ) {
        pendingModelRuntimeReplacement = undefined;
        replacement.reject(refreshError);
      }
      throw refreshError;
    },
  );
}

function enqueuePreparedModelRuntimePublication(task: () => Promise<void>): Promise<void> {
  const publication = refreshTail.then(task);
  refreshTail = publication.then(
    () => undefined,
    () => undefined,
  );
  return publication;
}

async function drainPendingAuthMutations(): Promise<void> {
  while (pendingAuthMutations.length > 0) {
    const events = pendingAuthMutations.splice(0);
    for (const event of events) {
      event.agentDir = normalizeOptionalDir(event.agentDir);
    }
    const entries: Array<{
      owner: PreparedModelRuntimeOwner;
      input: PreparedModelRuntimeInput;
    }> = [];
    for (const owner of owners.values()) {
      const affected = events.some(
        (event) =>
          event.affectsInheritedStores ||
          owner.input.agentDir === event.agentDir ||
          owner.input.inheritedAuthDir === event.agentDir,
      );
      if (affected) {
        entries.push({ owner, input: owner.input });
      }
    }
    await Promise.all(
      entries.map(
        async ({ owner, input }) =>
          await publishPreparedModelRuntimeSnapshot(input, {
            force: true,
            provenance: owner.provenance,
          }),
      ),
    );
  }
}

function invalidateForAuthMutation(event: AuthMutationEvent): void {
  const normalizedEvent = {
    ...event,
    agentDir: normalizeOptionalDir(event.agentDir),
  };
  const staleError = new Error("prepared model runtime owner is stale after auth mutation");
  for (const owner of owners.values()) {
    if (
      !normalizedEvent.affectsInheritedStores &&
      owner.input.agentDir !== normalizedEvent.agentDir &&
      owner.input.inheritedAuthDir !== normalizedEvent.agentDir
    ) {
      continue;
    }
    owner.generation += 1;
    owner.needsRefresh = true;
    owner.refreshError = staleError;
  }
  pendingAuthMutations.push(normalizedEvent);
  void enqueuePreparedModelRuntimePublication(drainPendingAuthMutations).catch((error: unknown) => {
    log.warn(`auth-triggered model runtime refresh failed: ${String(error)}`);
  });
}

registerRuntimeAuthProfileStoreMutationListener(invalidateForAuthMutation);

function resetPreparedModelRuntimeSnapshotsForTest(): void {
  pendingModelRuntimeReplacement?.resolve();
  pendingModelRuntimeReplacement = undefined;
  owners.clear();
  agentBuildCompletions.clear();
  gatewayLifecycleActive = false;
  refreshTail = Promise.resolve();
  refreshRequestEpoch = 0;
  pendingAuthMutations.length = 0;
  modelRuntimeBuildTimeoutMs = DEFAULT_MODEL_RUNTIME_BUILD_TIMEOUT_MS;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.preparedModelRuntimeTestApi")] =
    {
      resetPreparedModelRuntimeSnapshotsForTest,
      setModelRuntimeBuildTimeoutMsForTest: (timeoutMs: number) => {
        modelRuntimeBuildTimeoutMs = timeoutMs;
      },
    };
}
