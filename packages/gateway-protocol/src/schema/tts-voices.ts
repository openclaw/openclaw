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
  category: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  locale: Type.Optional(Type.String()),
  gender: Type.Optional(Type.String()),
});

export const TtsVoicesResultSchema = closedObject({
  provider: NonEmptyString,
  voices: Type.Array(TtsVoiceOptionSchema),
});

export const TtsDesignVoiceResultSchema = closedObject({
  provider: NonEmptyString,
  id: NonEmptyString,
  name: Type.Optional(Type.String()),
  mimeType: Type.Optional(Type.String()),
  audioBase64: NonEmptyString,
});

export const TtsReplicateVoiceResultSchema = closedObject({
  provider: NonEmptyString,
  id: NonEmptyString,
  name: Type.Optional(Type.String()),
  mimeType: Type.Optional(Type.String()),
  audioBase64: Type.Optional(Type.String()),
});

export type TtsVoicesParams = Static<typeof TtsVoicesParamsSchema>;
export type TtsVoicesResult = Static<typeof TtsVoicesResultSchema>;
export type TtsDesignVoiceParams = Static<typeof TtsDesignVoiceParamsSchema>;
export type TtsDesignVoiceResult = Static<typeof TtsDesignVoiceResultSchema>;
export type TtsReplicateVoiceParams = Static<typeof TtsReplicateVoiceParamsSchema>;
export type TtsReplicateVoiceResult = Static<typeof TtsReplicateVoiceResultSchema>;
