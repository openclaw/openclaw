/** Lifecycle-owned auth/model discovery snapshots for agent runs. */
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withTimeout } from "../node-host/with-timeout.js";
import { discoverAuthStorage, discoverModels } from "./agent-model-discovery.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from "./agent-scope.js";
import { registerRuntimeAuthProfileStoreMutationListener } from "./auth-profiles/runtime-snapshots.js";
import { resolveModelPluginMetadataSnapshot } from "./model-discovery-context.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { AuthStorage, type ModelRegistry } from "./sessions/index.js";

const log = createSubsystemLogger("agents/prepared-model-runtime");
const MODEL_RUNTIME_PROVIDER_DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_MODEL_RUNTIME_BUILD_TIMEOUT_MS = 30_000;
let modelRuntimeBuildTimeoutMs = DEFAULT_MODEL_RUNTIME_BUILD_TIMEOUT_MS;

export type PreparedModelRuntimeSnapshot = Readonly<{
  agentDir: string;
  inheritedAuthDir?: string;
  workspaceDir?: string;
  config: OpenClawConfig;
  createStores: () => PreparedModelRuntimeStores;
}>;

export type PreparedModelRuntimeStores = {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
};

export type PreparedModelRuntimeInput = {
  agentDir: string;
  inheritedAuthDir?: string;
  workspaceDir?: string;
  preserveWorkspaceDirOnRefresh?: boolean;
  config: OpenClawConfig;
};

type PreparedModelRuntimeOwner = {
  input: PreparedModelRuntimeInput;
  provenance: "configured" | "standalone" | "explicit";
  generation: number;
  needsRefresh: boolean;
  refreshError?: Error;
  snapshot?: PreparedModelRuntimeSnapshot;
  pending?: Promise<PreparedModelRuntimeSnapshot>;
  buildCompletion?: Promise<void>;
};

const owners = new Map<string, PreparedModelRuntimeOwner>();
const agentBuildCompletions = new Map<string, Promise<void>>();
let gatewayLifecycleActive = false;
let refreshTail: Promise<void> = Promise.resolve();
type AuthMutationEvent = { agentDir?: string; affectsInheritedStores: boolean };
const pendingAuthMutations: AuthMutationEvent[] = [];

function normalizeOptionalDir(dirname: string | undefined): string | undefined {
  return dirname ? path.resolve(dirname) : undefined;
}

function normalizeInput(input: PreparedModelRuntimeInput): PreparedModelRuntimeInput {
  const inheritedAuthDir = normalizeOptionalDir(
    input.inheritedAuthDir ?? resolveDefaultAgentDir(input.config),
  );
  const workspaceDir = normalizeOptionalDir(input.workspaceDir);
  return {
    ...input,
    agentDir: path.resolve(input.agentDir),
    ...(inheritedAuthDir ? { inheritedAuthDir } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
  };
}

function ownerKey(input: PreparedModelRuntimeInput): string {
  return JSON.stringify({
    agentDir: input.agentDir,
    inheritedAuthDir: input.inheritedAuthDir,
    workspaceDir: input.workspaceDir,
  });
}

function hasSameLifecycleInput(
  left: PreparedModelRuntimeInput,
  right: PreparedModelRuntimeInput,
): boolean {
  return (
    left.config === right.config &&
    left.inheritedAuthDir === right.inheritedAuthDir &&
    left.workspaceDir === right.workspaceDir &&
    left.preserveWorkspaceDirOnRefresh === right.preserveWorkspaceDirOnRefresh
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
  const pluginMetadataSnapshot = resolveModelPluginMetadataSnapshot({
    config: input.config,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  await ensureOpenClawModelsJson(input.config, input.agentDir, {
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    providerDiscoveryTimeoutMs: MODEL_RUNTIME_PROVIDER_DISCOVERY_TIMEOUT_MS,
  });
  const templateAuthStorage = discoverAuthStorage(input.agentDir, {
    config: input.config,
    readOnly: true,
    ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  const templateModelRegistry = discoverModels(templateAuthStorage, input.agentDir, {
    config: input.config,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
  });
  const credentials = templateAuthStorage.getAll();
  const createStores = (): PreparedModelRuntimeStores => {
    // Runtime API keys and session extensions mutate these objects. Fork them per run while the
    // credential map and parsed catalog remain owned by the lifecycle snapshot.
    const authStorage = AuthStorage.inMemory(credentials);
    return { authStorage, modelRegistry: templateModelRegistry.fork(authStorage) };
  };
  return Object.freeze({
    agentDir: input.agentDir,
    ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    config: input.config,
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
    provenance,
    generation: 0,
    needsRefresh: false,
  };
  owner.input = input;
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
  owner.pending = build.pending;
  owners.set(key, owner);
  try {
    const snapshot = await build.pending;
    if (owner.generation === generation) {
      owner.snapshot = snapshot;
      owner.pending = undefined;
      owner.needsRefresh = false;
    }
    return snapshot;
  } catch (error) {
    const refreshError = toError(error);
    if (owner.generation === generation) {
      owner.pending = undefined;
      owner.needsRefresh = true;
      owner.refreshError = refreshError;
    }
    throw refreshError;
  }
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
  if (gatewayLifecycleActive) {
    return undefined;
  }
  return await publishPreparedModelRuntimeSnapshot(
    {
      ...rawInput,
      preserveWorkspaceDirOnRefresh: rawInput.workspaceDir !== undefined,
    },
    { provenance: "standalone" },
  );
}

/** Returns the snapshot published by the lifecycle owner. Request config cannot replace it. */
export async function prepareModelRuntimeSnapshot(
  rawInput: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeSnapshot> {
  const input = normalizeInput(rawInput);
  const existing = owners.get(ownerKey(input));
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
  throw new Error(`prepared model runtime owner was not published for ${input.agentDir}`);
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
    const owner: PreparedModelRuntimeOwner = existing ?? {
      input,
      provenance: "configured",
      generation: 0,
      needsRefresh: true,
    };
    owner.input = input;
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
  return enqueuePreparedModelRuntimePublication(async () => {
    await refreshPreparedModelRuntimeSnapshotsNow(config, options);
    await drainPendingAuthMutations();
  });
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
  owners.clear();
  agentBuildCompletions.clear();
  gatewayLifecycleActive = false;
  refreshTail = Promise.resolve();
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
