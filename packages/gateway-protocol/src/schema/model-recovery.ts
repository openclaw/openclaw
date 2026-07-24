// Typed gateway contracts for exact model-target diversion fences.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

const ModelRecoveryIdentityString = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\s]{1,256}$",
});
const ModelRecoveryEpochSchema = Type.Integer({ minimum: 1 });
const ModelRecoveryTimestampSchema = Type.Integer({ minimum: 0 });

export const ModelRecoveryTargetSchema = closedObject({
  provider: ModelRecoveryIdentityString,
  model: ModelRecoveryIdentityString,
});

const ModelRecoveryFenceIdentityFields = {
  provider: ModelRecoveryIdentityString,
  model: ModelRecoveryIdentityString,
  topologyGeneration: ModelRecoveryIdentityString,
  fenceEpoch: ModelRecoveryEpochSchema,
  fenceToken: ModelRecoveryIdentityString,
};

export const ModelRecoveryStatusParamsSchema = closedObject({});

export const ModelRecoveryDivertNewParamsSchema = closedObject({
  ...ModelRecoveryFenceIdentityFields,
  resourceDomain: Type.Optional(ModelRecoveryIdentityString),
  deniedTargets: Type.Optional(Type.Array(ModelRecoveryTargetSchema, { maxItems: 128 })),
});

export const ModelRecoveryReleaseParamsSchema = closedObject({
  ...ModelRecoveryFenceIdentityFields,
});

export const ModelRecoveryFenceSchema = closedObject({
  ...ModelRecoveryFenceIdentityFields,
  mode: Type.Literal("divert_new"),
  state: Type.Union([Type.Literal("active"), Type.Literal("released")]),
  resourceDomain: Type.Union([ModelRecoveryIdentityString, Type.Null()]),
  deniedTargets: Type.Array(ModelRecoveryTargetSchema),
  createdAtMs: ModelRecoveryTimestampSchema,
  releasedAtMs: Type.Union([ModelRecoveryTimestampSchema, Type.Null()]),
});

export const ModelRecoveryStatusResultSchema = closedObject({
  capability: Type.Literal("available"),
  activeFences: Type.Array(ModelRecoveryFenceSchema),
});

export const ModelRecoveryDivertNewResultSchema = ModelRecoveryFenceSchema;
export const ModelRecoveryReleaseResultSchema = ModelRecoveryFenceSchema;

export type ModelRecoveryTarget = Static<typeof ModelRecoveryTargetSchema>;
export type ModelRecoveryStatusParams = Static<typeof ModelRecoveryStatusParamsSchema>;
export type ModelRecoveryDivertNewParams = Static<typeof ModelRecoveryDivertNewParamsSchema>;
export type ModelRecoveryReleaseParams = Static<typeof ModelRecoveryReleaseParamsSchema>;
export type ModelRecoveryFence = Static<typeof ModelRecoveryFenceSchema>;
export type ModelRecoveryStatusResult = Static<typeof ModelRecoveryStatusResultSchema>;
export type ModelRecoveryDivertNewResult = Static<typeof ModelRecoveryDivertNewResultSchema>;
export type ModelRecoveryReleaseResult = Static<typeof ModelRecoveryReleaseResultSchema>;
