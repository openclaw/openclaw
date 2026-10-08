import { Type, type Static } from "typebox";
import { lazyCompile } from "../protocol-validator.js";
import { closedObject } from "./closed-object.js";
import { WorkerIdentifierSchema, workerResponseSchema } from "./worker-protocol-primitives.js";

export const WORKER_EXEC_APPROVAL_PROTOCOL_FEATURE = "worker-exec-approval-v1";
export const WORKER_EXEC_APPROVAL_METHODS = {
  request: "worker.exec.approval.request",
  waitDecision: "worker.exec.approval.waitDecision",
} as const;

// Session, run, agent, host and policy are derived from the admitted connection.
const WorkerExecApprovalParamsSchema = closedObject({
  id: WorkerIdentifierSchema,
  command: Type.String({ minLength: 1, maxLength: 32_768 }),
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
  toolCallId: Type.Optional(WorkerIdentifierSchema),
  warningText: Type.Optional(Type.String({ maxLength: 4_096 })),
});
const WorkerExecApprovalDecisionParamsSchema = closedObject({ id: WorkerIdentifierSchema });
const WorkerExecApprovalDecisionSchema = Type.Union([
  Type.Literal("allow-once"),
  Type.Literal("deny"),
  Type.Null(),
]);
const WorkerExecApprovalResultSchema = closedObject({
  id: WorkerIdentifierSchema,
  expiresAtMs: Type.Integer({ minimum: 0 }),
  decision: Type.Optional(WorkerExecApprovalDecisionSchema),
});
const WorkerExecApprovalDecisionResultSchema = closedObject({
  decision: WorkerExecApprovalDecisionSchema,
  terminalReason: Type.Optional(Type.Literal("run-aborted")),
});
export const WorkerExecApprovalResponseFrameSchema = workerResponseSchema(
  WorkerExecApprovalResultSchema,
);
export const WorkerExecApprovalDecisionResponseFrameSchema = workerResponseSchema(
  WorkerExecApprovalDecisionResultSchema,
);
export const validateWorkerExecApprovalParams = lazyCompile(WorkerExecApprovalParamsSchema);
export const validateWorkerExecApprovalDecisionParams = lazyCompile(
  WorkerExecApprovalDecisionParamsSchema,
);
export type WorkerExecApprovalParams = Static<typeof WorkerExecApprovalParamsSchema>;
export type WorkerExecApprovalDecisionParams = Static<
  typeof WorkerExecApprovalDecisionParamsSchema
>;
export type WorkerExecApprovalResult = Static<typeof WorkerExecApprovalResultSchema>;
export type WorkerExecApprovalDecisionResult = Static<
  typeof WorkerExecApprovalDecisionResultSchema
>;
export type WorkerExecApprovalResponseFrame = Static<typeof WorkerExecApprovalResponseFrameSchema>;
export type WorkerExecApprovalDecisionResponseFrame = Static<
  typeof WorkerExecApprovalDecisionResponseFrameSchema
>;
