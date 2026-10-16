import { getRuntimeConfig } from "../../config/config.js";
import { getSandboxBackendManager, usesSandboxRuntimeReservations } from "./backend.js";
import type { SandboxBackendManager, SandboxBackendRuntimeInfo } from "./backend.types.js";
import {
  BROWSER_BRIDGES,
  stopCachedBrowserBridgesForContainer,
  stopCachedBrowserBridge,
  type CachedBrowserBridge,
} from "./browser-bridges.js";
import { removeSandboxContainerRuntime } from "./container-lifecycle.js";
import { dockerSandboxBackendManager } from "./docker-backend.js";
import {
  execContainer,
  validateSandboxContainerEngineTarget,
  type SandboxContainerEngine,
} from "./docker.js";
import {
  readBrowserRegistry,
  readRegistry,
  removeBrowserRegistryEntry,
  removeRegistryEntry,
  removeSandboxRegistryRuntime,
  removeSandboxRegistryGeneration,
  type SandboxBrowserRegistryEntry,
  type SandboxRegistryEntry,
} from "./registry.js";
import { resolveSandboxAgentId } from "./shared.js";

export type SandboxContainerInfo = SandboxRegistryEntry & {
  running: boolean;
  imageMatch: boolean;
};

export type SandboxBrowserInfo = SandboxBrowserRegistryEntry & {
  running: boolean;
  imageMatch: boolean;
};

function toBrowserDockerRuntimeEntry(entry: SandboxBrowserRegistryEntry): SandboxRegistryEntry {
  return {
    ...entry,
    backendId: "docker",
    runtimeLabel: entry.containerName,
    configLabelKind: "BrowserImage",
  };
}

async function listSandboxRuntimes<T extends SandboxRegistryEntry>(
  read: () => Promise<{ entries: T[] }>,
  resolveRuntime: (entry: T) => {
    manager: SandboxBackendManager | null;
    entry: SandboxRegistryEntry;
  },
  matches?: (entry: T) => boolean,
): Promise<Array<T & { running: boolean; imageMatch: boolean }>> {
  const config = getRuntimeConfig();
  const registry = await read();
  const results: Array<T & { running: boolean; imageMatch: boolean }> = [];
  for (const entry of registry.entries) {
    // Select before probing: an unrelated backend may be unavailable or use another connection.
    if (matches && !matches(entry)) {
      continue;
    }
    const selected = resolveRuntime(entry);
    const runtime: SandboxBackendRuntimeInfo = selected.manager
      ? await selected.manager.describeRuntime({
          entry: selected.entry,
          config,
          agentId: resolveSandboxAgentId(entry.sessionKey),
        })
      : { running: false, configLabelMatch: true };
    results.push({
      ...entry,
      image: runtime.actualConfigLabel ?? entry.image,
      running: runtime.running,
      imageMatch: runtime.configLabelMatch,
    });
  }
  return results;
}

export async function listSandboxContainers(
  matches?: (entry: SandboxRegistryEntry) => boolean,
): Promise<SandboxContainerInfo[]> {
  return listSandboxRuntimes(
    readRegistry,
    (entry) => ({
      manager: getSandboxBackendManager(entry.backendId ?? "docker"),
      entry,
    }),
    matches,
  );
}

export async function listSandboxBrowsers(
  matches?: (entry: SandboxBrowserRegistryEntry) => boolean,
): Promise<SandboxBrowserInfo[]> {
  return listSandboxRuntimes(
    readBrowserRegistry,
    (entry) => ({
      manager: dockerSandboxBackendManager,
      entry: toBrowserDockerRuntimeEntry(entry),
    }),
    matches,
  );
}

/** Retire only the physical generation fenced by local workspace settlement. */
export async function removeSandboxRuntimeGeneration(params: {
  runtime: { assertCurrent: () => void } & (
    | { kind: "container"; entry: SandboxRegistryEntry }
    | { kind: "browser"; entry: SandboxBrowserRegistryEntry }
  );
  engine: SandboxContainerEngine;
  id: string | null;
  bridges: ReadonlyArray<readonly [string, CachedBrowserBridge]>;
  assertCurrent: () => void;
}): Promise<void> {
  const { runtime, engine, id } = params;
  const assertOwnerCurrent = () => {
    params.assertCurrent();
    if (
      runtime.kind === "browser" &&
      [...BROWSER_BRIDGES].some(
        ([key, bridge]) =>
          bridge.containerName === runtime.entry.containerName &&
          !params.bridges.some(
            ([capturedKey, captured]) => capturedKey === key && captured === bridge,
          ),
      )
    ) {
      throw new Error("Sandbox browser bridge generation changed during retirement");
    }
  };
  const assertCurrent = () => {
    assertOwnerCurrent();
    runtime.assertCurrent();
  };
  if (id !== null && !/^[a-f0-9]{64}$/u.test(id)) {
    throw new Error("Invalid sandbox runtime generation");
  }
  assertCurrent();
  await validateSandboxContainerEngineTarget(
    engine,
    runtime.kind === "container" ? runtime.entry.backendTarget : undefined,
  );
  assertCurrent();
  await removeSandboxContainerRuntime(engine, runtime.entry.containerName, { id, assertCurrent });
  // A name can be rebound without a registry update. Never forget its replacement's
  // metadata or bridge merely because the old physical ID was already absent.
  const assertAbsent = async () => {
    const named = await execContainer(
      engine,
      ["inspect", "-f", "{{.Id}}", runtime.entry.containerName],
      { allowFailure: true },
    );
    assertCurrent();
    if (named.code === 0 || !/no such (?:container|object)|does not exist/iu.test(named.stderr)) {
      throw new Error(
        "Sandbox runtime generation changed or removal is unconfirmed; custody retained",
      );
    }
  };
  await assertAbsent();
  for (const [sessionKey, bridge] of params.bridges) {
    assertCurrent();
    await stopCachedBrowserBridge(sessionKey, bridge);
    assertCurrent();
  }
  if (params.bridges.length) {
    await assertAbsent();
  }
  await removeSandboxRegistryGeneration(runtime.kind, runtime.entry, assertOwnerCurrent);
}

export async function removeSandboxContainer(containerName: string): Promise<void> {
  const config = getRuntimeConfig();
  const registry = await readRegistry();
  const entry = registry.entries.find((item) => item.containerName === containerName);
  if (entry) {
    const backendId = entry.backendId ?? "docker";
    const manager = getSandboxBackendManager(backendId);
    if (!manager) {
      throw new Error(
        `Sandbox backend "${backendId}" is unavailable; enable its plugin before removing this runtime.`,
      );
    }
    await removeSandboxRegistryRuntime(
      entry,
      (current) =>
        manager.removeRuntime({
          entry: current,
          config,
          agentId: resolveSandboxAgentId(current.sessionKey),
        }),
      { reserveRuntime: usesSandboxRuntimeReservations(backendId) },
    );
    return;
  }
  await removeRegistryEntry(containerName);
}

export async function removeSandboxBrowserContainer(containerName: string): Promise<void> {
  const config = getRuntimeConfig();
  const registry = await readBrowserRegistry();
  const entry = registry.entries.find((item) => item.containerName === containerName);
  await stopCachedBrowserBridgesForContainer(containerName);
  if (entry) {
    await dockerSandboxBackendManager.removeRuntime({
      entry: toBrowserDockerRuntimeEntry(entry),
      config,
    });
  }
  await removeBrowserRegistryEntry(containerName);
}
