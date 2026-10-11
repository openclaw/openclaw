import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const SessionActivitySummarySchema = closedObject({
  /** Caller-specific participation permission; operator.write is required separately. */
  canEnsure: Type.Optional(Type.Boolean()),
  text: Type.Optional(Type.String({ maxLength: 900 })),
  updatedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  state: Type.Union([
    Type.Literal("current"),
    Type.Literal("stale"),
    Type.Literal("updating"),
    Type.Literal("unavailable"),
  ]),
});
export const SessionsActivitySummaryEnsureParamsSchema = closedObject({
  sessions: Type.Array(
    closedObject({ key: NonEmptyString, agentId: Type.Optional(NonEmptyString) }),
    {
      minItems: 1,
      maxItems: 20,
    },
  ),
});
export const SessionsActivitySummaryEnsureResultSchema = closedObject({
  sessions: Type.Array(
    closedObject({
      key: NonEmptyString,
      agentId: NonEmptyString,
      activitySummary: SessionActivitySummarySchema,
    }),
    { maxItems: 20 },
  ),
});
export type SessionActivitySummary = Static<typeof SessionActivitySummarySchema>;
