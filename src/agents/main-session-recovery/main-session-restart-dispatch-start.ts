import type { AgentTurnStartOwner } from "../../gateway/agent-turn/internal-facade.types.js";
import type {
  GatewayInstanceAgentDispatchOptions,
  GatewayRecoveryRuntime,
} from "../../gateway/server-instance-runtime.types.js";
import type { AgentRunRequest } from "../../gateway/server-methods/agent-request-types.js";
import type { SessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  buildAgentRunTerminalOutcomeFromWaitResult,
  classifyAgentRunTerminalOutcome,
} from "../agent-run-terminal-outcome.js";

const RESTART_RECOVERY_START_OBSERVATION_MS = 10_000;

type RestartRecoveryDispatchResult = {
  runId: string;
} & NonNullable<Parameters<typeof buildAgentRunTerminalOutcomeFromWaitResult>[0]>;

type RestartRecoveryDispatchObservation = {
  dispatchAccepted: boolean;
  executionStarted: boolean;
  preStartAbortAttempted: boolean;
  preStartAbortConfirmed: boolean;
};

export type RestartRecoveryDispatchStartOutcome =
  | {
      kind: "started";
      observation: RestartRecoveryDispatchObservation;
    }
  | {
      kind: "terminal";
      observation: RestartRecoveryDispatchObservation;
      result: RestartRecoveryDispatchResult;
    }
  | {
      kind: "failed";
      error: unknown;
      observation: RestartRecoveryDispatchObservation;
    };

export async function dispatchRestartRecoveryUntilStarted(params: {
  agentParams: AgentRunRequest;
  controllerInput?: SessionControllerInput;
  gatewayRuntime: GatewayRecoveryRuntime;
  restartRecoveryOperatorTarget?: GatewayInstanceAgentDispatchOptions["restartRecoveryOperatorTarget"];
  assertAdmissionCurrent?: () => void;
  prepareDispatchCurrent?: () => Promise<void>;
  onSettled?: () => void;
}): Promise<RestartRecoveryDispatchStartOutcome> {
  let dispatchAccepted = false;
  let executionStarted = false;
  let executionStartTimedOut = false;
  let preStartAbortAttempted = false;
  let preStartAbortConfirmed = false;
  let startOwner: AgentTurnStartOwner | undefined;
  const requesterStartDeadlineAtMs = Date.now() + RESTART_RECOVERY_START_OBSERVATION_MS;
  const observe = (): RestartRecoveryDispatchObservation => ({
    dispatchAccepted,
    executionStarted,
    preStartAbortAttempted,
    preStartAbortConfirmed,
  });
  const executionStart = createDeferredCore();
  const executionStartAbort = new AbortController();
  const abortBeforeStart = () => {
    if (!startOwner || executionStarted || preStartAbortAttempted) {
      return;
    }
    preStartAbortAttempted = true;
    preStartAbortConfirmed = startOwner.abort();
  };
  const executionStartTimeout = createDeferredCore<RestartRecoveryDispatchStartOutcome>();
  let executionStartTimer: ReturnType<typeof setTimeout> | undefined;
  const clearExecutionStartTimer = () => {
    if (executionStartTimer) {
      clearTimeout(executionStartTimer);
      executionStartTimer = undefined;
    }
  };
  const onExecutionStarted = () => {
    if (executionStartTimedOut || startOwner?.observe()?.executionStarted !== true) {
      return;
    }
    executionStarted = true;
    clearExecutionStartTimer();
    executionStart.resolve();
  };
  const observeExecutionStart = () => {
    const ownerState = startOwner?.observe();
    if (ownerState?.executionStarted) {
      onExecutionStarted();
      return;
    }
    const deadlineAtMs =
      ownerState?.startDeadlineAtMs === null
        ? null
        : (ownerState?.startDeadlineAtMs ?? requesterStartDeadlineAtMs);
    if (ownerState && (deadlineAtMs === null || deadlineAtMs > Date.now())) {
      // The controller owns healthy waits; until it publishes a budget, our bound applies.
      scheduleObservation(
        deadlineAtMs === null
          ? RESTART_RECOVERY_START_OBSERVATION_MS
          : Math.min(RESTART_RECOVERY_START_OBSERVATION_MS, deadlineAtMs - Date.now()),
      );
      return;
    }
    executionStartTimedOut = true;
    const error = new Error("restart recovery execution start timeout");
    abortBeforeStart();
    executionStartAbort.abort(error);
    executionStartTimeout.resolve({ kind: "failed", error, observation: observe() });
  };
  const scheduleObservation = (delayMs: number) => {
    executionStartTimer = setTimeout(observeExecutionStart, delayMs);
    executionStartTimer.unref?.();
  };
  scheduleObservation(RESTART_RECOVERY_START_OBSERVATION_MS);
  let dispatchPromise: Promise<RestartRecoveryDispatchResult>;
  try {
    dispatchPromise = params.gatewayRuntime.dispatchAgent<RestartRecoveryDispatchResult>(
      params.agentParams,
      undefined,
      {
        controllerInput: params.controllerInput,
        expectFinal: true,
        restartRecoveryOperatorTarget: params.restartRecoveryOperatorTarget,
        assertAdmissionCurrent: params.assertAdmissionCurrent,
        prepareDispatchCurrent: params.prepareDispatchCurrent,
        onAccepted: () => {
          dispatchAccepted = true;
        },
        onStartOwner: (owner) => {
          // The first registration owns this dispatch even if its run id is later reused.
          startOwner ??= owner;
          if (executionStartTimedOut) {
            abortBeforeStart();
          }
        },
        onExecutionStarted,
        onSignalAbort: abortBeforeStart,
        signal: executionStartAbort.signal,
      },
    );
  } catch (error) {
    clearExecutionStartTimer();
    return { kind: "failed", error, observation: observe() };
  }
  const terminalDispatchOutcome = dispatchPromise.then<
    RestartRecoveryDispatchStartOutcome,
    RestartRecoveryDispatchStartOutcome
  >(
    (result) => {
      if (result.status === "in_flight") {
        // Cached acceptance retains the same captured owner and its start budget.
        dispatchAccepted = true;
        return executionStartTimeout.promise;
      }
      clearExecutionStartTimer();
      params.onSettled?.();
      return { kind: "terminal", observation: observe(), result };
    },
    (error: unknown) => {
      clearExecutionStartTimer();
      params.onSettled?.();
      return { kind: "failed", error, observation: observe() };
    },
  );
  return await Promise.race([
    terminalDispatchOutcome,
    executionStartTimeout.promise,
    executionStart.promise.then((): RestartRecoveryDispatchStartOutcome => ({
      kind: "started",
      observation: observe(),
    })),
  ]);
}

export type RestartRecoveryTerminalStatus = "error" | "ok" | "timeout" | "cancelled";

export function normalizeRestartRecoveryTerminalStatus(
  result: Parameters<typeof buildAgentRunTerminalOutcomeFromWaitResult>[0],
): RestartRecoveryTerminalStatus | undefined {
  const outcome = buildAgentRunTerminalOutcomeFromWaitResult(result);
  if (!outcome) {
    return undefined;
  }
  if (classifyAgentRunTerminalOutcome(outcome) === "cancellation") {
    return outcome.stopReason === "restart" ? undefined : "cancelled";
  }
  return outcome.status;
}

export async function probeRestartRecoveryTerminalStatus(
  runId: string,
  gatewayRuntime: GatewayRecoveryRuntime,
): Promise<RestartRecoveryTerminalStatus | undefined> {
  try {
    const result = await gatewayRuntime.waitForAgent<RestartRecoveryDispatchResult>(
      { runId, timeoutMs: 0 },
      2_000,
    );
    const status = normalizeRestartRecoveryTerminalStatus(result);
    // A zero-time wait also reports timeout for active or unknown work.
    return status === "timeout" && typeof result.endedAt !== "number" ? undefined : status;
  } catch {
    return undefined;
  }
}
