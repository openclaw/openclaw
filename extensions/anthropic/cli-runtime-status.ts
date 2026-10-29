import type {
  CliBackendExecuteContext,
  CliBackendTurnStatus,
} from "openclaw/plugin-sdk/cli-backend";

// Structural views keep this adapter a leaf of cli.runtime.ts.
type StatusContext = Pick<CliBackendExecuteContext, "abortSignal" | "assertCurrent">;
type StatusTurn = {
  promptInputUuid: string;
  submittedInputUuids: ReadonlySet<string>;
  inputStarted: boolean;
  interrupted: boolean;
  error?: Error;
};
type StatusSession = {
  handle: { generation: string };
  currentTurn?: object;
  closed: boolean;
  hasInputLifecycle: boolean;
};

/** Local facts only: this adapter never writes to the native transport. */
export function createClaudeTurnStatus(
  context: StatusContext,
  session: StatusSession,
  turn: StatusTurn,
): CliBackendTurnStatus {
  return {
    capture() {
      const generation = session.handle.generation;
      const inputUuid = turn.promptInputUuid;
      const submittedInputs = turn.submittedInputUuids.size;
      const inputStarted = turn.inputStarted;
      const isCurrent = () => {
        context.assertCurrent?.();
        return (
          !context.abortSignal?.aborted &&
          !turn.interrupted &&
          session.handle.generation === generation &&
          turn.promptInputUuid === inputUuid &&
          turn.submittedInputUuids.size === submittedInputs &&
          turn.inputStarted === inputStarted &&
          (session.currentTurn === turn || (session.closed && turn.error !== undefined))
        );
      };
      if (!isCurrent()) {
        return undefined;
      }
      return {
        isCurrent,
        async assess({ signal }) {
          signal.throwIfAborted();
          if (!isCurrent()) {
            return { state: "unknown", basis: "status_unsupported" };
          }
          // closeSession also records host cancellation and startup failures, not just fatal errors.
          if (session.closed) {
            return { state: "closed", basis: "transport_closed" };
          }
          // This adapter issues no fresh status request; process presence is not model progress.
          return {
            state: "unknown",
            basis:
              session.hasInputLifecycle && !inputStarted ? "status_unsupported" : "process_present",
          };
        },
      };
    },
  };
}
