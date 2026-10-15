import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { stringLiteralUnion } from "./string-literal-union.js";

export const SessionGoalSchema = closedObject({
  schemaVersion: Type.Literal(1),
  id: NonEmptyString,
  objective: Type.String(),
  status: stringLiteralUnion([
    "active",
    "paused",
    "blocked",
    "usage_limited",
    "budget_limited",
    "complete",
  ]),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  tokenStart: Type.Number(),
  tokenStartFresh: Type.Optional(Type.Boolean()),
  tokensUsed: Type.Number(),
  tokenBudget: Type.Optional(Type.Number()),
  continuationTurns: Type.Number(),
  lastStatusNote: Type.Optional(Type.String()),
  pausedAt: Type.Optional(Type.Number()),
  blockedAt: Type.Optional(Type.Number()),
  completedAt: Type.Optional(Type.Number()),
  usageLimitedAt: Type.Optional(Type.Number()),
  budgetLimitedAt: Type.Optional(Type.Number()),
});

export type SessionGoal = Static<typeof SessionGoalSchema>;
export type SessionGoalStatus = SessionGoal["status"];

const GoalOperationIdentity = {
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  sessionId: Type.Optional(NonEmptyString),
  goalId: NonEmptyString,
  operationId: Type.String({ minLength: 1, maxLength: 128 }),
  issuedAtMs: Type.Integer({ minimum: 0 }),
};

export const SessionsGoalUpdateParamsSchema = Type.Union([
  closedObject({
    ...GoalOperationIdentity,
    action: Type.Literal("edit"),
    objective: Type.String({ minLength: 1, maxLength: 16_000 }),
  }),
  closedObject({
    ...GoalOperationIdentity,
    action: stringLiteralUnion(["pause", "resume", "complete", "block"]),
    note: Type.Optional(Type.String({ maxLength: 2_000 })),
  }),
]);
export const SessionsGoalClearParamsSchema = closedObject(GoalOperationIdentity);
export const SessionsGoalMutationResultSchema = closedObject({
  operationId: NonEmptyString,
  action: stringLiteralUnion(["start", "edit", "pause", "resume", "complete", "block", "clear"]),
  sessionId: NonEmptyString,
  goalId: NonEmptyString,
  goal: Type.Optional(SessionGoalSchema),
  runId: Type.Optional(NonEmptyString),
  replayed: Type.Optional(Type.Literal(true)),
  status: stringLiteralUnion(["started", "updated", "cleared"]),
});

export type SessionsGoalUpdateParams = Static<typeof SessionsGoalUpdateParamsSchema>;
export type SessionsGoalClearParams = Static<typeof SessionsGoalClearParamsSchema>;
export type SessionsGoalMutationResult = Static<typeof SessionsGoalMutationResultSchema>;
