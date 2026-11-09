/**
 * Sandbox registry pruning.
 *
 * Removes stale runtime containers and browser bridges on a best-effort schedule.
 */
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { observeDiagnosticsTimelinePhases } from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { listExecSessionsForCancellation } from "../bash-process-registry.js";
import type { WorkspaceStateGuard } from "../workspace-state-store.worker-contract.js";
import { getSandboxBackendManager, usesSandboxRuntimeReservations } from "./backend.js";
import { stopCachedBrowserBridgesForContainer } from "./browser-bridges.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { withSandboxContainerLifecycle } from "./container-lifecycle.js";
import { isSandboxContainerInUse } from "./container-usage.js";
import { dockerSandboxBackendManager, podmanSandboxBackendManager } from "./docker-backend.js";
import {
  maybeRunSandboxRegistryHousekeeping,
  startSandboxRegistryHousekeeping,
  withSandboxRuntimePrune,
} from "./registry-lifecycle.js";
import {
  assertSandboxRegistryRetirementCurrent,
  readBrowserRegistry,
  readRegistry,
  readRegistryEntry,
  removeSandboxRegistryGeneration,
  removeSandboxRegistryRuntime,
  updateRegistry,
  withSandboxRegistryEntryLock,
  type SandboxRegistryEntry,
} from "./registry.js";
import { shouldPruneSandboxRegistryEntry, type SandboxRegistryPrune } from "./registry.kernel.js";
import { resolveSandboxAgentId } from "./shared.js";
import { captureSandboxStateOwner } from "./state-owner.js";

const IDLE_STOP_MS = 15 * 60 * 1000;
const MAX_IDLE_STOPS_PER_PASS = 32;

function shouldStopIdleContainer(entry: SandboxRegistryEntry, now: number): boolean {
  return (
    (entry.backendId === undefined ||
      entry.backendId === "docker" ||
      entry.backendId === "podman") &&
    (entry.runtimeState === undefined || entry.runtimeState === "ready") &&
    now - entry.lastUsedAtMs > IDLE_STOP_MS
  );
}

function hasActiveContainerUsage(entry: SandboxRegistryEntry): boolean {
  return (
    isSandboxContainerInUse(entry.sessionKey) ||
    listExecSessionsForCancellation().some(
      (process) =>
        process.sandboxContainerName === entry.containerName &&
        (!process.exited ||
          process.finalizing ||
          process.cleanupUncertain ||
          process.finalizationFailed),
    )
  );
}

/** Removes expired registry entries and their backing runtime resources. */
async function pruneSandboxRegistryEntries<TEntry extends SandboxRegistryEntry>(params: {
  config: OpenClawConfig;
  assertCurrent?: () => void;
  entries: TEntry[];
  remove: (
    entry: TEntry,
    prune: SandboxRegistryPrune,
    assertPruneCurrent: () => void,
  ) => Promise<void>;
  stopIdle?: (
    entry: TEntry,
    prune: SandboxRegistryPrune,
    assertCurrent: () => void,
  ) => Promise<void>;
}) {
  using phases = observeDiagnosticsTimelinePhases("attempt.setup.sandbox.prune.registry_read");
  const now = Date.now();
  params.assertCurrent?.();
  for (const entry of params.entries) {
    const prune = {
      ...(entry.sessionKey.startsWith("worktree-dependencies:")
        ? { idleHours: 0, maxAgeDays: 0 }
        : resolveSandboxConfigForAgent(params.config, resolveSandboxAgentId(entry.sessionKey))
            .prune),
      now,
    };
    const retire = shouldPruneSandboxRegistryEntry(entry, prune)
      ? params.remove
      : shouldStopIdleContainer(entry, now)
        ? params.stopIdle
        : undefined;
    if (!retire) {
      continue;
    }
    try {
      phases.mark("attempt.setup.sandbox.prune.retire");
      await withSandboxRuntimePrune(entry, (assertPruneCurrent) =>
        retire(entry, prune, assertPruneCurrent),
      );
      params.assertCurrent?.();
    } catch (error) {
      params.assertCurrent?.();
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error);
      defaultRuntime.error?.(
        `Sandbox maintenance failed for ${entry.containerName}: ${message ?? "unknown error"}`,
      );
    }
  }
}

/** Prunes ordinary sandbox runtime containers from the configured backend manager. */
async function pruneSandboxContainers(
  config: OpenClawConfig,
  guard: WorkspaceStateGuard,
  entries: SandboxRegistryEntry[],
) {
  const assertCurrent = guard.beforeLegacyApply;
  let idleStops = 0;
  await pruneSandboxRegistryEntries({
    config,
    assertCurrent,
    entries,
    stopIdle: (entry, prune, assertPruneCurrent) => {
      if (idleStops >= MAX_IDLE_STOPS_PER_PASS) {
        return Promise.resolve();
      }
      return withSandboxRegistryEntryLock(entry, () =>
        withSandboxContainerLifecycle(entry.containerName, undefined, async () => {
          const current = await readRegistryEntry(entry.containerName);
          assertCurrent?.();
          assertPruneCurrent();
          if (
            !current ||
            !shouldStopIdleContainer(current, prune.now) ||
            hasActiveContainerUsage(current)
          ) {
            return;
          }
          const assertStopCurrent = () => {
            assertCurrent?.();
            assertPruneCurrent();
            assertSandboxRegistryRetirementCurrent("container", current);
            if (hasActiveContainerUsage(current)) {
              throw new Error("Sandbox runtime still owns an active command");
            }
          };
          const { hasSandboxPersistentExecCustody } = await import("./persistent-exec.js");
          if (await hasSandboxPersistentExecCustody({ containerName: current.containerName })) {
            return;
          }
          assertStopCurrent();
          const manager =
            current.backendId === "podman"
              ? podmanSandboxBackendManager
              : dockerSandboxBackendManager;
          // Charge attempts, including failures, but not active/protected runtimes.
          idleStops++;
          await manager.stopRuntime(current, assertStopCurrent);
          await updateRegistry(
            { ...current, runtimeState: "stopped" },
            {
              ...guard,
              beforeLegacyApply: assertStopCurrent,
            },
          );
        }),
      );
    },
    remove: (entry, prune, assertPruneCurrent) => {
      const assertRemovalCurrent = () => {
        assertCurrent?.();
        assertPruneCurrent();
      };
      if (entry.sessionKey.startsWith("worktree-dependencies:")) {
        return import("./dependency-template.js").then(({ retireSandboxDependencyBuilder }) =>
          retireSandboxDependencyBuilder(entry, assertRemovalCurrent, true),
        );
      }
      return removeSandboxRegistryRuntime(
        entry,
        async (current) => {
          using _ = observeDiagnosticsTimelinePhases("attempt.setup.sandbox.prune.backend_remove");
          const backendId = current.backendId ?? "docker";
          const manager = getSandboxBackendManager(backendId);
          if (!manager) {
            throw new Error(
              `Sandbox backend "${backendId}" is unavailable; enable its plugin before removing this runtime.`,
            );
          }
          assertRemovalCurrent();
          await manager.removeRuntime({
            entry: current,
            config,
            agentId: resolveSandboxAgentId(current.sessionKey),
          });
          assertRemovalCurrent();
        },
        {
          reserveRuntime: usesSandboxRuntimeReservations(entry.backendId ?? "docker"),
          prune,
          guard: { ...guard, beforeLegacyApply: assertRemovalCurrent },
          preservePersistentExecs: true,
        },
      );
    },
  });
}

/** Prunes browser bridge containers and closes matching in-process bridge servers. */
async function pruneSandboxBrowsers(config: OpenClawConfig, assertCurrent?: () => void) {
  await pruneSandboxRegistryEntries({
    config,
    assertCurrent,
    entries: (await readBrowserRegistry()).entries,
    remove: async (entry, prune, assertPruneCurrent) => {
      const assertRemovalCurrent = () => {
        assertCurrent?.();
        assertPruneCurrent();
      };
      using phases = observeDiagnosticsTimelinePhases("attempt.setup.sandbox.prune.browser_lock");
      await withSandboxRegistryEntryLock({ ...entry, backendId: "docker" }, async () => {
        phases.mark("attempt.setup.sandbox.prune.browser_read");
        assertRemovalCurrent();
        const current = (await readBrowserRegistry()).entries.find(
          (candidate) => candidate.containerName === entry.containerName,
        );
        assertRemovalCurrent();
        if (!current || !shouldPruneSandboxRegistryEntry(current, prune)) {
          return;
        }
        try {
          phases.mark("attempt.setup.sandbox.prune.browser_authority");
          assertSandboxRegistryRetirementCurrent("browser", entry);
        } catch {
          return;
        }
        phases.mark("attempt.setup.sandbox.prune.browser_bridge_stop");
        await stopCachedBrowserBridgesForContainer(current.containerName, assertRemovalCurrent);
        assertRemovalCurrent();
        phases.mark("attempt.setup.sandbox.prune.browser_remove");
        await dockerSandboxBackendManager.removeRuntime({
          entry: {
            ...current,
            backendId: "docker",
            runtimeLabel: current.containerName,
            configLabelKind: "Image",
          },
          config,
          agentId: resolveSandboxAgentId(current.sessionKey),
        });
        assertRemovalCurrent();
        phases.mark("attempt.setup.sandbox.prune.browser_registry_remove");
        await removeSandboxRegistryGeneration("browser", current, assertRemovalCurrent);
        assertRemovalCurrent();
      });
    },
  });
}

/** Coalesced housekeeping belongs to the state owner, not the requesting turn. */
export async function runSandboxPrune(assertHost: () => void): Promise<void> {
  assertHost();
  const assertLiveHost = await captureSandboxStateOwner();
  const assertCurrent = () => {
    assertHost();
    assertLiveHost();
  };
  assertCurrent();
  await pruneSandboxes(undefined, assertCurrent, assertCurrent);
}

export function scheduleSandboxPrune(assertHost: () => void, request = false): void {
  startSandboxRegistryHousekeeping(
    () => runSandboxPrune(assertHost),
    (error) => defaultRuntime.error?.(`Sandbox prune failed: ${formatErrorMessage(error)}`),
    undefined,
    request,
  );
}

export async function maybePruneSandboxes(
  config?: OpenClawConfig,
  assertCurrent?: () => void,
  assertHost?: () => void,
) {
  assertCurrent?.();
  return maybeRunSandboxRegistryHousekeeping(() =>
    pruneSandboxes(config, assertCurrent, assertHost),
  );
}

async function pruneSandboxes(
  config?: OpenClawConfig,
  assertCurrent?: () => void,
  assertHost?: () => void,
) {
  using phases = observeDiagnosticsTimelinePhases("attempt.setup.sandbox.prune.import");
  try {
    const currentConfig = config ?? getRuntimeConfig();
    const { recoverSandboxPersistentExecOrphans } = await import("./persistent-exec.js");
    const { entries } = await readRegistry();
    try {
      phases.mark("attempt.setup.sandbox.prune.orphan_recovery");
      await recoverSandboxPersistentExecOrphans(entries);
    } catch (error) {
      defaultRuntime.error?.(
        `Sandbox stream allocation cleanup failed: ${formatErrorMessage(error)}`,
      );
    }
    phases.mark("attempt.setup.sandbox.prune.containers");
    await pruneSandboxContainers(
      currentConfig,
      { assertHost, beforeLegacyApply: assertCurrent },
      entries,
    );
    assertCurrent?.();
    phases.mark("attempt.setup.sandbox.prune.browsers");
    await pruneSandboxBrowsers(currentConfig, assertCurrent);
    assertCurrent?.();
  } catch (error) {
    assertCurrent?.();
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error);
    defaultRuntime.error?.(`Sandbox prune failed: ${message ?? "unknown error"}`);
  }
}
