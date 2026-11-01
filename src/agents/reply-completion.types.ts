export type ReplyExpectation = "required" | "optional" | "result-required";

export type ReplyCompletionEvidence =
  | "ready"
  | "delivered"
  | "pending"
  | "blocked"
  | "empty"
  | "silent";

export type ReplyCompletion = {
  readonly expectation: ReplyExpectation;
  readonly outcome: ReplyCompletionEvidence | "missing";
};
