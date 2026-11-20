import type { CodeModeVmResult } from "openclaw/plugin-sdk/code-mode-executor-runtime";

type CodeModeFailure = Extract<CodeModeVmResult<unknown>, { status: "failed" }>;

export class CodeModeWorkerFailure extends Error {
  constructor(
    readonly code: CodeModeFailure["code"],
    message: string,
    readonly failurePhase: CodeModeFailure["failurePhase"],
  ) {
    super(message);
    this.name = "CodeModeWorkerFailure";
  }
}
