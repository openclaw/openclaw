import type { MainRestartRecoveryState, RestartRecoveryRun } from "../../config/sessions.js";
import type {
  NoReplayRecoveryDecision,
  TurnRecoveryIntent,
} from "../../config/sessions/main-session-recovery.types.js";

type MainSessionRecoveryExecutionIdentity = NonNullable<
  MainRestartRecoveryState["executionIdentity"]
>;

export type MainSessionRecoveryObservation = {
  sessionId: string;
  cycleId: string;
  revision: number;
};

export type MainSessionRecoveryReservation = {
  sessionId: string;
  cycleId: string;
  lifecycleGeneration: string;
  runId: string;
  attempt: number;
};

export type MainSessionRecoveryOwnerClaim = {
  cycleId: string;
  lifecycleGeneration: string;
  claimId: string;
  sessionId: string;
  sessionKey: string;
  runId?: string;
};

export type MainSessionRecoveryView =
  | { status: "inactive" }
  | { status: "blocked" }
  | {
      status: "recoverable";
      observation: MainSessionRecoveryObservation;
      nextAttempt: number;
    }
  | {
      status: "exhausted";
      observation: MainSessionRecoveryObservation;
      reason: string;
    }
  | { status: "tombstoned" };

export type MainSessionRecoveryConflict =
  | "already_tombstoned"
  | "foreground_active"
  | "not_interrupted"
  | "session_paused"
  | "recovery_exhausted"
  | "reservation_active"
  | "session_replaced"
  | "stale_cycle"
  | "stale_generation"
  | "stale_reservation"
  | "stale_revision";

type RecoveryRunOwner = {
  lifecycleGeneration: string;
  runId: string;
  sessionId: string;
};

type RecoveryDeliveryClaim = { deliveryClaim?: { runId: string; sourceRunId?: string } };

type AdmittedRecoveryAttempt = RecoveryRunOwner & {
  cycleId: string;
  attempt: number;
};

type WorkerCapacityDecision = RecoveryRunOwner & {
  cycleId: string;
  lifecycleRevision?: string;
  now: number;
  worker: NonNullable<NonNullable<MainRestartRecoveryState["capacityWait"]>["worker"]>;
};
type ProviderCapacityDecision = Omit<WorkerCapacityDecision, "worker"> & {
  provider: NonNullable<NonNullable<MainRestartRecoveryState["capacityWait"]>["provider"]>;
};

export type MainSessionRecoveryCommand =
  | ({ kind: "wait_provider_capacity" } & ProviderCapacityDecision)
  | ({ kind: "finish_provider_capacity" } & ProviderCapacityDecision)
  | ({ kind: "validate_provider_recovery" } & ProviderCapacityDecision)
  | ({ kind: "wait_worker_capacity" } & WorkerCapacityDecision)
  | ({ kind: "finish_worker_capacity" } & WorkerCapacityDecision)
  | ({ kind: "validate_worker_recovery" } & WorkerCapacityDecision)
  | {
      kind: "wait_capacity";
      observation: MainSessionRecoveryObservation;
      lifecycleGeneration: string;
      runId: string;
      now: number;
    }
  | {
      kind: "cancel_capacity_wait";
      wait: Omit<MainSessionRecoveryReservation, "attempt" | "executionIdentityAdmission"> & {
        worker?: NonNullable<MainRestartRecoveryState["capacityWait"]>["worker"];
        provider?: NonNullable<MainRestartRecoveryState["capacityWait"]>["provider"];
      };
    }
  | {
      kind: "mark_interrupted";
      cycleId: string;
      now: number;
      runs?: RestartRecoveryRun[];
    }
  | {
      kind: "observe";
      cycleId: string;
      lifecycleGeneration: string;
      sessionKey: string;
    }
  | {
      kind: "inspect";
      lifecycleGeneration: string;
      sessionKey: string;
    }
  | {
      kind: "prepare_attempt";
      attempt: number;
      lifecycleGeneration: string;
      now: number;
      observation: MainSessionRecoveryObservation;
      runId: string;
      executionIdentity: { state: "disabled" } | { state: "enabled" };
    }
  | ({
      kind: "bind_admitted_execution_identity";
      token: MainSessionRecoveryExecutionIdentity;
    } & AdmittedRecoveryAttempt)
  | ({ kind: "register_recovery_turn" } & AdmittedRecoveryAttempt)
  | {
      kind: "cancel_reservation" | "abandon_reservation";
      reservation: MainSessionRecoveryReservation;
    }
  | ({ kind: "validate_recovery" } & RecoveryRunOwner & RecoveryDeliveryClaim)
  | ({
      kind: "admit_recovery";
      now: number;
    } & RecoveryRunOwner &
      RecoveryDeliveryClaim)
  | ({
      kind: "mark_admitted_recovery_interrupted";
      now: number;
    } & AdmittedRecoveryAttempt)
  | ({ kind: "claim_foreground"; inputIntent?: TurnRecoveryIntent } & MainSessionRecoveryOwnerClaim)
  | { kind: "bind_foreground_run"; claim: MainSessionRecoveryOwnerClaim; runId: string }
  | { kind: "validate_foreground"; claim: MainSessionRecoveryOwnerClaim }
  | { kind: "release_foreground"; claim: MainSessionRecoveryOwnerClaim }
  | {
      kind: "pause";
      now: number;
      observation: MainSessionRecoveryObservation;
      effect: Omit<NonNullable<MainRestartRecoveryState["pause"]>, "pausedAtMs">;
    }
  | {
      kind: "acknowledge_pause";
      now: number;
      observation: MainSessionRecoveryObservation;
      noReplay?: NoReplayRecoveryDecision;
    }
  | {
      kind: "tombstone";
      now: number;
      observation: MainSessionRecoveryObservation;
      reason: string;
    }
  | { kind: "doctor_repair"; now: number }
  | { kind: "clear" };

export type MainSessionRecoveryTransitionResult =
  | {
      kind:
        | "applied"
        | "doctor_repaired"
        | "foreground_validated"
        | "goal_limited"
        | "no_change"
        | "recovery_validated"
        | "tombstoned";
    }
  | { kind: "admitted_recovery"; admission: AdmittedRecoveryAttempt }
  | { kind: "foreground_claimed"; claim: MainSessionRecoveryOwnerClaim }
  | { kind: "observed"; view: MainSessionRecoveryView }
  | { kind: "rejected"; reason: MainSessionRecoveryConflict }
  | { kind: "reserved"; reservation: MainSessionRecoveryReservation };
