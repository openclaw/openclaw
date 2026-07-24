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
export const MODEL_RECOVERY_CAPABILITY_VERSION = 2 as const;
export const MODEL_RECOVERY_EFFECT_CAPABILITY_VERSION = 1 as const;
export const MODEL_RECOVERY_DELIVERY_CAPABILITY_VERSION = 1 as const;
const ModelRecoveryCapabilityVersionSchema = Type.Literal(MODEL_RECOVERY_CAPABILITY_VERSION);

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

export const ModelRecoveryStatusParamsSchema = closedObject({
  capabilityVersion: ModelRecoveryCapabilityVersionSchema,
});

export const ModelRecoveryDivertNewParamsSchema = closedObject({
  capabilityVersion: ModelRecoveryCapabilityVersionSchema,
  ...ModelRecoveryFenceIdentityFields,
  resourceDomain: Type.Optional(ModelRecoveryIdentityString),
  deniedTargets: Type.Optional(Type.Array(ModelRecoveryTargetSchema, { maxItems: 128 })),
});

export const ModelRecoveryPrepareRecoveryParamsSchema = closedObject({
  capabilityVersion: ModelRecoveryCapabilityVersionSchema,
  ...ModelRecoveryFenceIdentityFields,
  resourceDomain: Type.Optional(ModelRecoveryIdentityString),
  deniedTargets: Type.Optional(Type.Array(ModelRecoveryTargetSchema, { maxItems: 128 })),
});

export const ModelRecoveryReleaseParamsSchema = closedObject({
  capabilityVersion: ModelRecoveryCapabilityVersionSchema,
  ...ModelRecoveryFenceIdentityFields,
});

export const ModelRecoveryFenceSchema = closedObject({
  ...ModelRecoveryFenceIdentityFields,
  mode: Type.Union([Type.Literal("divert_new"), Type.Literal("prepare_recovery")]),
  state: Type.Union([Type.Literal("active"), Type.Literal("prepared"), Type.Literal("released")]),
  resourceDomain: Type.Union([ModelRecoveryIdentityString, Type.Null()]),
  deniedTargets: Type.Array(ModelRecoveryTargetSchema),
  createdAtMs: ModelRecoveryTimestampSchema,
  preparedAtMs: Type.Union([ModelRecoveryTimestampSchema, Type.Null()]),
  generationGoneAtMs: Type.Union([ModelRecoveryTimestampSchema, Type.Null()]),
  releasedAtMs: Type.Union([ModelRecoveryTimestampSchema, Type.Null()]),
});

export const ModelRecoveryStatusResultSchema = closedObject({
  capability: Type.Literal("available"),
  capabilityVersion: ModelRecoveryCapabilityVersionSchema,
  durableEffectCapabilityVersion: Type.Literal(MODEL_RECOVERY_EFFECT_CAPABILITY_VERSION),
  durableDeliveryCapabilityVersion: Type.Literal(MODEL_RECOVERY_DELIVERY_CAPABILITY_VERSION),
  submissionPermitCapabilityVersion: Type.Literal(1),
  prepareRecoveryAvailable: Type.Boolean(),
  activeFences: Type.Array(ModelRecoveryFenceSchema),
});

export const ModelRecoveryDivertNewResultSchema = ModelRecoveryFenceSchema;
export const ModelRecoveryPrepareRecoveryResultSchema = ModelRecoveryFenceSchema;
export const ModelRecoveryReleaseResultSchema = ModelRecoveryFenceSchema;

export type ModelRecoveryTarget = Static<typeof ModelRecoveryTargetSchema>;
export type ModelRecoveryStatusParams = Static<typeof ModelRecoveryStatusParamsSchema>;
export type ModelRecoveryDivertNewParams = Static<typeof ModelRecoveryDivertNewParamsSchema>;
export type ModelRecoveryPrepareRecoveryParams = Static<
  typeof ModelRecoveryPrepareRecoveryParamsSchema
>;
export type ModelRecoveryReleaseParams = Static<typeof ModelRecoveryReleaseParamsSchema>;
export type ModelRecoveryFence = Static<typeof ModelRecoveryFenceSchema>;
export type ModelRecoveryStatusResult = Static<typeof ModelRecoveryStatusResultSchema>;
export type ModelRecoveryDivertNewResult = Static<typeof ModelRecoveryDivertNewResultSchema>;
export type ModelRecoveryPrepareRecoveryResult = Static<
  typeof ModelRecoveryPrepareRecoveryResultSchema
>;
export type ModelRecoveryReleaseResult = Static<typeof ModelRecoveryReleaseResultSchema>;
