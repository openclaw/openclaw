import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Receipt emitted only after the requested runtime generation was applied. */
export const PluginRuntimeApplicationSchema = closedObject({
  operationId: NonEmptyString,
  generation: Type.Integer({ minimum: 0 }),
  pluginIds: Type.Array(NonEmptyString),
  sourceDigests: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
  selectedEntries: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
});

export const PluginsChangedEventSchema = closedObject({
  generation: Type.Integer({ minimum: 0 }),
});

/** Internal signal that persisted plugin metadata changed outside the Gateway process. */
export const PluginsRefreshParamsSchema = closedObject({});

export const PluginsRefreshResultSchema = closedObject({
  ok: Type.Literal(true),
  restartRequired: Type.Optional(Type.Boolean()),
  runtime: Type.Optional(PluginRuntimeApplicationSchema),
  warnings: Type.Optional(Type.Array(Type.String())),
});
