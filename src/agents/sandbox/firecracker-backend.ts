/**
 * Firecracker/Kata sandbox backend.
 *
 * Reuses the Docker/Podman worker volume, secret, and network story behind an
 * explicit OCI runtime. Selected only via `openclaw init --mode teammate --backend firecracker`.
 */
import { DEFAULT_FIRECRACKER_OCI_RUNTIME } from "../../teammate/profile.js";
import {
  createDockerSandboxBackend,
  dockerSandboxBackendManager,
} from "./docker-backend.js";
import type {
  CreateSandboxBackendParams,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "./backend.types.js";

export function createFirecrackerSandboxBackend(
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  return createDockerSandboxBackend({
    ...params,
    cfg: {
      ...params.cfg,
      docker: {
        ...params.cfg.docker,
        runtime: params.cfg.docker.runtime?.trim() || DEFAULT_FIRECRACKER_OCI_RUNTIME,
      },
    },
  });
}

export const firecrackerSandboxBackendManager: SandboxBackendManager = dockerSandboxBackendManager;
