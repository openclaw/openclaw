import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Lists stored and catalog voices for one speech provider. */
export const TtsVoicesParamsSchema = closedObject({
  provider: NonEmptyString,
});

/** Prompted custom-voice store request. */
export const TtsDesignVoiceParamsSchema = closedObject({
  provider: NonEmptyString,
  displayName: NonEmptyString,
  prompt: NonEmptyString,
  languageCode: Type.Optional(Type.String()),
  gender: Type.Optional(Type.String()),
  modelId: Type.Optional(Type.String()),
});

/** Replicated custom-voice store request from two recordings. */
export const TtsReplicateVoiceParamsSchema = closedObject({
  provider: NonEmptyString,
  displayName: NonEmptyString,
  sourceAudioBase64: NonEmptyString,
  consentAudioBase64: NonEmptyString,
  sourceMimeType: Type.Optional(Type.String()),
  consentMimeType: Type.Optional(Type.String()),
  modelId: Type.Optional(Type.String()),
});

export const TtsVoiceOptionSchema = closedObject({
  id: NonEmptyString,
  name: Type.Optional(Type.String()),
  stored: Type.Optional(Type.Boolean()),
  category: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  locale: Type.Optional(Type.String()),
  gender: Type.Optional(Type.String()),
});

export const TtsVoicesResultSchema = closedObject({
  provider: NonEmptyString,
  voices: Type.Array(TtsVoiceOptionSchema),
  projectListingIncomplete: Type.Optional(Type.Boolean()),
});

// An uncertain non-idempotent store has no confirmed voice ID or preview.
const TtsVoiceStoreUncertainResultSchema = closedObject({
  provider: NonEmptyString,
  outcome: Type.Literal("uncertain"),
  message: Type.String(),
});

// Both new Gateway store methods expose an explicit, native-decodable outcome.
export const TtsDesignVoiceResultSchema = Type.Union([
  closedObject({
    provider: NonEmptyString,
    outcome: Type.Literal("stored"),
    id: NonEmptyString,
    name: Type.Optional(Type.String()),
    mimeType: Type.Optional(Type.String()),
    audioBase64: NonEmptyString,
  }),
  TtsVoiceStoreUncertainResultSchema,
]);

export const TtsReplicateVoiceResultSchema = Type.Union([
  closedObject({
    provider: NonEmptyString,
    outcome: Type.Literal("stored"),
    id: NonEmptyString,
    name: Type.Optional(Type.String()),
    mimeType: Type.Optional(Type.String()),
    audioBase64: Type.Optional(Type.String()),
  }),
  TtsVoiceStoreUncertainResultSchema,
]);

export type TtsVoicesParams = Static<typeof TtsVoicesParamsSchema>;
export type TtsVoicesResult = Static<typeof TtsVoicesResultSchema>;
export type TtsDesignVoiceParams = Static<typeof TtsDesignVoiceParamsSchema>;
export type TtsDesignVoiceResult = Static<typeof TtsDesignVoiceResultSchema>;
export type TtsReplicateVoiceParams = Static<typeof TtsReplicateVoiceParamsSchema>;
export type TtsReplicateVoiceResult = Static<typeof TtsReplicateVoiceResultSchema>;
