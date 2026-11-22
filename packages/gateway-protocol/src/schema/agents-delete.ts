import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Deletes an agent and optionally its workspace/config files. */
export const AgentsDeleteParamsSchema = closedObject({
  agentId: NonEmptyString,
  deleteFiles: Type.Optional(Type.Boolean()),
  /** Erase removed files instead of keeping them in Trash. Requires file deletion. */
  permanent: Type.Optional(Type.Boolean()),
});

/** Result returned after deleting an agent and unbinding sessions. */
export const AgentsDeleteResultSchema = closedObject({
  ok: Type.Literal(true),
  agentId: NonEmptyString,
  removedBindings: Type.Integer({ minimum: 0 }),
  removed: Type.Optional(
    Type.Array(
      closedObject({
        path: NonEmptyString,
        method: Type.Union([
          Type.Literal("trash"),
          Type.Literal("deleted"),
          Type.Literal("missing"),
        ]),
      }),
    ),
  ),
  failed: Type.Optional(
    Type.Array(
      closedObject({
        path: NonEmptyString,
        reason: NonEmptyString,
      }),
    ),
  ),
  purgeFailed: Type.Optional(Type.Literal(true)),
});
