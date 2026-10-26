import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { ErrorShapeSchema } from "./error-shape.js";
import { NonEmptyString } from "./primitives.js";

/** Resumes a restart-tombstoned session or follows the legacy replacement flow. */
export const SessionsRecoverParamsSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  sessionId: Type.Optional(NonEmptyString),
  recoveryCycleId: Type.Optional(NonEmptyString),
  mode: Type.Optional(Type.Union([Type.Literal("in-place"), Type.Literal("new-session")])),
});

const SessionRecoveryContinuationOutcomeSchema = Type.Union([
  closedObject({
    status: Type.Literal("started"),
    runId: NonEmptyString,
  }),
  closedObject({
    status: Type.Literal("rejected"),
    error: ErrorShapeSchema,
  }),
]);

export const SessionsRecoverResultSchema = closedObject({
  ok: Type.Literal(true),
  key: NonEmptyString,
  sessionId: NonEmptyString,
  continuation: SessionRecoveryContinuationOutcomeSchema,
});
