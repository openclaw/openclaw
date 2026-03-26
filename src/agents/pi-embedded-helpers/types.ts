export type EmbeddedContextFile = {
  path: string;
  content: string;
  policySlicing?: {
    applied: boolean;
    mode: "file";
    originalChars: number;
    slicedChars: number;
    retainedChars: number;
    reasons: string[];
  };
};

export type FailoverReason =
  | "auth"
  | "auth_permanent"
  | "format"
  | "rate_limit"
  | "overloaded"
  | "billing"
  | "timeout"
  | "model_not_found"
  | "session_expired"
  | "unknown";
