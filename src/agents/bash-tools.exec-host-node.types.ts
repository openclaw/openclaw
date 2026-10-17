import type { SystemRunExecutionContext } from "../../packages/gateway-protocol/src/system-run-execution-context.js";
import type { ExecHostCommandParams } from "./bash-tools.exec-types.js";

export type ExecuteNodeHostCommandParams = ExecHostCommandParams & {
  workdir: string | undefined;
  executionContext?: SystemRunExecutionContext;
  requestedNode?: string;
  boundNode?: string;
  /** Owning embedded run; required to register human_input_wait while parked. */
  runId?: string;
  /** Warnings that apply only when the command runs inline, never while approval is pending. */
  foregroundWarnings?: string[];
  notifyOnExit?: boolean;
};
