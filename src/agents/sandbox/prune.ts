import { stopBrowserBridgeServer } from "../../browser/bridge-server.js";
import { defaultRuntime } from "../../runtime.js";
import { BROWSER_BRIDGES } from "./browser-bridges.js";
import { dockerContainerState, execDocker } from "./docker.js";
import {
  readBrowserRegistry,
  readRegistry,
  removeBrowserRegistryEntry,
  removeRegistryEntry,
  type SandboxBrowserRegistryEntry,
  type SandboxRegistryEntry,
} from "./registry.js";
import type { SandboxConfig } from "./types.js";

let lastPruneAtMs = 0;

type PruneableRegistryEntry = Pick<
  SandboxRegistryEntry,
  "containerName" | "createdAtMs" | "lastUsedAtMs"
>;

function shouldPruneSandboxEntry(cfg: SandboxConfig, now: number, entry: PruneableRegistryEntry) {
  const idleHours = cfg.prune.idleHours;
  const maxAgeDays = cfg.prune.maxAgeDays;
  if (idleHours === 0 && maxAgeDays === 0) {
    return false;
  }
  const idleMs = now - entry.lastUsedAtMs;
  const ageMs = now - entry.createdAtMs;
  return (
    (idleHours > 0 && idleMs > idleHours * 60 * 60 * 1000) ||
    (maxAgeDays > 0 && ageMs > maxAgeDays * 24 * 60 * 60 * 1000)
  );
}

async function pruneSandboxRegistryEntries<TEntry extends PruneableRegistryEntry>(params: {
  cfg: SandboxConfig;
  read: () => Promise<{ entries: TEntry[] }>;
  remove: (containerName: string) => Promise<void>;
  onRemoved?: (entry: TEntry) => Promise<void>;
}) {
  const now = Date.now();
  if (params.cfg.prune.idleHours === 0 && params.cfg.prune.maxAgeDays === 0) {
    return;
  }
  const registry = await params.read();
  for (const entry of registry.entries) {
    if (!shouldPruneSandboxEntry(params.cfg, now, entry)) {
      continue;
    }
    try {
      await execDocker(["rm", "-f", entry.containerName], {
        allowFailure: true,
      });
    } catch {
      // ignore prune failures
    } finally {
      await params.remove(entry.containerName);
      await params.onRemoved?.(entry);
    }
  }
}

async function pruneSandboxContainers(cfg: SandboxConfig) {
  await pruneSandboxRegistryEntries<SandboxRegistryEntry>({
    cfg,
    read: readRegistry,
    remove: removeRegistryEntry,
  });
}

async function pruneSandboxBrowsers(cfg: SandboxConfig) {
  await pruneSandboxRegistryEntries<SandboxBrowserRegistryEntry>({
    cfg,
    read: readBrowserRegistry,
    remove: removeBrowserRegistryEntry,
    onRemoved: async (entry) => {
      const bridge = BROWSER_BRIDGES.get(entry.sessionKey);
      if (bridge?.containerName === entry.containerName) {
        await stopBrowserBridgeServer(bridge.bridge.server).catch(() => undefined);
        BROWSER_BRIDGES.delete(entry.sessionKey);
      }
    },
  });
}

export async function maybePruneSandboxes(cfg: SandboxConfig) {
  const now = Date.now();
  if (now - lastPruneAtMs < 5 * 60 * 1000) {
    return;
  }
  lastPruneAtMs = now;
  try {
    await pruneSandboxContainers(cfg);
    await pruneSandboxBrowsers(cfg);
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

export async function ensureDockerContainerIsRunning(containerName: string) {
  const state = await dockerContainerState(containerName);
  if (state.exists && !state.running) {
    await execDocker(["start", containerName]);
  }
}
