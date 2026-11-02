import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Creates a configured agent; the server supplies an omitted workspace. */
export const AgentsCreateParamsSchema = closedObject({
  name: NonEmptyString,
  /** Stable internal identity, independent of the display name. Omission derives it from name. */
  agentId: Type.Optional(NonEmptyString),
  /** Begin the created agent's normal onboarding with an assistant-authored opening turn. */
  onboarding: Type.Optional(Type.Boolean()),
  expectedOwnerId: Type.Optional(NonEmptyString),
  workspace: Type.Optional(NonEmptyString),
  model: Type.Optional(NonEmptyString),
  emoji: Type.Optional(Type.String()),
  avatar: Type.Optional(Type.String()),
});

/** Result returned after creating an agent. */
export const AgentsCreateResultSchema = closedObject({
  ok: Type.Literal(true),
  agentId: NonEmptyString,
  name: NonEmptyString,
  workspace: NonEmptyString,
  agentDir: Type.Optional(NonEmptyString),
  model: Type.Optional(NonEmptyString),
  onboarding: Type.Optional(
    Type.Union([
      closedObject({
        sessionKey: NonEmptyString,
        status: Type.Literal("completed"),
      }),
      closedObject({
        sessionKey: NonEmptyString,
        status: Type.Literal("error"),
        error: NonEmptyString,
      }),
    ]),
  ),
});

export type AgentsCreateParams = Static<typeof AgentsCreateParamsSchema>;
export type AgentsCreateResult = Static<typeof AgentsCreateResultSchema>;
