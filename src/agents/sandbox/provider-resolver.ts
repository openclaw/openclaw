/**
 * Provider Resolver: Auto-detects and instantiates the best available sandbox provider.
 *
 * Detection order (highest isolation first):
 *   1. Firecracker MicroVM (requires /dev/kvm) - hardware-level VM isolation
 *   2. gVisor/runsc (Docker runtime) - user-space kernel isolation
 *   3. Docker (standard) - container-level isolation
 *
 * The resolver caches the provider instance for the lifetime of the process.
 */

import { execSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ISandboxProvider, SandboxBackend } from "./provider.js";
import { DockerProvider } from "./providers/docker-provider.js";
import { GVisorProvider } from "./providers/gvisor-provider.js";
import type { SandboxConfig } from "./types.js";

const log = createSubsystemLogger("provider-resolver");

let cachedProvider: ISandboxProvider | null = null;

export function hasKvmSupport(): boolean {
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function hasGVisorRuntime(): boolean {
  try {
    const result = execSync("docker info --format '{{json .Runtimes}}'", {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.includes("runsc");
  } catch {
    return false;
  }
}

export function hasDocker(): boolean {
  try {
    execSync("docker version --format '{{.Server.Version}}'", {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export function createProvider(
  backend: SandboxBackend,
  sandboxConfig: SandboxConfig,
): ISandboxProvider {
  switch (backend) {
    case "docker":
      return new DockerProvider({ sandboxConfig });
    case "gvisor":
      return new GVisorProvider({ sandboxConfig });
    case "firecracker":
      throw new Error(
        "Firecracker provider not yet implemented. " +
          "See ARCHITECTURE-MICROVM-SANDBOX.md for the planned implementation.",
      );
    default:
      throw new Error(`Unknown sandbox backend: ${backend as string}`);
  }
}

export async function autoDetectBackend(): Promise<SandboxBackend> {
  // Firecracker requires KVM - check first as it provides strongest isolation
  if (hasKvmSupport()) {
    log.info("KVM support detected - Firecracker backend available (not yet implemented)");
    // Fall through to gVisor/Docker until Firecracker is implemented
  }

  // gVisor provides user-space kernel isolation without KVM
  if (hasGVisorRuntime()) {
    log.info("gVisor (runsc) runtime detected");
    return "gvisor";
  }

  // Docker is the baseline
  if (hasDocker()) {
    log.info("Using Docker backend (standard container isolation)");
    return "docker";
  }

  throw new Error(
    "No sandbox provider available. Install Docker to enable sandboxing, " +
      "or set `agents.defaults.sandbox.mode=off` to disable it.",
  );
}

export async function resolveProvider(sandboxConfig: SandboxConfig): Promise<ISandboxProvider> {
  if (cachedProvider) {
    return cachedProvider;
  }

  const configuredBackend = (sandboxConfig as SandboxConfig & { backend?: SandboxBackend }).backend;
  let backend: SandboxBackend;

  if (configuredBackend && configuredBackend !== ("auto" as string)) {
    backend = configuredBackend;
    log.info(`Using configured sandbox backend: ${backend}`);
  } else {
    backend = await autoDetectBackend();
  }

  const provider = createProvider(backend, sandboxConfig);

  const available = await provider.isAvailable();
  if (!available) {
    throw new Error(
      `Sandbox backend "${backend}" is configured but not available on this system. ` +
        `Check installation or use backend: "auto" for automatic detection.`,
    );
  }

  cachedProvider = provider;
  return provider;
}

export function clearProviderCache(): void {
  cachedProvider = null;
}

export function getActiveProvider(): ISandboxProvider | null {
  return cachedProvider;
}
