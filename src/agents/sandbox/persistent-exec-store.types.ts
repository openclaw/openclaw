import type { CronSandboxStreamSource } from "../../cron/store/stream-source-admission.js";
import type { NamespacedStateLeaseProcessOwner } from "../../infra/state-lease-process-owner.js";
import type {
  DockerPersistentExecCleanupTarget,
  DockerPersistentExecReceipt,
  DockerPersistentExecTarget,
} from "./persistent-exec.types.js";

export type SandboxPersistentExecPhase =
  | "reserved"
  | "prepared"
  | "running"
  | "stopping"
  | "uncertain"
  | "stopped";

export type SandboxPersistentExecReservation = {
  /** Stable across source replacement; unresolved custody prevents a second launch. */
  ownerKey: string;
  sourceIdentity: string;
  attemptId: string;
  backendId: "docker";
  containerId: string;
  containerName: string;
  containerStartedAt: string;
  backendTarget: DockerPersistentExecTarget;
};

export type SandboxPersistentExecWorkspaceBinding = {
  workspaceDir: string;
  workspaceSource: "managed-worktree" | null;
  registryCreatedAtMs: number;
};

export type SandboxPersistentExecRecord = SandboxPersistentExecReservation & {
  workspaceBinding: SandboxPersistentExecWorkspaceBinding;
  owner: NamespacedStateLeaseProcessOwner & { token: string };
  revision: number;
  phase: SandboxPersistentExecPhase;
  receipt: DockerPersistentExecReceipt | null;
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type SandboxPersistentExecExpected = {
  ownerKey: string;
  attemptId: string;
  expectedRevision: number;
};

export type SandboxPersistentExecTransition = SandboxPersistentExecExpected & {
  phase: SandboxPersistentExecPhase;
  receipt?: DockerPersistentExecReceipt;
  error?: string | null;
};

export type SandboxPersistentExecQuery = {
  ownerKey?: string;
  sourceIdentity?: string;
  containerId?: string;
  containerName?: string;
};

export type SandboxPersistentExecMutationResult =
  | { ok: true; current: SandboxPersistentExecRecord | null }
  | { ok: false; current: SandboxPersistentExecRecord | null };

export type SandboxPersistentExecWrite =
  | {
      operation: "reserve";
      ownerToken: string;
      input: SandboxPersistentExecReservation;
      expectedSource?: CronSandboxStreamSource;
    }
  | {
      operation: "transition";
      ownerToken: string;
      input: SandboxPersistentExecTransition;
      expectedSource?: CronSandboxStreamSource;
    }
  | {
      operation: "checkExecutionCurrent";
      ownerToken: string;
      input: SandboxPersistentExecExpected;
      expectedSource: CronSandboxStreamSource;
    }
  | { operation: "claimRecovery"; ownerToken: string; input: SandboxPersistentExecExpected }
  | {
      operation: "confirmContainerExtinction";
      ownerToken: string;
      input: SandboxPersistentExecExpected;
      extinction: DockerPersistentExecCleanupTarget;
    }
  | {
      operation: "removeConfirmed";
      ownerToken: string;
      input: SandboxPersistentExecExpected;
      requireWorkspaceBinding?: boolean;
    };
