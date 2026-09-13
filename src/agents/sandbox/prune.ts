import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
/**
 * Sandbox registry pruning.
 *
 * Removes stale runtime containers and browser bridges on a best-effort schedule.
 */
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { defaultRuntime } from "../../runtime.js";
import { getSandboxBackendManager, usesSandboxRuntimeReservations } from "./backend.js";
import { stopCachedBrowserBridgesForContainer } from "./browser-bridges.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { dockerSandboxBackendManager } from "./docker-backend.js";
import {
  readBrowserRegistry,
  readRegistry,
  removeBrowserRegistryEntryIfUnchanged,
  removeSandboxRegistryRuntime,
  type SandboxBrowserRegistryEntry,
  type SandboxRegistryEntry,
} from "./registry.js";
import {
  resolveSandboxRuntimeActivityKey,
  tryWithSandboxRuntimeMutations,
} from "./runtime-activity.js";
import { withSandboxScopeLock } from "./scope-lock.js";
import { resolveSandboxAgentId } from "./shared.js";
import type { SandboxConfig } from "./types.js";

let lastPruneAtMs = 0;

type PruneableRegistryEntry = Pick<
  SandboxRegistryEntry,
  "containerName" | "backendId" | "sessionKey" | "createdAtMs" | "lastUsedAtMs"
>;

function resolvePruneConfig(config: OpenClawConfig, entry: PruneableRegistryEntry) {
  return resolveSandboxConfigForAgent(config, resolveSandboxAgentId(entry.sessionKey));
}

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

/** Removes expired registry entries and their backing runtime resources. */
async function pruneSandboxRegistryEntries<TEntry extends SandboxRegistryEntry>(params: {
  config: OpenClawConfig;
  runtimeKey: (entry: TEntry) => string;
  read: () => Promise<{ entries: TEntry[] }>;
  remove: (entry: TEntry) => Promise<void>;
}) {
  const now = Date.now();
  const registry = await params.read();
  for (const entry of registry.entries) {
    if (!shouldPruneSandboxEntry(resolvePruneConfig(params.config, entry), now, entry)) {
      continue;
    }
    try {
      await withSandboxScopeLock(entry.sessionKey, async () => {
        await tryWithSandboxRuntimeMutations([params.runtimeKey(entry)], async (lifecycle) => {
          const current = (await params.read()).entries.find(
            (candidate) => candidate.containerName === entry.containerName,
          );
          if (
            !current ||
            current.registryGeneration !== entry.registryGeneration ||
            !shouldPruneSandboxEntry(resolvePruneConfig(params.config, current), now, current)
          ) {
            return;
          }
          await params.remove(current);
          if (
            !(await params.read()).entries.some(
              (candidate) => candidate.containerName === current.containerName,
            )
          ) {
            lifecycle.retire();
          }
        });
      });
    } catch (error) {
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
async function pruneSandboxContainers(config: OpenClawConfig) {
  await pruneSandboxRegistryEntries<SandboxRegistryEntry>({
    config,
    runtimeKey: (entry) =>
      resolveSandboxRuntimeActivityKey(
        entry.backendId ?? "docker",
        entry.containerName,
        entry.backendTarget?.key,
      ),
    read: readRegistry,
    remove: (entry) =>
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
          await manager.removeRuntime({
            entry: current,
            config,
            agentId: resolveSandboxAgentId(current.sessionKey),
          });
        },
        {
          reserveRuntime: usesSandboxRuntimeReservations(entry.backendId ?? "docker"),
          shouldRemove: (current) => current.registryGeneration === entry.registryGeneration,
        },
      ),
  });
}

/** Prunes browser bridge containers and closes matching in-process bridge servers. */
async function pruneSandboxBrowsers(config: OpenClawConfig) {
  await pruneSandboxRegistryEntries<
    SandboxBrowserRegistryEntry & {
      backendId?: string;
      runtimeLabel?: string;
      configLabelKind?: string;
    }
  >({
    config,
    runtimeKey: (entry) => resolveSandboxRuntimeActivityKey("docker", entry.containerName),
    read: readBrowserRegistry,
    remove: async (entry) => {
      await stopCachedBrowserBridgesForContainer(entry.containerName);
      await dockerSandboxBackendManager.removeRuntime({
        entry: {
          ...entry,
          backendId: "docker",
          runtimeLabel: entry.containerName,
          configLabelKind: "Image",
        },
        config,
      });
      await removeBrowserRegistryEntryIfUnchanged(entry);
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
    await pruneSandboxContainers(config);
    await pruneSandboxBrowsers(config);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error);
    defaultRuntime.error?.(`Sandbox prune failed: ${message ?? "unknown error"}`);
  }
}
