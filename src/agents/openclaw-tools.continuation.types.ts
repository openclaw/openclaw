// Leaf contract: run params and the tool options both carry it, so it imports neither (a cycle
// through embedded-agent-runner/run/params.ts otherwise).
import type { ContinueWorkRequest } from "./tools/continue-work-tool.js";
import type { RequestCompactionRunOpts } from "./tools/request-compaction-tool.js";

/** Continuation tool wiring a run supplies; see openclaw-tools.continuation.ts. */
export type ContinuationRunToolOptions = {
  /** Whether this run consumes the continue_delegate staging queue. */
  drainsContinuationDelegateQueue?: boolean;
  /** Runs whose lifecycle owner cannot execute any same-session continuation tools. */
  disableContinuationTools?: boolean;
  /** Callback for continue_work to request a post-turn continuation. */
  continueWorkOpts?: {
    requestContinuation: (request: ContinueWorkRequest) => void;
  };
  /** Closures for request_compaction when continuation is enabled. */
  requestCompactionOpts?: RequestCompactionRunOpts;
};
