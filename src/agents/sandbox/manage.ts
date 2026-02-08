import type { SandboxBackend } from "./types.js";
import { stopBrowserBridgeServer } from "../../browser/bridge-server.js";
import { loadConfig } from "../../config/config.js";
import { BROWSER_BRIDGES } from "./browser-bridges.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { DEFAULT_SANDBOX_MICROVM_PREFIX, DEFAULT_SANDBOX_MICROVM_TEMPLATE } from "./constants.js";
import { dockerSandboxState, execDockerSandbox } from "./docker-sandboxes.js";
import { dockerContainerState, execDocker } from "./docker.js";
import {
  readBrowserRegistry,
  readRegistry,
  removeBrowserRegistryEntry,
  removeRegistryEntry,
  type SandboxBrowserRegistryEntry,
  type SandboxRegistryEntry,
} from "./registry.js";
import { resolveSandboxAgentId } from "./shared.js";

export type SandboxContainerInfo = SandboxRegistryEntry & {
  running: boolean;
  imageMatch: boolean;
  backend: SandboxBackend;
};

export type SandboxBrowserInfo = SandboxBrowserRegistryEntry & {
  running: boolean;
  imageMatch: boolean;
};

/**
 * Detect the backend for a sandbox entry.
 * Reads the `backend` field from the registry entry when available;
 * falls back to a name-prefix heuristic for entries created before
 * the backend field was added.
 *
 * @internal Exported for testing.
 */
export function detectBackend(
  containerName: string,
  registryEntry?: { backend?: "container" | "microvm" },
): SandboxBackend {
  if (registryEntry?.backend) {
    return registryEntry.backend;
  }
  // Fallback: prefix heuristic for old registry entries.
  return containerName.startsWith(DEFAULT_SANDBOX_MICROVM_PREFIX) ? "microvm" : "container";
}

export async function listSandboxContainers(): Promise<SandboxContainerInfo[]> {
  const config = loadConfig();
  const registry = await readRegistry();
  const results: SandboxContainerInfo[] = [];

  for (const entry of registry.entries) {
    const backend = detectBackend(entry.containerName, entry);

    let state: { exists: boolean; running: boolean };
    if (backend === "microvm") {
      state = await dockerSandboxState(entry.containerName);
    } else {
      state = await dockerContainerState(entry.containerName);
    }

    // Get actual image from container (only for container backend)
    let actualImage = entry.image;
    if (backend === "container" && state.exists) {
      try {
        const result = await execDocker(
          ["inspect", "-f", "{{.Config.Image}}", entry.containerName],
          { allowFailure: true },
        );
        if (result.code === 0) {
          actualImage = result.stdout.trim();
        }
      } catch {
        // ignore
      }
    }
    const agentId = resolveSandboxAgentId(entry.sessionKey);
    const sandboxConfig = resolveSandboxConfigForAgent(config, agentId);
    const configuredImage =
      backend === "microvm"
        ? (sandboxConfig.microvm.template ?? DEFAULT_SANDBOX_MICROVM_TEMPLATE)
        : sandboxConfig.docker.image;
    results.push({
      ...entry,
      image: actualImage,
      running: state.running,
      imageMatch: actualImage === configuredImage,
      backend,
    });
  }

  return results;
}

export async function listSandboxBrowsers(): Promise<SandboxBrowserInfo[]> {
  const config = loadConfig();
  const registry = await readBrowserRegistry();
  const results: SandboxBrowserInfo[] = [];

  for (const entry of registry.entries) {
    const state = await dockerContainerState(entry.containerName);
    let actualImage = entry.image;
    if (state.exists) {
      try {
        const result = await execDocker(
          ["inspect", "-f", "{{.Config.Image}}", entry.containerName],
          { allowFailure: true },
        );
        if (result.code === 0) {
          actualImage = result.stdout.trim();
        }
      } catch {
        // ignore
      }
    }
    const agentId = resolveSandboxAgentId(entry.sessionKey);
    const configuredImage = resolveSandboxConfigForAgent(config, agentId).browser.image;
    results.push({
      ...entry,
      image: actualImage,
      running: state.running,
      imageMatch: actualImage === configuredImage,
    });
  }

  return results;
}

export async function removeSandboxContainer(containerName: string): Promise<void> {
  const registry = await readRegistry();
  const entry = registry.entries.find((e) => e.containerName === containerName);
  const backend = detectBackend(containerName, entry);
  try {
    if (backend === "microvm") {
      await execDockerSandbox(["rm", containerName], { allowFailure: true });
    } else {
      await execDocker(["rm", "-f", containerName], { allowFailure: true });
    }
  } catch {
    // ignore removal failures
  }
  await removeRegistryEntry(containerName);
}

export async function removeSandboxBrowserContainer(containerName: string): Promise<void> {
  try {
    await execDocker(["rm", "-f", containerName], { allowFailure: true });
  } catch {
    // ignore removal failures
  }
  await removeBrowserRegistryEntry(containerName);

  // Stop browser bridge if active
  for (const [sessionKey, bridge] of BROWSER_BRIDGES.entries()) {
    if (bridge.containerName === containerName) {
      await stopBrowserBridgeServer(bridge.bridge.server).catch(() => undefined);
      BROWSER_BRIDGES.delete(sessionKey);
    }
  }
}
