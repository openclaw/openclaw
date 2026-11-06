export type CodexControlRequestPhase =
  | "load-control"
  | "prepare"
  | "acquire-client"
  | "client-request"
  | "release-client";

export type CodexControlRequestFailureCategory =
  | "deadline-observed"
  | "scoped-rejection"
  | "rpc-method-unavailable"
  | "rpc-error"
  | "other";

export type CodexControlRequestFailure = {
  phase: CodexControlRequestPhase;
  category: CodexControlRequestFailureCategory;
};

export const CODEX_REQUEST_WAITER_OUTCOMES = [
  "resolved",
  "native-error",
  "timed-out",
  "aborted",
  "authority-rejected",
  "local-failed",
  "client-closed",
] as const;
export type CodexRequestWaiterOutcome = (typeof CODEX_REQUEST_WAITER_OUTCOMES)[number];

export const CODEX_REQUEST_WIRE_OUTCOMES = [
  "retained-pending",
  "native-ok",
  "native-error",
  "ingress-rejected",
  "correlation-closed",
  "not-written",
] as const;
export type CodexRequestWireOutcome = (typeof CODEX_REQUEST_WIRE_OUTCOMES)[number];

export type CodexRequestWaiterSummary = {
  clientInstanceId: string;
  rpcId: number;
  waiterOrdinal: number;
  disposition: "new" | "joined";
  overloadAttemptOrdinal: number;
  attemptCreatedAtMs: number;
  firstPossibleWriteAtMs: number | null;
  waiterAttachedAtMs: number;
  waiterSettledAtMs: number;
  waiterOutcome: CodexRequestWaiterOutcome;
  wireOutcomeAtWaiterSettlement: CodexRequestWireOutcome;
  wireObservedAtMs: number | null;
};

export type CodexRequestWaiterFinished = (summary: CodexRequestWaiterSummary) => void;

export type CodexControlRequestObservation = {
  phase(phase: CodexControlRequestPhase): void;
  failed(failure: CodexControlRequestFailure): void;
  attemptWaiterFinished?: CodexRequestWaiterFinished;
};
