import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

export const SystemAgentSetupAutoParamsSchema = closedObject({});

export const SystemAgentSetupAutoCandidateSchema = closedObject({
  kind: Type.String(),
  label: Type.String(),
  detail: Type.String(),
  modelRef: Type.String(),
  brandId: Type.Optional(Type.String()),
  icon: Type.Optional(Type.String()),
});

export const SystemAgentSetupAutoResultSchema = closedObject({
  status: Type.Union([
    Type.Literal("configured"),
    Type.Literal("activated"),
    Type.Literal("needs-sign-in"),
    Type.Literal("unavailable"),
  ]),
  selected: Type.Optional(SystemAgentSetupAutoCandidateSchema),
  alternatives: Type.Array(SystemAgentSetupAutoCandidateSchema),
  attempts: Type.Array(
    closedObject({ kind: Type.String(), label: Type.String(), error: Type.String() }),
  ),
  signIn: Type.Optional(closedObject({ authOptionId: Type.String(), label: Type.String() })),
  installedPlugins: Type.Array(Type.String()),
});

export type SystemAgentSetupAutoParams = Static<typeof SystemAgentSetupAutoParamsSchema>;
export type SystemAgentSetupAutoCandidate = Static<typeof SystemAgentSetupAutoCandidateSchema>;
export type SystemAgentSetupAutoResult = Static<typeof SystemAgentSetupAutoResultSchema>;

export const SetupInferenceFailureStatusSchema = Type.Union([
  Type.Literal("auth"),
  Type.Literal("rate_limit"),
  Type.Literal("billing"),
  Type.Literal("timeout"),
  Type.Literal("format"),
  Type.Literal("unavailable"),
  Type.Literal("unknown"),
]);

/** Finalized rejection before the model config commit; saved credentials may remain. */
export const SetupInferenceActivationRejectionSchema = closedObject({
  disposition: Type.Literal("rejected-before-promotion"),
  status: SetupInferenceFailureStatusSchema,
});

export type SetupInferenceFailureStatus = Static<typeof SetupInferenceFailureStatusSchema>;
export type SetupInferenceActivationRejection = Static<
  typeof SetupInferenceActivationRejectionSchema
>;
