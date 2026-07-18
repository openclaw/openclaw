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
