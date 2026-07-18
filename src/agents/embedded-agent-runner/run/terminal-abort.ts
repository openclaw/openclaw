import type { CriticalToolLoopSignal } from "../../agent-tools.before-tool-call.js";

export class CriticalToolLoopError extends Error {
  readonly detector: CriticalToolLoopSignal["detector"];
  readonly count: number;
  readonly toolName: string;

  constructor(signal: CriticalToolLoopSignal) {
    super(signal.message);
    this.name = "CriticalToolLoopError";
    this.detector = signal.detector;
    this.count = signal.count;
    this.toolName = signal.toolName;
  }
}

export type CriticalToolLoopTerminalAbort = {
  kind: "critical_tool_loop";
  error: CriticalToolLoopError;
};

export type EmbeddedRunTerminalAbort =
  | { kind: "post_compaction_loop"; error: Error }
  | CriticalToolLoopTerminalAbort;

export function createEmbeddedRunTerminalAbortOwner(input: {
  parentAbortSignal?: AbortSignal;
  laneTaskAbortController: AbortController;
}) {
  let attemptAbortController: AbortController | undefined;
  let terminalAbort: EmbeddedRunTerminalAbort | undefined;

  // Terminal detectors can race with sibling tool completions. The first
  // detector owns teardown so later outcomes cannot clear or replace it.
  const requestTerminalAbort = (candidate: EmbeddedRunTerminalAbort): void => {
    // Parent and attempt-owned cancellation keep their canonical terminal
    // paths; a detector that observes either abort late must not replace it.
    if (
      input.parentAbortSignal?.aborted ||
      input.laneTaskAbortController.signal.aborted ||
      terminalAbort
    ) {
      return;
    }
    terminalAbort = candidate;
    input.laneTaskAbortController.abort(candidate.error);
    attemptAbortController?.abort(candidate.error);
  };

  return {
    onCriticalToolLoop: (signal: CriticalToolLoopSignal): void => {
      requestTerminalAbort({
        kind: "critical_tool_loop",
        error: new CriticalToolLoopError(signal),
      });
    },
    requestPostCompactionAbort: (error: Error): void => {
      requestTerminalAbort({ kind: "post_compaction_loop", error });
    },
    getTerminalAbort: (): EmbeddedRunTerminalAbort | undefined => terminalAbort,
    setTerminalAbortController: (controller: AbortController | undefined): void => {
      attemptAbortController = controller;
    },
    clearTerminalAbortController: (controller: AbortController): void => {
      if (attemptAbortController === controller) {
        attemptAbortController = undefined;
      }
    },
  };
}
