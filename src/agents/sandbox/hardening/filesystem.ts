/**
 * Bidirectional file transfer between host and sandbox container via docker cp.
 */

import { execDocker } from "../docker.js";

/**
 * Copy a file or directory from the host into the sandbox container.
 * Throws if docker cp fails.
 */
export async function syncToSandbox(
  containerName: string,
  hostPath: string,
  containerPath: string,
): Promise<void> {
  await execDocker(["cp", hostPath, `${containerName}:${containerPath}`]);
}

/**
 * Copy a file or directory from the sandbox container to the host.
 * Throws if docker cp fails.
 */
export async function syncFromSandbox(
  containerName: string,
  containerPath: string,
  hostPath: string,
): Promise<void> {
  await execDocker(["cp", `${containerName}:${containerPath}`, hostPath]);
}
