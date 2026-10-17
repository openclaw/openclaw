import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Standard structured error shape used in response frames and connect failures. */
export const ErrorShapeSchema = closedObject({
  code: NonEmptyString,
  message: NonEmptyString,
  details: Type.Optional(Type.Unknown()),
  retryable: Type.Optional(Type.Boolean()),
  retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
});

export type ErrorShape = Static<typeof ErrorShapeSchema>;
