import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const SessionProviderReviewProjectionSchema = closedObject({
  id: NonEmptyString,
  runId: NonEmptyString,
  explanation: Type.Optional(Type.String({ maxLength: 65_536 })),
  continuationMessage: Type.Optional(Type.String({ maxLength: 1_024 })),
  canContinue: Type.Boolean(),
});

export const SessionsProviderReviewContinueParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  sessionId: NonEmptyString,
  reviewId: NonEmptyString,
  idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
});

export type SessionProviderReviewProjection = Static<typeof SessionProviderReviewProjectionSchema>;
export type SessionsProviderReviewContinueParams = Static<
  typeof SessionsProviderReviewContinueParamsSchema
>;
