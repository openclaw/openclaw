import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const CommitShaSchema = Type.String({ pattern: "^[a-f0-9]{40}(?:[a-f0-9]{24})?$" });

/** A folder in the conversation's workspace whose Git origin matches a project. */
export const MoveSessionCheckoutSchema = closedObject({
  /** Relative to the conversation's workspace. */
  path: Type.String({ minLength: 1, maxLength: 1024 }),
  commit: CommitShaSchema,
  unsavedFiles: Type.Integer({ minimum: 0 }),
});

export const MoveSessionProjectSchema = closedObject({
  id: NonEmptyString,
  name: NonEmptyString,
  originUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  checkouts: Type.Array(MoveSessionCheckoutSchema, { maxItems: 32 }),
});

export const ProjectsMoveSessionOptionsParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
});
export const ProjectsMoveSessionOptionsResultSchema = closedObject({
  available: Type.Boolean(),
  /** Why the conversation cannot move, phrased for the person who asked. */
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  projects: Type.Array(MoveSessionProjectSchema, { maxItems: 200 }),
});

export const ProjectsMoveSessionParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  projectId: NonEmptyString,
  /** A checkout from the options result whose commits and unsaved files come along. */
  checkout: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
});
export const ProjectsMoveSessionResultSchema = closedObject({
  /** The managed branch is ready when the move returns. */
  status: Type.Literal("moved"),
  branch: NonEmptyString,
  projectId: NonEmptyString,
  carried: Type.Optional(
    closedObject({
      commit: CommitShaSchema,
      unsavedFiles: Type.Integer({ minimum: 0 }),
    }),
  ),
});

export type MoveSessionProject = Static<typeof MoveSessionProjectSchema>;
export type ProjectsMoveSessionOptionsParams = Static<
  typeof ProjectsMoveSessionOptionsParamsSchema
>;
export type ProjectsMoveSessionOptionsResult = Static<
  typeof ProjectsMoveSessionOptionsResultSchema
>;
export type ProjectsMoveSessionParams = Static<typeof ProjectsMoveSessionParamsSchema>;
export type ProjectsMoveSessionResult = Static<typeof ProjectsMoveSessionResultSchema>;
