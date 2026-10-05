import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import type { TurnRecoveryIntent } from "../../config/sessions/main-session-recovery.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { MainSessionRecoveryAdmission } from "./main-session-recovery-admission.js";
import type { MainSessionRecoveryObservation } from "./main-session-recovery-state.js";
import type { dispatchRestartRecoveryWithinCapacity } from "./main-session-restart-dispatch-capacity.js";

export type MainSessionRecoveryAuthorityHold = {
  kind: "authority-hold";
  reason: "missing-intent" | "missing-restorer" | "source-mismatch" | "missing-goal-marker";
  observation: MainSessionRecoveryObservation;
  /** Private in-process source facts; diagnostics export only the fixed reason. */
  source: Pick<
    SessionEntry,
    | "mainRestartRecovery"
    | "restartRecoveryGoal"
    | "restartRecoveryDeliverySourceRunId"
    | "restartRecoveryDeliveryRunId"
    | "lifecycleRunId"
  >;
};

export type MainSessionRecoveryCurrentInput = {
  kind: "current-input";
  intent: TurnRecoveryIntent;
  /** The original foreground receipt stays live; this is not restored execution authority. */
  assertCurrent: () => void;
};

export type MainSessionResumeResult =
  | "started"
  | "settled"
  | "skipped"
  | "failed"
  | MainSessionRecoveryAuthorityHold
  | MainSessionRecoveryCurrentInput;

export type MainSessionRecoveryCounts = {
  started: number;
  settled: number;
  failed: number;
  skipped: number;
  /** Exact guarded predecessor, never a generic skipped/capacity outcome. */
  authorityHold?: MainSessionRecoveryAuthorityHold;
  currentInput?: MainSessionRecoveryCurrentInput;
};

export type ResumeMainSessionParams = {
  agentId: string;
  canonicalSessionKey?: string;
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  observation: MainSessionRecoveryObservation;
  recoveryAttempt: number;
  storePath: string;
  sessionKey: string;
  pendingFinalDeliveryText?: string | null;
  forceRestartSafeTools?: boolean;
  forceCodeModeTools?: boolean;
  recoveryAdmission?: MainSessionRecoveryAdmission;
  lifecycleGeneration?: string;
  shouldContinue?: () => boolean;
  shouldContinueDelivery?: () => boolean;
  gatewayRuntime: GatewayRecoveryRuntime;
  recoveryCapacity?: Parameters<typeof dispatchRestartRecoveryWithinCapacity>[0]["capacity"];
};
