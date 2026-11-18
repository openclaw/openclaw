import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const sessionTarget = {
  sessionKey: Type.Optional(NonEmptyString),
  agentId: Type.Optional(NonEmptyString),
};

export const EnvironmentsSessionCreateParamsSchema = closedObject({
  ...sessionTarget,
  profileId: NonEmptyString,
  idempotencyKey: Type.String({ minLength: 1, maxLength: 256 }),
  machineClass: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  os: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  presentation: Type.Optional(Type.Union([Type.Literal("desktop"), Type.Literal("portal")])),
});
export const EnvironmentsSessionStatusParamsSchema = closedObject({
  ...sessionTarget,
  environmentId: Type.Optional(NonEmptyString),
});
export const EnvironmentsSessionDestroyParamsSchema = closedObject({
  ...sessionTarget,
  environmentId: Type.Optional(NonEmptyString),
});
export type EnvironmentsSessionCreateParams = Static<typeof EnvironmentsSessionCreateParamsSchema>;
export type EnvironmentsSessionStatusParams = Static<typeof EnvironmentsSessionStatusParamsSchema>;
export type EnvironmentsSessionDestroyParams = Static<
  typeof EnvironmentsSessionDestroyParamsSchema
>;
