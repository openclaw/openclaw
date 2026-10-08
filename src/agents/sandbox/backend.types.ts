import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import type { SandboxRegistryEntry } from "./registry.js";
import type { SandboxConfig } from "./types.js";

export type SandboxBackendRuntimeInfo = {
  running: boolean;
  actualConfigLabel?: string;
  configLabelMatch: boolean;
};

export type SandboxBackendManager = {
  describeRuntime(params: {
    entry: SandboxRegistryEntry;
    config: OpenClawConfig;
    agentId?: string;
  }): Promise<SandboxBackendRuntimeInfo>;
  removeRuntime(params: {
    entry: SandboxRegistryEntry;
    config: OpenClawConfig;
    agentId?: string;
  }): Promise<void>;
};

export type CreateSandboxBackendParams = {
  /** Resolved canonical agent ID. Optional for older SDK callers; never infer from scopeKey. */
  agentId?: string;
  sessionKey: string;
  scopeKey: string;
  /** Runtime IDs already registered for this backend and scope, newest first. */
  registeredRuntimeIds?: readonly string[];
  /** Durable runtime generation selected by core for a reserving backend. */
  runtimeId?: string;
  /** Synchronously recheck this generation immediately before runtime side effects. */
  assertRuntimeCurrent?: () => void;
  workspaceDir: string;
  /** Prepared managed projection; retain its exact mount owner before allocation. */
  workspaceSource?: "managed-worktree";
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  readOnlyResourceMounts?: Array<{ hostPath: string; containerPath: string }>;
  cfg: SandboxConfig;
  requireCurrentConfig?: boolean;
};

export type SandboxBackendFactory = (
  params: CreateSandboxBackendParams,
) => Promise<SandboxBackendHandle>;

/** Version 1 of the reserved-runtime capability, with required live owner authority. */
export type CreateReservedSandboxBackendParamsV1 = CreateSandboxBackendParams & {
  runtimeId: string;
  assertRuntimeCurrent: () => void;
};

export type ReservedSandboxBackendFactoryV1 = (
  params: CreateReservedSandboxBackendParamsV1,
) => Promise<SandboxBackendHandle>;

/** Resolve the runtime workdir without creating or starting the backend. */
export type SandboxBackendWorkdirResolver = (params: CreateSandboxBackendParams) => string;

export type SandboxBackendRegistration = SandboxBackendFactory | RegisteredSandboxBackend;

export type RegisteredSandboxBackend = {
  manager?: SandboxBackendManager;
  resolveWorkdir?: SandboxBackendWorkdirResolver;
  /** Static backend features available before a runtime is provisioned. */
  capabilities?: {
    /** Can project host-owned directories read-only into the execution environment. */
    readOnlyResourceMounts?: boolean;
  };
} & (
  | { factory: SandboxBackendFactory; reserveRuntimeId?: undefined }
  | {
      factory: ReservedSandboxBackendFactoryV1;
      /** Generate a fresh candidate ID without allocating provider resources. */
      reserveRuntimeId: (params: CreateSandboxBackendParams) => string;
    }
);

export type { SandboxBackendHandle, SandboxBackendId } from "./backend-handle.types.js";
export type { SandboxBackendWorkdirValidation } from "./backend-handle.types.js";
