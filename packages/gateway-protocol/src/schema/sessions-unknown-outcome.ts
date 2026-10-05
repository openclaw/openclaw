import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Identifies the exact reviewed hold; this reference never grants authority. */
export const SessionUnknownOutcomeDecisionSchema = closedObject({
  sessionId: NonEmptyString,
  lifecycleRevision: Type.Optional(NonEmptyString),
  cycleId: NonEmptyString,
  revision: Type.Integer({ minimum: 1 }),
  pausedAtMs: Type.Integer({ minimum: 0 }),
  toolCallId: NonEmptyString,
  runId: NonEmptyString,
});
export type SessionUnknownOutcomeDecision = Static<typeof SessionUnknownOutcomeDecisionSchema>;
