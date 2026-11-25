import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Reads model-provider credential health for one configured agent. */
export const ModelsAuthStatusParamsSchema = closedObject({
  /** Ask which already-visible shared credentials can be pinned to a specific model route. */
  accountTarget: Type.Optional(
    closedObject({
      sessionKey: NonEmptyString,
      provider: NonEmptyString,
      model: NonEmptyString,
      runtime: NonEmptyString,
    }),
  ),
  refresh: Type.Optional(Type.Boolean()),
  /** Await cold or stale provider usage using prepared credentials, without refreshing auth. */
  refreshUsage: Type.Optional(Type.Boolean()),
  agentId: Type.Optional(Type.String()),
});

/** Rebuilds Gateway auth state after a credential or selection mutation. */
export const ModelsAuthRefreshParamsSchema = closedObject({
  operation: Type.Union([Type.Literal("login"), Type.Literal("logout"), Type.Literal("update")]),
  agentId: Type.Optional(Type.String()),
});

export type ModelsAuthStatusParams = Static<typeof ModelsAuthStatusParamsSchema>;
export type ModelsAuthRefreshParams = Static<typeof ModelsAuthRefreshParamsSchema>;
