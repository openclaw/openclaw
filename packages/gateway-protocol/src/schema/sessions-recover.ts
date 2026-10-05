import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { ErrorShapeSchema } from "./frames.js";
import { NonEmptyString } from "./primitives.js";
import { SessionUnknownOutcomeDecisionSchema } from "./sessions-unknown-outcome.js";

/** An explicit disposition retires only the reviewed turn, without continuing it. */
export const SessionsRecoverParamsSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  acknowledgeUnknownOutcome: Type.Optional(SessionUnknownOutcomeDecisionSchema),
});

const SessionRecoveryContinuationOutcomeSchema = Type.Union([
  closedObject({ status: Type.Literal("idle") }),
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
