import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const StorageLocationNameSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,62}$" });

export const StorageLocationsListParamsSchema = closedObject({});
export const StorageLocationsListResultSchema = closedObject({
  locations: Type.Array(
    closedObject({
      name: StorageLocationNameSchema,
      provider: NonEmptyString,
      displayTarget: Type.Optional(NonEmptyString),
      encrypted: Type.Boolean(),
    }),
  ),
});

export const StorageLocationsProbeParamsSchema = closedObject({
  name: StorageLocationNameSchema,
});
export const StorageLocationsProbeResultSchema = closedObject({
  state: Type.Union([
    Type.Literal("ok"),
    Type.Literal("unavailable"),
    Type.Literal("uninitialized"),
    Type.Literal("wrong-key"),
    Type.Literal("error"),
  ]),
  freeBytes: Type.Optional(Type.Number({ minimum: 0 })),
  totalBytes: Type.Optional(Type.Number({ minimum: 0 })),
  message: Type.Optional(Type.String()),
});

export type StorageLocationsListParams = Static<typeof StorageLocationsListParamsSchema>;
export type StorageLocationsListResult = Static<typeof StorageLocationsListResultSchema>;
export type StorageLocationsProbeParams = Static<typeof StorageLocationsProbeParamsSchema>;
export type StorageLocationsProbeResult = Static<typeof StorageLocationsProbeResultSchema>;
