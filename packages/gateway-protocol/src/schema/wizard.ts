// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Runtime state reported for gateway-driven setup wizard sessions. */
const WizardRunStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("cancelled"),
  Type.Literal("error"),
]);

/** Starts a setup wizard, optionally scoped to a local or remote workspace. */
export const WizardStartParamsSchema = closedObject({
  mode: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
  workspace: Type.Optional(Type.String()),
});

/** Client answer payload for the current wizard step. */
export const WizardAnswerSchema = closedObject({
  stepId: NonEmptyString,
  value: Type.Optional(Type.Unknown()),
});

/** Advances a wizard session, with an answer when the previous step requested input. */
export const WizardNextParamsSchema = closedObject({
  sessionId: NonEmptyString,
  answer: Type.Optional(WizardAnswerSchema),
});

/** Shared session-id-only params for cancel and status requests. */
const WizardSessionIdParamsSchema = closedObject({
  sessionId: NonEmptyString,
});

/** Cancels an active wizard session. */
export const WizardCancelParamsSchema = WizardSessionIdParamsSchema;

/** Reads status for an active or recently completed wizard session. */
export const WizardStatusParamsSchema = WizardSessionIdParamsSchema;

/** Selectable value shown in a choice-based wizard step. */
export const WizardStepOptionSchema = closedObject({
  value: Type.Unknown(),
  label: NonEmptyString,
  hint: Type.Optional(Type.String()),
});

const WizardDeviceCodeSchema = closedObject({
  code: NonEmptyString,
  expiresInMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
  message: Type.Optional(Type.String()),
});

/** UI contract for one wizard step rendered by gateway clients. */
export const WizardStepSchema = closedObject({
  id: NonEmptyString,
  type: Type.Union([
    Type.Literal("note"),
    Type.Literal("select"),
    Type.Literal("text"),
    Type.Literal("confirm"),
    Type.Literal("multiselect"),
    Type.Literal("progress"),
    Type.Literal("action"),
  ]),
  title: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  format: Type.Optional(Type.Union([Type.Literal("plain")])),
  options: Type.Optional(Type.Array(WizardStepOptionSchema)),
  initialValue: Type.Optional(Type.Unknown()),
  placeholder: Type.Optional(Type.String()),
  sensitive: Type.Optional(Type.Boolean()),
  executor: Type.Optional(Type.Union([Type.Literal("gateway"), Type.Literal("client")])),
  externalUrl: Type.Optional(Type.String()),
  deviceCode: Type.Optional(WizardDeviceCodeSchema),
});

/** Common response fields for start and next calls. */
const WizardResultFields = {
  done: Type.Boolean(),
  step: Type.Optional(WizardStepSchema),
  status: Type.Optional(WizardRunStatusSchema),
  error: Type.Optional(Type.String()),
};

/** Result after advancing a wizard session. */
export const WizardNextResultSchema = closedObject(WizardResultFields);

/** Result returned when a wizard session is created. */
export const WizardStartResultSchema = closedObject({
  sessionId: NonEmptyString,
  ...WizardResultFields,
});

/** Minimal status poll result used when the client does not need the next step. */
export const WizardStatusResultSchema = closedObject({
  status: WizardRunStatusSchema,
  error: Type.Optional(Type.String()),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type WizardStartParams = Static<typeof WizardStartParamsSchema>;
export type WizardNextParams = Static<typeof WizardNextParamsSchema>;
export type WizardCancelParams = Static<typeof WizardCancelParamsSchema>;
export type WizardStatusParams = Static<typeof WizardStatusParamsSchema>;
export type WizardStep = Static<typeof WizardStepSchema>;
export type WizardNextResult = Static<typeof WizardNextResultSchema>;
export type WizardStartResult = Static<typeof WizardStartResultSchema>;
export type WizardStatusResult = Static<typeof WizardStatusResultSchema>;
