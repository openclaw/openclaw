import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SandboxBackendHandle } from "./backend-handle.types.js";

export type DockerPersistentExecExtinctionProof = Readonly<{ kind: "docker-container-extinction" }>;

/** Transport references identify the original daemon; they carry no execution authority. */
export type DockerPersistentExecTarget = {
  kind: "docker";
  endpoint: string;
  daemonId: string;
};

/** The parent binding identifies the workspace owner; cleanup targets only its private child. */
export type DockerPersistentExecCleanupTarget = {
  target: DockerPersistentExecTarget;
  attemptId: string;
  parentContainerId: string;
  containerId?: string;
};

/** Durable cleanup identity carries no authority to start a container. */
export type DockerPersistentExecReceipt = DockerPersistentExecCleanupTarget & {
  version: 1;
  containerId: string;
};

export function dockerPersistentExecContainerName(attemptId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(attemptId)) {
    throw new Error("Invalid sandbox stream attempt identity; custody retained.");
  }
  return `openclaw-stream-${attemptId}`;
}

export function parseDockerPersistentExecTarget(value: unknown): DockerPersistentExecTarget {
  if (
    !isRecord(value) ||
    value.kind !== "docker" ||
    typeof value.endpoint !== "string" ||
    !value.endpoint.startsWith("unix:///") ||
    value.endpoint.length > 4_096 ||
    value.endpoint.includes("\0") ||
    typeof value.daemonId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/u.test(value.daemonId)
  ) {
    throw new Error("Invalid persistent sandbox Docker target; custody must be retained.");
  }
  return { kind: "docker", endpoint: value.endpoint, daemonId: value.daemonId };
}

export function parseDockerPersistentExecReceipt(value: unknown): DockerPersistentExecReceipt {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.containerId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.containerId) ||
    typeof value.parentContainerId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.parentContainerId) ||
    value.containerId === value.parentContainerId ||
    typeof value.attemptId !== "string"
  ) {
    throw new Error("Invalid persistent sandbox stop receipt; custody must be retained.");
  }
  dockerPersistentExecContainerName(value.attemptId);
  return {
    version: 1,
    target: parseDockerPersistentExecTarget(value.target),
    containerId: value.containerId,
    parentContainerId: value.parentContainerId,
    attemptId: value.attemptId,
  };
}

export type SandboxPersistentExecStopped = {
  reason: string;
  exitCode: number | null;
  extinction: DockerPersistentExecExtinctionProof;
};

export type SandboxPersistentExecCommand = {
  argv: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type SandboxPersistentExecPreparation = {
  receipt: DockerPersistentExecReceipt;
  /** START is available only to this admitted owner after durable receipt publication. */
  start(admit: () => Promise<void>): Promise<void>;
  /** Revalidate the original parent generation while this controller is alive. */
  checkCurrent(): Promise<void>;
  stopped: Promise<SandboxPersistentExecStopped>;
  /** Removes the exact private container and joins pending output consumption. */
  stop(): Promise<SandboxPersistentExecStopped>;
};

export type SandboxPersistentExecCapability = {
  target: DockerPersistentExecTarget;
  containerId: string;
  containerName: string;
  containerStartedAt: string;
  workdir: string;
  configHash: string;
  imageReference: string;
  resolveImage: () => Promise<string>;
  prepare(params: {
    attemptId: string;
    custodyScope: string;
    command: SandboxPersistentExecCommand;
    assertCurrent: () => void;
    signal: AbortSignal;
    onOutput: (stream: "stdout" | "stderr", chunk: Buffer) => void | Promise<void>;
  }): Promise<SandboxPersistentExecPreparation>;
};

// Keep provider-specific persistent execution outside the public backend SDK.
const capabilities = new WeakMap<SandboxBackendHandle, SandboxPersistentExecCapability>();

export function bindSandboxPersistentExecCapability(
  backend: SandboxBackendHandle,
  capability: SandboxPersistentExecCapability,
): void {
  capabilities.set(backend, capability);
}

export function getSandboxPersistentExecCapability(
  backend: SandboxBackendHandle,
): SandboxPersistentExecCapability | undefined {
  return capabilities.get(backend);
}
