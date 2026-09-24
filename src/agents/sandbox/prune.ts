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
  assertSandboxBrowserRegistryEntryCurrent,
  readBrowserRegistry,
  readRegistry,
  removeSandboxRegistryGeneration,
  removeSandboxRegistryRuntime,
  withSandboxRegistryEntryLock,
  type SandboxBrowserRegistryEntry,
  type SandboxRegistryEntry,
} from "./registry.js";
import { resolveSandboxAgentId } from "./shared.js";
import type { SandboxPruneConfig } from "./types.js";

let lastPruneAtMs = 0;

type PruneableRegistryEntry = Pick<
  SandboxRegistryEntry,
  "containerName" | "backendId" | "createdAtMs" | "lastUsedAtMs" | "sessionKey"
>;

function resolveEntryPruneConfig(config: OpenClawConfig, entry: PruneableRegistryEntry) {
  return resolveSandboxConfigForAgent(config, resolveSandboxAgentId(entry.sessionKey)).prune;
}

function shouldPruneSandboxEntry(
  prune: SandboxPruneConfig,
  now: number,
  entry: PruneableRegistryEntry,
) {
  const idleHours = prune.idleHours;
  const maxAgeDays = prune.maxAgeDays;
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
  read: () => Promise<{ entries: TEntry[] }>;
  remove: (
    entry: TEntry,
    shouldRemove: (current: SandboxRegistryEntry) => boolean,
  ) => Promise<void>;
}) {
  const now = Date.now();
  const registry = await params.read();
  for (const entry of registry.entries) {
    if (!shouldPruneSandboxEntry(resolveEntryPruneConfig(params.config, entry), now, entry)) {
      continue;
    }
    try {
      await params.remove(entry, (current) =>
        shouldPruneSandboxEntry(resolveEntryPruneConfig(params.config, current), now, current),
      );
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
    read: readRegistry,
    remove: (entry, shouldRemove) =>
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
          shouldRemove,
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
    read: readBrowserRegistry,
    remove: async (entry, shouldRemove) => {
      await withSandboxRegistryEntryLock({ ...entry, backendId: "docker" }, async () => {
        const current = (await readBrowserRegistry()).entries.find(
          (candidate) => candidate.containerName === entry.containerName,
        );
        if (!current || !shouldRemove(current)) {
          return;
        }
        try {
          assertSandboxBrowserRegistryEntryCurrent(entry);
        } catch {
          return;
        }
        await stopCachedBrowserBridgesForContainer(current.containerName);
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
        removeSandboxRegistryGeneration("browser", current, () =>
          assertSandboxBrowserRegistryEntryCurrent(current),
        );
      });
    },
  });
}

/** Runs sandbox pruning at most once per throttle window. */
export async function maybePruneSandboxes(config?: OpenClawConfig) {
  const now = Date.now();
  if (now - lastPruneAtMs < 5 * 60 * 1000) {
    return;
  }
  lastPruneAtMs = now;
  try {
    const currentConfig = config ?? getRuntimeConfig();
    await pruneSandboxContainers(currentConfig);
    await pruneSandboxBrowsers(currentConfig);
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
