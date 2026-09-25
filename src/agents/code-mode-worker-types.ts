import type { CodeModeJsonSource, CodeModeOutputSource } from "./code-mode-json.js";
import type { CodeModeApiVirtualFile } from "./code-mode-namespaces.js";

// Also bounds queued ordinary guest requests independently of configured in-flight slots.
export const MAX_CODE_MODE_PENDING_TOOL_CALLS = 128;
export const CODE_MODE_WORKER_WATCHDOG_GRACE_MS = 2_000;

type CodeModeBridgeMethod =
  | "search"
  | "describe"
  | "callValue"
  | "resultSave"
  | "resultLoad"
  | "resultDelete"
  | "nodes"
  | "yield"
  | "namespace"
  | "agentSpawn"
  | "agentWait"
  | "skillsList"
  | "skillsRead"
  | "sleep"
  | "swarmNote";

export type CodeModeConfig = {
  timeoutMs: number;
  memoryLimitBytes: number;
  maxOutputBytes: number;
  maxPendingToolCalls: number;
  maxSnapshotBytes: number;
};

export type PendingBridgeRequest = {
  id: string;
  method: CodeModeBridgeMethod;
  args: unknown[];
};

export type SettledBridgeRequest = { id: string; ok: boolean; json: string };

type SerializedCodeModeNamespaceValue =
  | { kind: "array"; items: SerializedCodeModeNamespaceValue[] }
  | { kind: "function"; path: string[] }
  | { kind: "object"; entries: Array<[string, SerializedCodeModeNamespaceValue]> }
  | { kind: "value"; value: unknown };

export type CodeModeNamespaceDescriptor = {
  id: string;
  globalName: string;
  description?: string;
  scope: SerializedCodeModeNamespaceValue;
};

type CodeModeWorkerInput<State> =
  | {
      kind: "exec";
      source: string;
      prelude?: string;
      executionTimeoutMs?: number;
      config: CodeModeConfig;
      catalog: unknown[];
      apiFiles?: CodeModeApiVirtualFile[];
      namespaces: CodeModeNamespaceDescriptor[];
      swarmEnabled?: boolean;
    }
  | {
      kind: "resume";
      continuation: State;
      config: CodeModeConfig;
      settledRequests: SettledBridgeRequest[];
      pendingRequests?: PendingBridgeRequest[];
    };

export type CodeModeWorkerPayload<State> = CodeModeWorkerInput<State> & {
  /** Only interactive, non-replay cells can hand full final JSON to the run store. */
  retainFinalValue?: boolean;
};

export type CodeModeSettlementMode =
  | { kind: "awaiting" }
  | { kind: "draining"; requiredRequestIds: string[] };

/** Transient worker boundary; no heap serialization and no resumable handle. */
export type CodeModeWorkerBoundary = {
  networkContentObserved?: true;
  status: "boundary";
  pendingRequests: PendingBridgeRequest[];
  canceledRequestIds: string[];
  settlementMode: CodeModeSettlementMode;
  output: CodeModeOutputSource;
  /** Engine-reported allocations for diagnostics, not RSS or admission authority. */
  memoryUsedBytes: number;
};

export type CodeModeWorkerContinuation =
  | { kind: "checkpoint" }
  | {
      kind: "continue";
      timeoutMs: number;
      settledRequests: SettledBridgeRequest[];
      pendingRequests: PendingBridgeRequest[];
    };

export type CodeModeFailurePhase = "input" | "guest" | "bridge" | "host";

type CodeModeWorkerOutcome<Output, Value, State> = { networkContentObserved?: true } & (
  | {
      status: "completed";
      value: Value;
      output: Output;
    }
  | {
      status: "waiting";
      continuation: State;
      pendingRequests: PendingBridgeRequest[];
      canceledRequestIds: string[];
      settlementMode: CodeModeSettlementMode;
      output: Output;
    }
  | {
      status: "failed";
      error: string;
      code:
        | "invalid_input"
        | "runtime_unavailable"
        | "timeout"
        | "snapshot_limit_exceeded"
        | "internal_error";
      failurePhase: Extract<CodeModeFailurePhase, "input" | "guest">;
      bridgeDispatchStarted: false;
      output: Output;
    }
);

export type CodeModeVmResult<State> = CodeModeWorkerOutcome<unknown[], unknown, State>;
export type CodeModeWorkerThreadResult<State> = CodeModeWorkerOutcome<
  CodeModeOutputSource,
  CodeModeJsonSource,
  State
>;
