/**
 * CLI-facing sandbox management helpers.
 *
 * Lists and removes registered runtime and browser containers using backend manager status.
 */
import { getRuntimeConfig } from "../../config/config.js";
import { getSandboxBackendManager, usesSandboxRuntimeReservations } from "./backend.js";
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

/** Lists registered sandbox containers with live backend status and config-label match state. */
export async function listSandboxContainers(): Promise<SandboxContainerInfo[]> {
  const config = getRuntimeConfig();
  const registry = await readRegistry();
  const results: SandboxContainerInfo[] = [];

  for (const entry of registry.entries) {
    const backendId = entry.backendId ?? "docker";
    const manager = getSandboxBackendManager(backendId);
    if (!manager) {
      results.push({
        ...entry,
        running: false,
        imageMatch: true,
      });
      continue;
    }
    const agentId = resolveSandboxAgentId(entry.sessionKey);
    const runtime = await manager.describeRuntime({
      entry,
      config,
      agentId,
    });
    results.push({
      ...entry,
      image: runtime.actualConfigLabel ?? entry.image,
      running: runtime.running,
      imageMatch: runtime.configLabelMatch,
    });
  }

  return results;
}

/** Lists registered browser sandbox containers with live Docker status. */
export async function listSandboxBrowsers(): Promise<SandboxBrowserInfo[]> {
  const config = getRuntimeConfig();
  const registry = await readBrowserRegistry();
  const results: SandboxBrowserInfo[] = [];

  for (const entry of registry.entries) {
    const agentId = resolveSandboxAgentId(entry.sessionKey);
    const runtime = await dockerSandboxBackendManager.describeRuntime({
      entry: toBrowserDockerRuntimeEntry(entry),
      config,
      agentId,
    });
    results.push({
      ...entry,
      image: runtime.actualConfigLabel ?? entry.image,
      running: runtime.running,
      imageMatch: runtime.configLabelMatch,
    });
  }

  return results;
}

/** Retire only the physical generation fenced by local workspace settlement. */
export async function removeSandboxRuntimeGeneration(params: {
  runtime:
    | { kind: "container"; entry: SandboxRegistryEntry }
    | { kind: "browser"; entry: SandboxBrowserRegistryEntry };
  engine: SandboxContainerEngine;
  id: string | null;
  bridges: ReadonlyArray<readonly [string, CachedBrowserBridge]>;
  assertCurrent: () => void;
}): Promise<void> {
  const { runtime, engine, id } = params;
  const assertCurrent = () => {
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
  removeSandboxRegistryGeneration(runtime.kind, runtime.entry, assertCurrent);
}

/** Removes one sandbox container from its backend and registry. */
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

/** Removes one browser sandbox container, registry entry, and any in-process bridge server. */
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
