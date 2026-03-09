import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ISandboxProvider, SandboxBackend } from "./provider.js";
import { DockerProvider } from "./providers/docker-provider.js";
import { FirecrackerProvider } from "./providers/firecracker-provider.js";
import { GVisorProvider } from "./providers/gvisor-provider.js";

const log = createSubsystemLogger("sandbox-resolver");

const DETECTION_ORDER: Array<Exclude<SandboxBackend, "auto">> = ["firecracker", "gvisor", "docker"];

let cachedProvider: ISandboxProvider | null = null;
let cachedBackend: SandboxBackend | null = null;

function createProvider(backend: Exclude<SandboxBackend, "auto">): ISandboxProvider {
  switch (backend) {
    case "docker":
      return new DockerProvider();
    case "gvisor":
      return new GVisorProvider();
    case "firecracker":
      return new FirecrackerProvider();
    default: {
      const _exhaustive: never = backend;
      void _exhaustive;
      throw new Error("Unknown sandbox backend");
    }
  }
}

export async function resolveProvider(
  requestedBackend: SandboxBackend = "auto",
): Promise<ISandboxProvider> {
  // Return cached if compatible
  if (cachedProvider && (requestedBackend === "auto" || requestedBackend === cachedBackend)) {
    return cachedProvider;
  }

  if (requestedBackend !== "auto") {
    // Explicit backend selection — bypasses auto-detection
    const provider = createProvider(requestedBackend);
    const health = await provider.checkHealth();

    if (!health.available) {
      throw new Error(`Sandbox backend '${requestedBackend}' is not available: ${health.message}`);
    }

    log.info(
      `Using explicitly selected sandbox backend: ${requestedBackend} (${health.version ?? "unknown version"})`,
    );

    cachedProvider = provider;
    cachedBackend = requestedBackend;
    return provider;
  }

  // Auto-detection: try backends in priority order
  for (const backend of DETECTION_ORDER) {
    const provider = createProvider(backend);
    const health = await provider.checkHealth();

    if (health.available) {
      log.info(
        `Auto-detected sandbox backend: ${backend} (${health.version ?? "unknown version"})`,
      );
      cachedProvider = provider;
      cachedBackend = backend;
      return provider;
    }

    log.debug(`Backend ${backend} not available: ${health.message}`);
  }

  throw new Error("No sandbox backend available. Ensure Docker is installed and running.");
}

export function resetProviderCache(): void {
  cachedProvider = null;
  cachedBackend = null;
}
