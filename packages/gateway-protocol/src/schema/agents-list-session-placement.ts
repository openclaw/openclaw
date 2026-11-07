import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Optional placement policy projected with an agent roster on explicit request. */
export const AgentsListPlacementProperties = {
  sessionPlacement: Type.Optional(
    closedObject({
      requiredProfile: Type.Optional(
        closedObject({
          id: NonEmptyString,
          providerId: Type.Optional(NonEmptyString),
          executionModes: Type.Optional(Type.Array(Type.Literal("worker-turn"))),
          inference: Type.Optional(Type.Literal("worker")),
        }),
      ),
    }),
  ),
};

/** Defaults retain the full roster; clients can request lightweight projections. */
export const AgentsListParamsSchema = closedObject({
  includeAvatars: Type.Optional(Type.Boolean()),
  includeSessionPlacement: Type.Optional(Type.Boolean()),
});

export type AgentsListParams = Static<typeof AgentsListParamsSchema>;
