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

export type CodexControlRequestObservation = {
  phase(phase: CodexControlRequestPhase): void;
  failed(failure: CodexControlRequestFailure): void;
};
