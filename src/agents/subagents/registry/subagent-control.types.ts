import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SessionControllerInput } from "../../../sessions/session-controller.contracts.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";

export type KillScope = {
  cancellationControl: SubagentCancellationControl;
  refresh: () => Promise<number>;
  sealRootSelection: () => void;
  stateContext: OpenClawStateWorkerContext;
};

export type KillPublicationPreparation<T> = {
  prepare: (
    publish: (prepareRows?: (publishResult: () => void) => Promise<void>) => Promise<void>,
  ) => Promise<void>;
  publishSnapshot?: (result: T) => void;
};

/** Exact source/target references retained across a kill's admission cleanup. */
export type SubagentKillInputSnapshot = {
  input: SessionControllerInput;
  source: SessionControllerInput["source"];
  target: SessionControllerInput["target"];
  mailbox: SessionControllerInput["mailbox"];
};

export type ResolvedSubagentController = {
  controllerSessionKey: string;
  controllerAgentId?: string;
  callerSessionKey: string;
  callerIsSubagent: boolean;
  controlScope: "children" | "none";
};

export type SubagentCancellationControl = {
  assertCurrent: () => void;
  prepareRead?: () => Promise<void> | undefined;
};

export const SUBAGENT_KILL_TASK_ERROR = "Subagent run killed.";
type SubagentTerminalState = {
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  endedAt: number;
  error?: string;
};
export type SubagentKillTargetState =
  | { state: "finalizing" }
  | { state: "terminal"; task: SubagentTerminalState };

export type SubagentAdminKillResult =
  | { found: false; killed: false }
  | {
      found: true;
      killed: boolean;
      runId: string;
      sessionKey: string;
      cascadeKilled: number;
      cascadeLabels?: string[];
      targetState?: SubagentKillTargetState;
      error?: string;
    };
export type SubagentAdminKillParams = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  expectedRunId?: string;
  expectedTaskRunId?: string;
  expectedGeneration?: number;
  expectedOwnerKey?: string;
  onResult?: (result: SubagentAdminKillResult) => undefined;
};

/** Outcome of one exact-run kill mutation, including cleanup and supersession results. */
export type SubagentRunKillResult = {
  killed: boolean;
  continuationRetired?: true;
  cleanupPending?: true;
  /** No controller turn or input was present; only registry state settled. */
  reason?: "no_controller_record";
  superseded?: boolean;
  declined?: true;
  targetState?: SubagentKillTargetState;
  error?: string;
  completedCleanupError?: string;
};
