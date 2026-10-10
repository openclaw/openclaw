import type { CodeModeOutputSource } from "./code-mode-json.js";
import type {
  CodeModeFailurePhase,
  CodeModeWorkerBoundary,
  CodeModeWorkerContinuation,
  CodeModeWorkerPayload,
  CodeModeWorkerThreadResult,
} from "./code-mode-worker-types.js";

export type CodeModeExecutorId = "node" | "quickjs";

export type CodeModeFailureCode =
  | "aborted"
  | "invalid_input"
  | "runtime_unavailable"
  | "timeout"
  | "output_limit_exceeded"
  | "snapshot_limit_exceeded"
  | "internal_error";

export type CodeModeExecutorStartInput = Extract<CodeModeWorkerPayload<never>, { kind: "exec" }>;
export type CodeModeExecutorResumeInput = Omit<
  Extract<CodeModeWorkerPayload<never>, { kind: "resume" }>,
  "continuation"
>;

export type CodeModeExecutorInlineHost = {
  onNetworkContent?: () => void;
  onInputConsumed?: () => void;
  onBoundary: (
    boundary: CodeModeWorkerBoundary,
    context: { signal: AbortSignal; yieldSignal: AbortSignal; maxTimeoutMs: number },
  ) => Promise<CodeModeWorkerContinuation & { onConsumed?: () => void }>;
};

export type CodeModeExecutorRunOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  inlineHost?: CodeModeExecutorInlineHost;
};

/** One-shot custody of a parked execution; resuming transfers its resources to the next result. */
export type CodeModeExecutorContinuation = {
  readonly executor: CodeModeExecutorId;
  readonly retainedBytes: number;
  resume: (
    input: CodeModeExecutorResumeInput,
    options: CodeModeExecutorRunOptions,
  ) => Promise<CodeModeWorkerResult>;
  /** Revokes resume and joins cleanup; failed cleanup is retryable, consumed continuations are inert. */
  dispose: () => Promise<void>;
};

export type CodeModeWorkerResult =
  | Extract<
      CodeModeWorkerThreadResult<CodeModeExecutorContinuation>,
      { status: "completed" | "waiting" }
    >
  | {
      status: "failed";
      error: string;
      code: CodeModeFailureCode;
      failurePhase: CodeModeFailurePhase;
      bridgeDispatchStarted: boolean;
      networkContentObserved?: true;
      output: CodeModeOutputSource;
    };

export type CodeModeExecutor = {
  readonly id: CodeModeExecutorId;
  execute: (
    input: CodeModeExecutorStartInput,
    options: CodeModeExecutorRunOptions,
  ) => Promise<CodeModeWorkerResult>;
};
