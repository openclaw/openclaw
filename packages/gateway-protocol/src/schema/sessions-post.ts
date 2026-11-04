import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Append text without starting or changing a model turn. */
export const SessionsPostParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  message: Type.String({ minLength: 1, maxLength: 200_000 }),
  expectedSessionId: NonEmptyString,
  idempotencyKey: NonEmptyString,
});

export type SessionsPostParams = Static<typeof SessionsPostParamsSchema>;
