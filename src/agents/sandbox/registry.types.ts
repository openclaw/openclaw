import type { SandboxContainerEngineTarget } from "./container-engine.js";

export type SandboxRegistryEntry = {
  containerName: string;
  backendId?: string;
  backendTarget?: SandboxContainerEngineTarget;
  runtimeLabel?: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
  configLabelKind?: string;
  configHash?: string;
  /** Original provider workspace, retained so pending cleanup can replay the same request. */
  workspaceDir?: string;
  /** Provisioning and removal state for backends that retain unfinished allocations. */
  runtimeState?: "pending" | "ready" | "removing" | "removing-pending";
};

export type SandboxRegistry = {
  entries: SandboxRegistryEntry[];
};

export type SandboxBrowserRegistryEntry = {
  /** Exact workspace mount retained before browser allocation for local reconciliation. */
  workspaceDir?: string;
  containerName: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
  configHash?: string;
  cdpPort: number;
  noVncPort?: number;
};

export type SandboxBrowserRegistry = {
  entries: SandboxBrowserRegistryEntry[];
};
