/**
 * Session-owned sandbox lifecycle cleanup.
 *
 * Reset/delete/rollover owns terminal cleanup for ephemeral session-scope
 * runtimes while idle/age prune remains the crash-recovery path.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stopBrowserBridgeServer } from "../../plugin-sdk/browser-bridge.js";
import { resolveUserPath } from "../../utils.js";
import {
  resolveWorkspaceAttestationPaths,
  shouldRemoveWorkspaceAttestation,
} from "../workspace.js";
import { getSandboxBackendManager } from "./backend.js";
import { BROWSER_BRIDGES } from "./browser-bridges.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { SANDBOX_STATE_DIR } from "./constants.js";
import { dockerSandboxBackendManager } from "./docker-backend.js";
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
import { resolveSandboxScopeKey, resolveSandboxWorkspaceDir } from "./shared.js";

export type SandboxLifecycleCleanupFailure = {
  scopeKey: string;
  containerName?: string;
  error: string;
};

export type SandboxLifecycleCleanupReason = "session-reset" | "session-delete" | "session-rollover";

export type SandboxLifecycleCleanupResult = {
  skipped: boolean;
  scopeKeys: string[];
  removedContainers: number;
  removedBrowsers: number;
  removedWorkspaces: number;
  failures: SandboxLifecycleCleanupFailure[];
};

function normalizeSessionKeys(sessionKeys: ReadonlyArray<string | undefined>): string[] {
  const normalized = new Set<string>();
  for (const key of sessionKeys) {
    const trimmed = key?.trim();
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return [...normalized];
}

function normalizeOwnerSessionIds(sessionIds: ReadonlyArray<string | undefined>): Set<string> {
  const normalized = new Set<string>();
  for (const id of sessionIds) {
    const trimmed = id?.trim();
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return normalized;
}

function formatLifecycleCleanupError(error: unknown): string {
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

async function removeWorkspaceDir(params: {
  dir: string;
  scopeKey: string;
  failures: SandboxLifecycleCleanupFailure[];
  onWarn?: (message: string) => void;
}): Promise<boolean> {
  let removed = false;
  try {
    await fs.stat(params.dir);
    await fs.rm(params.dir, { recursive: true, force: true });
    removed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      const message = formatLifecycleCleanupError(error);
      params.failures.push({ scopeKey: params.scopeKey, error: message });
      params.onWarn?.(`Sandbox lifecycle cleanup failed to remove ${params.dir}: ${message}`);
      return false;
    }
  }
  for (const [index, attestationPath] of resolveWorkspaceAttestationPaths(params.dir).entries()) {
    try {
      if (
        await shouldRemoveWorkspaceAttestation(attestationPath, { trustUnknown: index === 0 })
      ) {
        await fs.rm(attestationPath, { force: true });
        removed = true;
      }
    } catch (error) {
      const message = formatLifecycleCleanupError(error);
      params.failures.push({ scopeKey: params.scopeKey, error: message });
      params.onWarn?.(
        `Sandbox lifecycle cleanup failed to remove workspace attestation ${attestationPath}: ${message}`,
      );
    }
  }
  return removed;
}

async function removeScopedWorkspacesInternal(params: {
  workspaceRoot: string;
  scopeKeys: readonly string[];
  failedScopeKeys?: ReadonlySet<string>;
  failures: SandboxLifecycleCleanupFailure[];
  onWarn?: (message: string) => void;
}): Promise<number> {
  let removed = 0;
  const skillsRoot = path.join(SANDBOX_STATE_DIR, "skills-workspaces");
  for (const scopeKey of params.scopeKeys) {
    if (params.failedScopeKeys?.has(scopeKey)) {
      continue;
    }
    const workspaceRemoved = await removeWorkspaceDir({
      dir: resolveSandboxWorkspaceDir(params.workspaceRoot, scopeKey),
      scopeKey,
      failures: params.failures,
      onWarn: params.onWarn,
    });
    const skillsRemoved = await removeWorkspaceDir({
      dir: resolveSandboxWorkspaceDir(skillsRoot, scopeKey),
      scopeKey,
      failures: params.failures,
      onWarn: params.onWarn,
    });
    if (workspaceRemoved || skillsRemoved) {
      removed++;
    }
  }
  return removed;
}

export async function removeSandboxWorkspacesForScopeKeys(params: {
  workspaceRoot: string;
  scopeKeys: readonly string[];
  failedScopeKeys?: ReadonlySet<string>;
  onWarn?: (message: string) => void;
}): Promise<{
  removedWorkspaces: number;
  failures: SandboxLifecycleCleanupFailure[];
}> {
  const failures: SandboxLifecycleCleanupFailure[] = [];
  const removedWorkspaces = await removeScopedWorkspacesInternal({
    workspaceRoot: resolveUserPath(params.workspaceRoot),
    scopeKeys: params.scopeKeys,
    failedScopeKeys: params.failedScopeKeys,
    failures,
    onWarn: params.onWarn,
  });
  return { removedWorkspaces, failures };
}

async function removeSandboxRuntimeForLifecycleEnd(params: {
  config: OpenClawConfig;
  agentId?: string;
  entry: SandboxRegistryEntry;
}): Promise<void> {
  const backendId = params.entry.backendId ?? "docker";
  const manager = getSandboxBackendManager(backendId);
  if (!manager) {
    throw new Error(`Sandbox backend "${backendId}" is not registered for lifecycle cleanup.`);
  }
  for (const location of getSandboxRegistryCleanupLocations(params.entry)) {
    await manager.removeRuntime({
      entry: applySandboxRegistryCleanupLocation(params.entry, location),
      config: params.config,
      agentId: params.agentId,
    });
  }
}

function toBrowserDockerRuntimeEntry(entry: SandboxBrowserRegistryEntry): SandboxRegistryEntry {
  return {
    ...entry,
    backendId: "docker",
    runtimeLabel: entry.containerName,
    configLabelKind: "BrowserImage",
  };
}

async function stopBrowserBridgeForContainer(containerName: string): Promise<void> {
  for (const [sessionKey, bridge] of BROWSER_BRIDGES.entries()) {
    if (bridge.containerName === containerName) {
      await stopBrowserBridgeServer(bridge.bridge.server).catch(() => undefined);
      BROWSER_BRIDGES.delete(sessionKey);
    }
  }
}

async function removeSandboxBrowserRuntimeForLifecycleEnd(params: {
  config: OpenClawConfig;
  agentId?: string;
  entry: SandboxBrowserRegistryEntry;
}): Promise<void> {
  await dockerSandboxBackendManager.removeRuntime({
    entry: toBrowserDockerRuntimeEntry(params.entry),
    config: params.config,
    agentId: params.agentId,
  });
  await stopBrowserBridgeForContainer(params.entry.containerName);
}

async function removeFinalizedLifecycleRegistryEntries(params: {
  containers: readonly SandboxRegistryEntry[];
  browsers: readonly SandboxBrowserRegistryEntry[];
  workspaces: readonly SandboxWorkspaceRegistryEntry[];
  finalizedScopeKeys: ReadonlySet<string>;
  failures: SandboxLifecycleCleanupFailure[];
  onWarn?: (message: string) => void;
}): Promise<void> {
  for (const entry of params.containers) {
    if (!params.finalizedScopeKeys.has(entry.sessionKey)) {
      continue;
    }
    try {
      await removeRegistryEntryIfUnchanged(entry);
    } catch (error) {
      const message = formatLifecycleCleanupError(error);
      params.failures.push({
        scopeKey: entry.sessionKey,
        containerName: entry.containerName,
        error: message,
      });
      params.onWarn?.(
        `Sandbox lifecycle cleanup failed to finalize ${entry.containerName}: ${message}`,
      );
    }
  }
  for (const entry of params.browsers) {
    if (!params.finalizedScopeKeys.has(entry.sessionKey)) {
      continue;
    }
    try {
      await removeBrowserRegistryEntryIfUnchanged(entry);
    } catch (error) {
      const message = formatLifecycleCleanupError(error);
      params.failures.push({
        scopeKey: entry.sessionKey,
        containerName: entry.containerName,
        error: message,
      });
      params.onWarn?.(
        `Sandbox lifecycle cleanup failed to finalize ${entry.containerName}: ${message}`,
      );
    }
  }
  for (const entry of params.workspaces) {
    if (!params.finalizedScopeKeys.has(entry.sessionKey)) {
      continue;
    }
    try {
      await removeWorkspaceRegistryEntryIfUnchanged(entry);
    } catch (error) {
      const message = formatLifecycleCleanupError(error);
      params.failures.push({
        scopeKey: entry.sessionKey,
        containerName: entry.containerName,
        error: message,
      });
      params.onWarn?.(
        `Sandbox lifecycle cleanup failed to finalize ${entry.containerName}: ${message}`,
      );
    }
  }
}

function addWorkspaceCleanupScope(
  scopesByWorkspaceRoot: Map<string, Set<string>>,
  workspaceRoot: string,
  scopeKey: string,
): void {
  const resolvedRoot = workspaceRoot.trim() || workspaceRoot;
  const scopes = scopesByWorkspaceRoot.get(resolvedRoot) ?? new Set<string>();
  scopes.add(scopeKey);
  scopesByWorkspaceRoot.set(resolvedRoot, scopes);
}

function collectWorkspaceCleanupScopes(params: {
  fallbackWorkspaceRoot: string;
  scopeKeys: readonly string[];
  containers: readonly SandboxRegistryEntry[];
  browsers: readonly SandboxBrowserRegistryEntry[];
  workspaces: readonly SandboxWorkspaceRegistryEntry[];
  protectedScopeKeys?: ReadonlySet<string>;
}): Map<string, Set<string>> {
  const scopesByWorkspaceRoot = new Map<string, Set<string>>();
  const scopeKeysWithRegistryRoot = new Set<string>();
  for (const entry of [...params.containers, ...params.browsers]) {
    if (params.protectedScopeKeys?.has(entry.sessionKey)) {
      continue;
    }
    for (const location of getSandboxRegistryCleanupLocations(entry)) {
      const workspaceRoot = location.workspaceRoot?.trim() || params.fallbackWorkspaceRoot;
      addWorkspaceCleanupScope(scopesByWorkspaceRoot, workspaceRoot, entry.sessionKey);
      if (location.workspaceRoot?.trim()) {
        scopeKeysWithRegistryRoot.add(entry.sessionKey);
      }
    }
  }
  for (const entry of params.workspaces) {
    if (params.protectedScopeKeys?.has(entry.sessionKey)) {
      continue;
    }
    for (const workspaceRoot of getSandboxWorkspaceRegistryRoots(entry)) {
      addWorkspaceCleanupScope(scopesByWorkspaceRoot, workspaceRoot, entry.sessionKey);
    }
    scopeKeysWithRegistryRoot.add(entry.sessionKey);
  }
  for (const scopeKey of params.scopeKeys) {
    if (params.protectedScopeKeys?.has(scopeKey)) {
      continue;
    }
    if (!scopeKeysWithRegistryRoot.has(scopeKey)) {
      addWorkspaceCleanupScope(scopesByWorkspaceRoot, params.fallbackWorkspaceRoot, scopeKey);
    }
  }
  return scopesByWorkspaceRoot;
}

function isRecordedManagedSessionLifecycleEntry(
  entry: SandboxRegistryEntry | SandboxBrowserRegistryEntry | SandboxWorkspaceRegistryEntry,
): boolean {
  return entry.scope === "session" && entry.lifecycleCleanupOnSessionEnd === true;
}

function hasExplicitNonSessionScope(
  entry: SandboxRegistryEntry | SandboxBrowserRegistryEntry | SandboxWorkspaceRegistryEntry,
): boolean {
  return entry.scope === "agent" || entry.scope === "shared";
}

function canLifecycleCleanupEntry(
  entry: SandboxRegistryEntry | SandboxBrowserRegistryEntry | SandboxWorkspaceRegistryEntry,
  currentConfigOwnsSessionLifecycle: boolean,
): boolean {
  if (hasExplicitNonSessionScope(entry)) {
    return false;
  }
  if (isRecordedManagedSessionLifecycleEntry(entry)) {
    return true;
  }
  return (
    (entry.scope === "session" || entry.scope === undefined) && currentConfigOwnsSessionLifecycle
  );
}

function matchesLifecycleOwnerSession(
  entry: SandboxRegistryEntry | SandboxBrowserRegistryEntry | SandboxWorkspaceRegistryEntry,
  ownerSessionIds: ReadonlySet<string>,
): boolean {
  const ownerSessionId = entry.lifecycleOwnerSessionId?.trim();
  return Boolean(ownerSessionId && ownerSessionIds.has(ownerSessionId));
}

function hasDifferentLifecycleOwnerSession(
  entry: SandboxRegistryEntry | SandboxBrowserRegistryEntry | SandboxWorkspaceRegistryEntry,
  ownerSessionIds: ReadonlySet<string>,
): boolean {
  const ownerSessionId = entry.lifecycleOwnerSessionId?.trim();
  return Boolean(
    ownerSessionId && ownerSessionIds.size > 0 && !ownerSessionIds.has(ownerSessionId),
  );
}

/** Removes opt-in ephemeral sandbox resources for a terminal session owner. */
export async function cleanupSessionScopedSandboxForLifecycleEnd(params: {
  config: OpenClawConfig;
  agentId?: string;
  sessionKeys: ReadonlyArray<string | undefined>;
  ownerSessionIds?: ReadonlyArray<string | undefined>;
  reason: SandboxLifecycleCleanupReason;
  onWarn?: (message: string) => void;
}): Promise<SandboxLifecycleCleanupResult> {
  const cfg = resolveSandboxConfigForAgent(params.config, params.agentId);
  const sessionKeys = normalizeSessionKeys(params.sessionKeys);
  const ownerSessionIds = normalizeOwnerSessionIds(params.ownerSessionIds ?? []);
  if (sessionKeys.length === 0 && ownerSessionIds.size === 0) {
    return {
      skipped: true,
      scopeKeys: [],
      removedContainers: 0,
      removedBrowsers: 0,
      removedWorkspaces: 0,
      failures: [],
    };
  }

  const initialScopeKeys = sessionKeys.map((key) => resolveSandboxScopeKey("session", key));
  const scopeKeySet = new Set(initialScopeKeys);
  const allScopeKeys = new Set(initialScopeKeys);
  const currentConfigOwnsSessionLifecycle = cfg.scope === "session" && cfg.prune.onSessionEnd;
  const registry = await readRegistry();
  const browserRegistry = await readBrowserRegistry();
  const workspaceRegistry = await readWorkspaceRegistry();
  for (const entry of [
    ...registry.entries,
    ...browserRegistry.entries,
    ...workspaceRegistry.entries,
  ]) {
    if (
      isRecordedManagedSessionLifecycleEntry(entry) &&
      matchesLifecycleOwnerSession(entry, ownerSessionIds)
    ) {
      scopeKeySet.add(entry.sessionKey);
      allScopeKeys.add(entry.sessionKey);
    }
  }

  let scopeKeysToLock = [...allScopeKeys];
  while (true) {
    const attempt = await withSandboxScopeLocks(scopeKeysToLock, async () => {
      const lockedScopeKeys = new Set(scopeKeysToLock);
      const lockedRegistry = await readRegistry();
      const lockedBrowserRegistry = await readBrowserRegistry();
      const lockedWorkspaceRegistry = await readWorkspaceRegistry();
      const protectedScopeKeys = new Set<string>();
      const explicitNonSessionScopeKeys = new Set<string>();
      for (const entry of [
        ...lockedRegistry.entries,
        ...lockedBrowserRegistry.entries,
        ...lockedWorkspaceRegistry.entries,
      ]) {
        if (
          isRecordedManagedSessionLifecycleEntry(entry) &&
          matchesLifecycleOwnerSession(entry, ownerSessionIds)
        ) {
          scopeKeySet.add(entry.sessionKey);
          allScopeKeys.add(entry.sessionKey);
        }
      }
      const missingLockedScopeKeys = [...allScopeKeys].filter(
        (scopeKey) => !lockedScopeKeys.has(scopeKey),
      );
      if (missingLockedScopeKeys.length > 0) {
        // Owner discovery is registry-driven, so a locked reread can reveal more
        // session scopes. Release and reacquire the full set before deleting any
        // deterministic runtime or workspace path.
        return { retryScopeKeys: [...allScopeKeys] } as const;
      }
      const canCleanupEntry = (
        entry: SandboxRegistryEntry | SandboxBrowserRegistryEntry | SandboxWorkspaceRegistryEntry,
      ) => {
        if (!scopeKeySet.has(entry.sessionKey)) {
          return false;
        }
        if (hasExplicitNonSessionScope(entry)) {
          explicitNonSessionScopeKeys.add(entry.sessionKey);
          return false;
        }
        if (hasDifferentLifecycleOwnerSession(entry, ownerSessionIds)) {
          protectedScopeKeys.add(entry.sessionKey);
          return false;
        }
        return canLifecycleCleanupEntry(entry, currentConfigOwnsSessionLifecycle);
      };
      const containers = lockedRegistry.entries.filter((entry) => canCleanupEntry(entry));
      const browsers = lockedBrowserRegistry.entries.filter((entry) => canCleanupEntry(entry));
      const workspaces = lockedWorkspaceRegistry.entries.filter((entry) => canCleanupEntry(entry));
      const fallbackScopeKeys = currentConfigOwnsSessionLifecycle
        ? [...allScopeKeys].filter(
            (scopeKey) =>
              !protectedScopeKeys.has(scopeKey) && !explicitNonSessionScopeKeys.has(scopeKey),
          )
        : [];
      const failures: SandboxLifecycleCleanupFailure[] = [];
      const failedScopeKeys = new Set<string>();
      if (
        containers.length === 0 &&
        browsers.length === 0 &&
        workspaces.length === 0 &&
        fallbackScopeKeys.length === 0
      ) {
        return {
          skipped: failures.length === 0,
          scopeKeys: failures.length > 0 ? [...allScopeKeys] : [],
          removedContainers: 0,
          removedBrowsers: 0,
          removedWorkspaces: 0,
          failures,
        };
      }

      const removedContainerEntries: SandboxRegistryEntry[] = [];
      const removedBrowserEntries: SandboxBrowserRegistryEntry[] = [];
      let removedContainers = 0;
      let removedBrowsers = 0;

      for (const entry of containers) {
        try {
          await removeSandboxRuntimeForLifecycleEnd({
            config: params.config,
            agentId: params.agentId,
            entry,
          });
          removedContainers++;
          removedContainerEntries.push(entry);
        } catch (error) {
          const message = formatLifecycleCleanupError(error);
          failedScopeKeys.add(entry.sessionKey);
          failures.push({
            scopeKey: entry.sessionKey,
            containerName: entry.containerName,
            error: message,
          });
          params.onWarn?.(
            `Sandbox lifecycle cleanup failed to remove ${entry.containerName}: ${message}`,
          );
        }
      }

      for (const entry of browsers) {
        try {
          await removeSandboxBrowserRuntimeForLifecycleEnd({
            config: params.config,
            agentId: params.agentId,
            entry,
          });
          removedBrowsers++;
          removedBrowserEntries.push(entry);
        } catch (error) {
          const message = formatLifecycleCleanupError(error);
          failedScopeKeys.add(entry.sessionKey);
          failures.push({
            scopeKey: entry.sessionKey,
            containerName: entry.containerName,
            error: message,
          });
          params.onWarn?.(
            `Sandbox lifecycle cleanup failed to remove ${entry.containerName}: ${message}`,
          );
        }
      }

      const cleanupScopes = collectWorkspaceCleanupScopes({
        fallbackWorkspaceRoot: cfg.workspaceRoot,
        scopeKeys: fallbackScopeKeys,
        containers,
        browsers,
        workspaces,
        protectedScopeKeys,
      });
      let removedWorkspaces = 0;
      for (const [workspaceRoot, cleanupScopeKeys] of cleanupScopes) {
        const workspaceRemoval = await removeSandboxWorkspacesForScopeKeys({
          workspaceRoot,
          scopeKeys: [...cleanupScopeKeys],
          failedScopeKeys,
          onWarn: params.onWarn,
        });
        removedWorkspaces += workspaceRemoval.removedWorkspaces;
        failures.push(...workspaceRemoval.failures);
        for (const failure of workspaceRemoval.failures) {
          failedScopeKeys.add(failure.scopeKey);
        }
      }
      // Registry rows are durable retry tokens for partial lifecycle cleanup.
      // Finalize them only after every runtime and workspace for that owner is gone.
      const finalizedScopeKeys = new Set(
        [...allScopeKeys].filter((scopeKey) => !failedScopeKeys.has(scopeKey)),
      );
      await removeFinalizedLifecycleRegistryEntries({
        containers: removedContainerEntries,
        browsers: removedBrowserEntries,
        workspaces,
        finalizedScopeKeys,
        failures,
        onWarn: params.onWarn,
      });

      return {
        skipped: false,
        scopeKeys: [...allScopeKeys],
        removedContainers,
        removedBrowsers,
        removedWorkspaces,
        failures,
      };
    });
    if ("retryScopeKeys" in attempt && attempt.retryScopeKeys) {
      scopeKeysToLock = [...attempt.retryScopeKeys];
      continue;
    }
    return attempt;
  }
}
