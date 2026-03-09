/**
 * Three-phase health check composition for the Firecracker provider.
 *
 * Probes run in order from cheapest to most expensive:
 *   1. /dev/kvm access (filesystem check)
 *   2. vm-runner socket existence (filesystem check)
 *   3. gRPC health check RPC (network call)
 *
 * Fails fast at the first unavailable layer.
 */

import { access, constants } from "node:fs/promises";
import type { ProviderHealthResult } from "../provider.js";
import { VM_RUNNER_SOCKET } from "./channel.js";

export interface HealthClient {
  check(request: Record<string, unknown>): Promise<unknown>;
}

/**
 * Check if the Firecracker vm-runner is healthy and available.
 *
 * @param healthClient - gRPC health check client with a check() method
 * @returns ProviderHealthResult indicating availability
 */
export async function checkFirecrackerHealth(
  healthClient: HealthClient,
): Promise<ProviderHealthResult> {
  // Phase 1: Check /dev/kvm availability
  try {
    await access("/dev/kvm", constants.R_OK | constants.W_OK);
  } catch {
    return {
      available: false,
      message: "/dev/kvm not available - KVM virtualization not supported on this host",
    };
  }

  // Phase 2: Check vm-runner socket existence
  try {
    await access(VM_RUNNER_SOCKET, constants.R_OK | constants.W_OK);
  } catch {
    return {
      available: false,
      message: `vm-runner socket not found at ${VM_RUNNER_SOCKET}`,
    };
  }

  // Phase 3: gRPC health check
  try {
    await healthClient.check({});
  } catch {
    return {
      available: false,
      message: "vm-runner health check failed - service may not be running",
    };
  }

  return {
    available: true,
    message: "Firecracker vm-runner is healthy",
  };
}
