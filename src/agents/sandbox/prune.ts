/**
 * Sandbox registry pruning.
 *
 * Removes stale runtime containers and browser bridges on a best-effort schedule.
 */
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { defaultRuntime } from "../../runtime.js";
import type { WorkspaceStateGuard } from "../workspace-state-store.worker-contract.js";
import { getSandboxBackendManager, usesSandboxRuntimeReservations } from "./backend.js";
import { stopCachedBrowserBridgesForContainer } from "./browser-bridges.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { dockerSandboxBackendManager } from "./docker-backend.js";
import {
  assertSandboxBrowserRegistryEntryCurrent,
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

let lastPruneAtMs = 0;

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
  remove: (entry: TEntry, prune: SandboxRegistryPrune) => Promise<void>;
}) {
  const now = Date.now();
  const registry = await params.read();
  params.assertCurrent?.();
  for (const entry of registry.entries) {
    const prune = { ...resolveEntryPruneConfig(params.config, entry), now };
    if (!shouldPruneSandboxRegistryEntry(entry, prune)) {
      continue;
    }
    try {
      await params.remove(entry, prune);
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
    remove: (entry, prune) =>
      removeSandboxRegistryRuntime(
        entry,
        async (current) => {
          const backendId = current.backendId ?? "docker";
          const manager = getSandboxBackendManager(backendId);
          if (!manager) {
            throw new Error(
              `Sandbox backend "${backendId}" is unavailable; enable its plugin before removing this runtime.`,
            );
          }
          assertCurrent?.();
          await manager.removeRuntime({
            entry: current,
            config,
            agentId: resolveSandboxAgentId(current.sessionKey),
          });
          assertCurrent?.();
        },
        {
          reserveRuntime: usesSandboxRuntimeReservations(entry.backendId ?? "docker"),
          prune,
          guard,
        },
      ),
  });
}

/** Prunes browser bridge containers and closes matching in-process bridge servers. */
async function pruneSandboxBrowsers(config: OpenClawConfig, assertCurrent?: () => void) {
  await pruneSandboxRegistryEntries<SandboxBrowserRegistryEntry>({
    config,
    assertCurrent,
    read: readBrowserRegistry,
    remove: async (entry, prune) => {
      await withSandboxRegistryEntryLock({ ...entry, backendId: "docker" }, async () => {
        assertCurrent?.();
        const current = (await readBrowserRegistry()).entries.find(
          (candidate) => candidate.containerName === entry.containerName,
        );
        assertCurrent?.();
        if (!current || !shouldPruneSandboxRegistryEntry(current, prune)) {
          return;
        }
        try {
          assertSandboxBrowserRegistryEntryCurrent(entry);
        } catch {
          return;
        }
        assertCurrent?.();
        await stopCachedBrowserBridgesForContainer(current.containerName, assertCurrent);
        assertCurrent?.();
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
        assertCurrent?.();
        await removeSandboxRegistryGeneration("browser", current, assertCurrent);
        assertCurrent?.();
      });
    },
  });
}

/** Runs sandbox pruning at most once per throttle window. */
export async function maybePruneSandboxes(
  config?: OpenClawConfig,
  assertCurrent?: () => void,
  assertHost?: () => void,
) {
  assertCurrent?.();
  const now = Date.now();
  if (now - lastPruneAtMs < 5 * 60 * 1000) {
    return;
  }
  lastPruneAtMs = now;
  try {
    const currentConfig = config ?? getRuntimeConfig();
    await pruneSandboxContainers(currentConfig, { assertHost, beforeLegacyApply: assertCurrent });
    assertCurrent?.();
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
