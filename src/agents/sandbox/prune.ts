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
import type { WorkspaceStateGuard } from "../workspace-state-store.worker-contract.js";
import { getSandboxBackendManager, usesSandboxRuntimeReservations } from "./backend.js";
import { stopCachedBrowserBridgesForContainer } from "./browser-bridges.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { dockerSandboxBackendManager } from "./docker-backend.js";
import {
  maybeRunSandboxRegistryHousekeeping,
  startSandboxRegistryHousekeeping,
  withSandboxRuntimePrune,
} from "./registry-lifecycle.js";
import {
  assertSandboxRegistryRetirementCurrent,
  readBrowserRegistry,
  readRegistry,
  removeSandboxRegistryGeneration,
  removeSandboxRegistryRuntime,
  withSandboxRegistryEntryLock,
  type SandboxBrowserRegistryEntry,
  type SandboxRegistryEntry,
} from "./registry.js";
import { shouldPruneSandboxRegistryEntry, type SandboxRegistryPrune } from "./registry.kernel.js";
import { resolveSandboxAgentId } from "./shared.js";
import { captureSandboxStateOwner } from "./state-owner.js";

type PruneableRegistryEntry = Pick<
  SandboxRegistryEntry,
  "containerName" | "backendId" | "createdAtMs" | "lastUsedAtMs" | "sessionKey"
>;

function resolveEntryPruneConfig(config: OpenClawConfig, entry: PruneableRegistryEntry) {
  return resolveSandboxConfigForAgent(config, resolveSandboxAgentId(entry.sessionKey)).prune;
}

/** Removes expired registry entries and their backing runtime resources. */
async function pruneSandboxRegistryEntries<TEntry extends SandboxRegistryEntry>(params: {
  config: OpenClawConfig;
  assertCurrent?: () => void;
  read: () => Promise<{ entries: TEntry[] }>;
  remove: (
    entry: TEntry,
    prune: SandboxRegistryPrune,
    assertPruneCurrent: () => void,
  ) => Promise<void>;
}) {
  using phases = observeDiagnosticsTimelinePhases("attempt.setup.sandbox.prune.registry_read");
  const now = Date.now();
  const registry = await params.read();
  params.assertCurrent?.();
  for (const entry of registry.entries) {
    const prune = { ...resolveEntryPruneConfig(params.config, entry), now };
    if (!shouldPruneSandboxRegistryEntry(entry, prune)) {
      continue;
    }
    try {
      phases.mark("attempt.setup.sandbox.prune.retire");
      await withSandboxRuntimePrune(entry, (assertPruneCurrent) =>
        params.remove(entry, prune, assertPruneCurrent),
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
        `Sandbox prune failed to remove ${entry.containerName}: ${message ?? "unknown error"}`,
      );
    }
  }
}

/** Prunes ordinary sandbox runtime containers from the configured backend manager. */
async function pruneSandboxContainers(config: OpenClawConfig, guard: WorkspaceStateGuard) {
  const assertCurrent = guard.beforeLegacyApply;
  await pruneSandboxRegistryEntries<SandboxRegistryEntry>({
    config,
    assertCurrent,
    read: readRegistry,
    remove: (entry, prune, assertPruneCurrent) => {
      const assertRemovalCurrent = () => {
        assertCurrent?.();
        assertPruneCurrent();
      };
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
  await pruneSandboxRegistryEntries<SandboxBrowserRegistryEntry>({
    config,
    assertCurrent,
    read: readBrowserRegistry,
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
          await assertSandboxRegistryRetirementCurrent("browser", entry);
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
export function scheduleSandboxPrune(assertHost: () => void): void {
  startSandboxRegistryHousekeeping(
    async () => {
      assertHost();
      // An offline SDK caller may have acquired a foreign Gateway owner since the last pass.
      const assertLiveHost = await captureSandboxStateOwner();
      const assertCurrent = () => {
        assertHost();
        assertLiveHost();
      };
      assertCurrent();
      await pruneSandboxes(undefined, assertCurrent, assertCurrent);
    },
    (error) => defaultRuntime.error?.(`Sandbox prune failed: ${formatErrorMessage(error)}`),
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
    try {
      phases.mark("attempt.setup.sandbox.prune.orphan_recovery");
      await recoverSandboxPersistentExecOrphans();
    } catch (error) {
      defaultRuntime.error?.(
        `Sandbox stream allocation cleanup failed: ${formatErrorMessage(error)}`,
      );
    }
    phases.mark("attempt.setup.sandbox.prune.containers");
    await pruneSandboxContainers(currentConfig, { assertHost, beforeLegacyApply: assertCurrent });
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
