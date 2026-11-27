import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Changes only the signed-in person's Involving me list, never session access. */
export const SessionsSetInvolvementParamsSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  expectedSessionId: NonEmptyString,
  hidden: Type.Boolean(),
});

export type SessionsSetInvolvementParams = Static<typeof SessionsSetInvolvementParamsSchema>;
