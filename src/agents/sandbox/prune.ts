/**
 * Sandbox registry pruning.
 *
 * Removes stale runtime containers and browser bridges on a best-effort schedule.
 */
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stopBrowserBridgeServer } from "../../plugin-sdk/browser-bridge.js";
import { defaultRuntime } from "../../runtime.js";
import { asDateTimestampMs } from "../../shared/number-coercion.js";
import { getSandboxBackendManager } from "./backend.js";
import { BROWSER_BRIDGES } from "./browser-bridges.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { dockerSandboxBackendManager } from "./docker-backend.js";
import { removeSandboxWorkspacesForScopeKeys } from "./lifecycle.js";
import {
  applySandboxRegistryCleanupLocation,
  getSandboxRegistryCleanupLocations,
  getSandboxWorkspaceRegistryRoots,
  readBrowserRegistry,
  readRegistry,
  readWorkspaceRegistry,
  removeBrowserRegistryEntryIfUnchanged,
  removeRegistryEntryIfUnchanged,
  removeWorkspaceRegistryEntryIfUnchanged,
  type SandboxBrowserRegistryEntry,
  type SandboxRegistryEntry,
  type SandboxWorkspaceRegistryEntry,
} from "./registry.js";
import { withSandboxScopeLocks } from "./scope-lock.js";
import { resolveSandboxAgentId } from "./shared.js";
import type { SandboxConfig } from "./types.js";

let lastPruneAtMs = 0;

type PruneableRegistryEntry = Pick<
  SandboxRegistryEntry,
  "containerName" | "backendId" | "sessionKey" | "createdAtMs" | "lastUsedAtMs"
>;

type RemovedSandboxRegistryEntries = {
  containers: SandboxRegistryEntry[];
  browsers: SandboxBrowserRegistryEntry[];
};

function shouldPruneSandboxEntry(cfg: SandboxConfig, now: number, entry: PruneableRegistryEntry) {
  const idleHours = cfg.prune.idleHours;
  const maxAgeDays = cfg.prune.maxAgeDays;
  if (idleHours === 0 && maxAgeDays === 0) {
    return false;
  }
  const nowMs = asDateTimestampMs(now) ?? 0;
  const lastUsedAtMs = asDateTimestampMs(entry.lastUsedAtMs) ?? 0;
  const createdAtMs = asDateTimestampMs(entry.createdAtMs) ?? 0;
  const idleMs = nowMs - lastUsedAtMs;
  const ageMs = nowMs - createdAtMs;
  return (
    (idleHours > 0 && idleMs > idleHours * 60 * 60 * 1000) ||
    (maxAgeDays > 0 && ageMs > maxAgeDays * 24 * 60 * 60 * 1000)
  );
}

function formatPruneError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

function isSessionScopedOwnedEntry(
  entry: SandboxRegistryEntry | SandboxBrowserRegistryEntry | SandboxWorkspaceRegistryEntry,
): entry is (SandboxRegistryEntry | SandboxBrowserRegistryEntry | SandboxWorkspaceRegistryEntry) & {
  scope: "session";
  workspaceRoot: string;
} {
  return (
    entry.scope === "session" &&
    entry.lifecycleCleanupOnSessionEnd === true &&
    typeof entry.workspaceRoot === "string" &&
    entry.workspaceRoot.trim() !== ""
  );
}

function resolvePruneConfigForEntry(
  config: OpenClawConfig,
  entry: PruneableRegistryEntry,
): SandboxConfig {
  return resolveSandboxConfigForAgent(config, resolveSandboxAgentId(entry.sessionKey));
}

/** Removes expired registry entries and their backing runtime resources. */
async function pruneSandboxRegistryEntries<TEntry extends SandboxRegistryEntry>(params: {
  config: OpenClawConfig;
  now: number;
  read: () => Promise<{ entries: TEntry[] }>;
  remove: (entry: TEntry) => Promise<boolean>;
  removeRuntime: (entry: TEntry) => Promise<void>;
  onRemoved?: (entry: TEntry) => Promise<void>;
}): Promise<TEntry[]> {
  const removed: TEntry[] = [];
  const registry = await params.read();
  for (const entry of registry.entries) {
    if (
      !shouldPruneSandboxEntry(resolvePruneConfigForEntry(params.config, entry), params.now, entry)
    ) {
      continue;
    }
    await withSandboxScopeLocks([entry.sessionKey], async () => {
      const lockedRegistry = await params.read();
      const lockedEntry = lockedRegistry.entries.find(
        (candidate) => candidate.containerName === entry.containerName,
      );
      if (
        !lockedEntry ||
        !shouldPruneSandboxEntry(
          resolvePruneConfigForEntry(params.config, lockedEntry),
          params.now,
          lockedEntry,
        )
      ) {
        return;
      }
      try {
        await params.removeRuntime(lockedEntry);
        await params.onRemoved?.(lockedEntry);
        const finalized = await params.remove(lockedEntry);
        if (finalized && isSessionScopedOwnedEntry(lockedEntry)) {
          removed.push(lockedEntry);
        }
      } catch (error) {
        const message = formatPruneError(error);
        defaultRuntime.error?.(
          `Sandbox prune failed to remove ${lockedEntry.containerName}: ${message ?? "unknown error"}`,
        );
      }
    });
  }
  return removed;
}

async function removePrunedRegistryEntry(
  kind: "container" | "browser",
  entry: SandboxRegistryEntry | SandboxBrowserRegistryEntry,
): Promise<boolean> {
  try {
    return await (kind === "container"
      ? removeRegistryEntryIfUnchanged(entry as SandboxRegistryEntry)
      : removeBrowserRegistryEntryIfUnchanged(entry as SandboxBrowserRegistryEntry));
  } catch (error) {
    defaultRuntime.error?.(
      `Sandbox prune failed to finalize ${entry.containerName}: ${formatPruneError(error)}`,
    );
    return false;
  }
}

function registryContainerMatchesRemovedSnapshot(
  current: SandboxRegistryEntry,
  removed: SandboxRegistryEntry | undefined,
): boolean {
  return Boolean(
    removed &&
    current.containerName === removed.containerName &&
    current.sessionKey === removed.sessionKey &&
    current.lastUsedAtMs === removed.lastUsedAtMs &&
    current.configHash === removed.configHash &&
    current.workspaceRoot === removed.workspaceRoot &&
    current.lifecycleOwnerSessionId === removed.lifecycleOwnerSessionId &&
    current.sshTarget === removed.sshTarget &&
    current.sshWorkspaceRoot === removed.sshWorkspaceRoot &&
    JSON.stringify(current.cleanupMetadata ?? null) ===
      JSON.stringify(removed.cleanupMetadata ?? null) &&
    JSON.stringify(current.supersededCleanupLocations ?? []) ===
      JSON.stringify(removed.supersededCleanupLocations ?? []),
  );
}

function registryBrowserMatchesRemovedSnapshot(
  current: SandboxBrowserRegistryEntry,
  removed: SandboxBrowserRegistryEntry | undefined,
): boolean {
  return Boolean(
    removed &&
    current.containerName === removed.containerName &&
    current.sessionKey === removed.sessionKey &&
    current.lastUsedAtMs === removed.lastUsedAtMs &&
    current.configHash === removed.configHash &&
    current.workspaceRoot === removed.workspaceRoot &&
    current.lifecycleOwnerSessionId === removed.lifecycleOwnerSessionId &&
    JSON.stringify(current.supersededCleanupLocations ?? []) ===
      JSON.stringify(removed.supersededCleanupLocations ?? []),
  );
}

async function removeSandboxContainerRuntimeForPrune(params: {
  entry: SandboxRegistryEntry;
  config: ReturnType<typeof getRuntimeConfig>;
}): Promise<void> {
  const backendId = params.entry.backendId ?? "docker";
  const manager = getSandboxBackendManager(backendId);
  if (!manager) {
    throw new Error(`Sandbox backend "${backendId}" is not registered for pruning.`);
  }
  for (const location of getSandboxRegistryCleanupLocations(params.entry)) {
    await manager.removeRuntime({
      entry: applySandboxRegistryCleanupLocation(params.entry, location),
      config: params.config,
      agentId: resolveSandboxAgentId(params.entry.sessionKey),
    });
  }
}

async function finalizePrunedRegistryEntries(params: {
  config: OpenClawConfig;
  now: number;
  removed: RemovedSandboxRegistryEntries;
}) {
  const removedContainersByName = new Map(
    params.removed.containers.map((entry) => [entry.containerName, entry]),
  );
  const removedBrowsersByName = new Map(
    params.removed.browsers.map((entry) => [entry.containerName, entry]),
  );
  const sessionGroups = new Map<
    string,
    {
      sessionKey: string;
      workspaceRoots: Set<string>;
      containers: SandboxRegistryEntry[];
      browsers: SandboxBrowserRegistryEntry[];
    }
  >();

  const getSessionGroup = (sessionKey: string) => {
    const group = sessionGroups.get(sessionKey) ?? {
      sessionKey,
      workspaceRoots: new Set<string>(),
      containers: [],
      browsers: [],
    };
    sessionGroups.set(sessionKey, group);
    return group;
  };

  for (const entry of params.removed.containers) {
    if (!isSessionScopedOwnedEntry(entry)) {
      await removePrunedRegistryEntry("container", entry);
      continue;
    }
    const group = getSessionGroup(entry.sessionKey);
    for (const location of getSandboxRegistryCleanupLocations(entry)) {
      if (location.workspaceRoot?.trim()) {
        group.workspaceRoots.add(location.workspaceRoot);
      }
    }
    group.containers.push(entry);
  }

  for (const entry of params.removed.browsers) {
    if (!isSessionScopedOwnedEntry(entry)) {
      await removePrunedRegistryEntry("browser", entry);
      continue;
    }
    const group = getSessionGroup(entry.sessionKey);
    for (const location of getSandboxRegistryCleanupLocations(entry)) {
      if (location.workspaceRoot?.trim()) {
        group.workspaceRoots.add(location.workspaceRoot);
      }
    }
    group.browsers.push(entry);
  }

  if (sessionGroups.size === 0) {
    return;
  }

  for (const group of sessionGroups.values()) {
    await withSandboxScopeLocks([group.sessionKey], async () => {
      const [lockedContainerRegistry, lockedBrowserRegistry, lockedWorkspaceRegistry] =
        await Promise.all([
          readRegistry(),
          readBrowserRegistry(),
          readWorkspaceRegistry(),
        ]);
      const workspaceEntries = lockedWorkspaceRegistry.entries.filter(
        (entry) => entry.sessionKey === group.sessionKey && isSessionScopedOwnedEntry(entry),
      );
      const workspaceRoots = new Set(group.workspaceRoots);
      for (const entry of workspaceEntries) {
        for (const root of getSandboxWorkspaceRegistryRoots(entry)) {
          workspaceRoots.add(root);
        }
      }
      // A session workspace can be shared by ordinary and browser runtimes. A
      // fresh sibling keeps the workspace but no longer needs this removed row;
      // a still-pruneable sibling keeps rows so later workspace cleanup has all roots.
      const remainingContainers = lockedContainerRegistry.entries.filter(
        (entry) =>
          entry.sessionKey === group.sessionKey &&
          !registryContainerMatchesRemovedSnapshot(
            entry,
            removedContainersByName.get(entry.containerName),
          ),
      );
      const remainingBrowsers = lockedBrowserRegistry.entries.filter(
        (entry) =>
          entry.sessionKey === group.sessionKey &&
          !registryBrowserMatchesRemovedSnapshot(
            entry,
            removedBrowsersByName.get(entry.containerName),
          ),
      );
      const hasPruneableRemainingRuntime = [...remainingContainers, ...remainingBrowsers].some(
        (entry) =>
          shouldPruneSandboxEntry(
            resolvePruneConfigForEntry(params.config, entry),
            params.now,
            entry,
          ),
      );
      if (hasPruneableRemainingRuntime) {
        return;
      }
      if (remainingContainers.length > 0 || remainingBrowsers.length > 0) {
        return;
      }

      for (const workspaceRoot of workspaceRoots) {
        const workspaceRemoval = await removeSandboxWorkspacesForScopeKeys({
          workspaceRoot,
          scopeKeys: [group.sessionKey],
        });
        if (workspaceRemoval.failures.length > 0) {
          defaultRuntime.error?.(
            `Sandbox prune failed to remove workspace for ${group.sessionKey}: ${workspaceRemoval.failures
              .map((failure) => failure.error)
              .join("; ")}`,
          );
          return;
        }
      }

      for (const entry of workspaceEntries) {
        try {
          await removeWorkspaceRegistryEntryIfUnchanged(entry);
        } catch (error) {
          defaultRuntime.error?.(
            `Sandbox prune failed to finalize workspace ${entry.containerName}: ${formatPruneError(error)}`,
          );
        }
      }
    });
  }
}

async function pruneWorkspaceOnlyRegistryEntries(
  config: OpenClawConfig,
  now: number,
): Promise<void> {
  const workspaceRegistry = await readWorkspaceRegistry();
  for (const entry of workspaceRegistry.entries) {
    if (
      !isSessionScopedOwnedEntry(entry) ||
      !shouldPruneSandboxEntry(resolvePruneConfigForEntry(config, entry), now, entry)
    ) {
      continue;
    }
    await withSandboxScopeLocks([entry.sessionKey], async () => {
      const [lockedWorkspaces, lockedContainers, lockedBrowsers] = await Promise.all([
        readWorkspaceRegistry(),
        readRegistry(),
        readBrowserRegistry(),
      ]);
      const lockedEntry = lockedWorkspaces.entries.find(
        (candidate) => candidate.containerName === entry.containerName,
      );
      if (
        !lockedEntry ||
        !isSessionScopedOwnedEntry(lockedEntry) ||
        !shouldPruneSandboxEntry(resolvePruneConfigForEntry(config, lockedEntry), now, lockedEntry)
      ) {
        return;
      }
      const hasRuntimeSibling = [...lockedContainers.entries, ...lockedBrowsers.entries].some(
        (candidate) => candidate.sessionKey === lockedEntry.sessionKey,
      );
      if (hasRuntimeSibling) {
        return;
      }
      for (const workspaceRoot of getSandboxWorkspaceRegistryRoots(lockedEntry)) {
        const workspaceRemoval = await removeSandboxWorkspacesForScopeKeys({
          workspaceRoot,
          scopeKeys: [lockedEntry.sessionKey],
        });
        if (workspaceRemoval.failures.length > 0) {
          defaultRuntime.error?.(
            `Sandbox prune failed to remove workspace for ${lockedEntry.sessionKey}: ${workspaceRemoval.failures
              .map((failure) => failure.error)
              .join("; ")}`,
          );
          return;
        }
      }
      await removeWorkspaceRegistryEntryIfUnchanged(lockedEntry);
    });
  }
}

/** Prunes ordinary sandbox runtime containers from the configured backend manager. */
async function pruneSandboxContainers(
  config: OpenClawConfig,
  now: number,
): Promise<SandboxRegistryEntry[]> {
  return await pruneSandboxRegistryEntries<SandboxRegistryEntry>({
    config,
    now,
    read: readRegistry,
    remove: async (entry) => await removePrunedRegistryEntry("container", entry),
    removeRuntime: async (entry) => await removeSandboxContainerRuntimeForPrune({ entry, config }),
  });
}

/** Prunes browser bridge containers and closes matching in-process bridge servers. */
async function pruneSandboxBrowsers(
  config: OpenClawConfig,
  now: number,
): Promise<SandboxBrowserRegistryEntry[]> {
  return await pruneSandboxRegistryEntries<
    SandboxBrowserRegistryEntry & {
      backendId?: string;
      runtimeLabel?: string;
      configLabelKind?: string;
    }
  >({
    config,
    now,
    read: readBrowserRegistry,
    remove: async (entry) => await removePrunedRegistryEntry("browser", entry),
    removeRuntime: async (entry) => {
      await dockerSandboxBackendManager.removeRuntime({
        entry: {
          ...entry,
          backendId: "docker",
          runtimeLabel: entry.containerName,
          configLabelKind: "Image",
        },
        config,
        agentId: resolveSandboxAgentId(entry.sessionKey),
      });
    },
    onRemoved: async (entry) => {
      const bridge = BROWSER_BRIDGES.get(entry.sessionKey);
      if (bridge?.containerName === entry.containerName) {
        await stopBrowserBridgeServer(bridge.bridge.server).catch(() => undefined);
        BROWSER_BRIDGES.delete(entry.sessionKey);
      }
    },
  });
}

/** Runs sandbox pruning at most once per throttle window. */
export async function maybePruneSandboxes(_cfg: SandboxConfig) {
  const now = Date.now();
  if (now - lastPruneAtMs < 5 * 60 * 1000) {
    return;
  }
  lastPruneAtMs = now;
  try {
    const config = getRuntimeConfig();
    const containers = await pruneSandboxContainers(config, now);
    const browsers = await pruneSandboxBrowsers(config, now);
    await finalizePrunedRegistryEntries({
      config,
      now,
      removed: { containers, browsers },
    });
    await pruneWorkspaceOnlyRegistryEntries(config, now);
  } catch (error) {
    const message = formatPruneError(error);
    defaultRuntime.error?.(`Sandbox prune failed: ${message ?? "unknown error"}`);
  }
}
