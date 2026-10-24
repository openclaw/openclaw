import { Type, type Static } from "typebox";
import { lazyCompile } from "../protocol-validator.js";
import { closedObject } from "./closed-object.js";
import { WorkerIdentifierSchema, workerResponseSchema } from "./worker-protocol-primitives.js";

export const WORKER_EXEC_APPROVAL_PROTOCOL_FEATURE = "worker-exec-approval-v1";
export const WORKER_EXEC_APPROVAL_METHOD = "worker.exec.approval";
const Text = Type.String({ maxLength: 32_768 });
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Binding = closedObject({
  command: Text,
  execCommand: Text,
  cwd: Type.String({ minLength: 1, maxLength: 4_096 }),
  environment: Digest,
  pty: Type.Boolean(),
});
const Review = closedObject({
  argv: Type.Optional(Type.Array(Text, { maxItems: 256 })),
  resolvedPath: Type.Optional(Type.Union([Text, Type.Null()])),
  envKeys: Type.Optional(Type.Array(Text, { maxItems: 256 })),
  reason: Type.Enum(
    [
      "approval-required",
      "allowlist-miss",
      "strict-inline-eval",
      "heredoc",
      "execution-plan-miss",
    ] as const,
    { type: "string" },
  ),
  analysis: closedObject({
    parsed: Type.Boolean(),
    allowlistMatched: Type.Boolean(),
    safeBinMatched: Type.Optional(Type.Boolean()),
    durableApprovalMatched: Type.Optional(Type.Boolean()),
    inlineEval: Type.Boolean(),
    heredoc: Type.Optional(Type.Boolean()),
    shellWrapper: Type.Optional(Type.Boolean()),
  }),
});
const Common = { binding: Binding, toolCallId: WorkerIdentifierSchema };
export const WorkerExecApprovalParamsSchema = Type.Union([
  closedObject({ ...Common, operation: Type.Literal("review"), review: Review }),
  closedObject({
    ...Common,
    operation: Type.Literal("request"),
    id: WorkerIdentifierSchema,
    warningText: Type.Optional(Text),
  }),
  closedObject({ ...Common, operation: Type.Literal("wait"), id: WorkerIdentifierSchema }),
]);
const Risk = Type.Enum(["low", "medium", "high", "unknown"] as const, { type: "string" });
const Decision = Type.Union([Type.Literal("allow-once"), Type.Literal("deny"), Type.Null()]);
const Result = Type.Union([
  closedObject({
    operation: Type.Literal("review"),
    binding: Digest,
    decision: Type.Union([
      closedObject({
        decision: Type.Literal("allow-once"),
        risk: Type.Union([Type.Literal("low"), Type.Literal("medium")]),
        rationale: Text,
        userAuthorization: Type.Optional(Risk),
      }),
      closedObject({
        decision: Type.Union([Type.Literal("deny"), Type.Literal("ask")]),
        risk: Risk,
        rationale: Text,
        userAuthorization: Type.Optional(Risk),
      }),
    ]),
  }),
  closedObject({
    operation: Type.Literal("request"),
    binding: Digest,
    id: WorkerIdentifierSchema,
    expiresAtMs: Type.Number(),
    decision: Type.Optional(Decision),
  }),
  closedObject({
    operation: Type.Literal("wait"),
    binding: Digest,
    decision: Decision,
    terminalReason: Type.Optional(Type.String()),
  }),
]);
export const WorkerExecApprovalResponseFrameSchema = workerResponseSchema(Result);
export const validateWorkerExecApprovalParams = lazyCompile(WorkerExecApprovalParamsSchema);
export type WorkerExecApprovalParams = Static<typeof WorkerExecApprovalParamsSchema>;
export type WorkerExecApprovalBinding = Static<typeof Binding>;
export type WorkerExecApprovalResult = Static<typeof Result>;
export type WorkerExecApprovalResponseFrame = Static<typeof WorkerExecApprovalResponseFrameSchema>;
