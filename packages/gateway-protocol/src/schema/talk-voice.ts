import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { stringLiteralUnion } from "./string-literal-union.js";

export const TALK_VOICE_CHANGE_TIMEOUT_MS = 60_000;

const target = {
  sessionKey: Type.Optional(NonEmptyString),
  voiceSessionId: Type.Optional(NonEmptyString),
};
const selection = {
  voiceSessionId: NonEmptyString,
  sessionKey: NonEmptyString,
  provider: NonEmptyString,
  model: Type.Optional(NonEmptyString),
  voice: Type.Optional(NonEmptyString),
  voices: Type.Array(NonEmptyString),
  canChange: Type.Boolean(),
};

export const TalkVoiceGetParamsSchema = closedObject(target);
export const TalkVoiceSetParamsSchema = closedObject({ ...target, voice: NonEmptyString });
export const TalkVoiceSelectionSchema = closedObject(selection);
export const TalkVoiceSetResultSchema = closedObject({
  ...selection,
  status: Type.Literal("applied"),
});
export const TalkVoiceCompleteParamsSchema = closedObject({
  changeId: NonEmptyString,
  voiceSessionId: Type.Optional(NonEmptyString),
  outcome: stringLiteralUnion(["ready", "failed"]),
  error: Type.Optional(Type.String({ maxLength: 1000 })),
});
export const TalkVoiceChangeEventSchema = closedObject({
  changeId: NonEmptyString,
  voiceSessionId: NonEmptyString,
  sessionKey: NonEmptyString,
  voice: NonEmptyString,
  phase: stringLiteralUnion(["requested", "cancelled"]),
});

export type TalkVoiceGetParams = Static<typeof TalkVoiceGetParamsSchema>;
export type TalkVoiceSetParams = Static<typeof TalkVoiceSetParamsSchema>;
export type TalkVoiceSelection = Static<typeof TalkVoiceSelectionSchema>;
export type TalkVoiceSetResult = Static<typeof TalkVoiceSetResultSchema>;
export type TalkVoiceCompleteParams = Static<typeof TalkVoiceCompleteParamsSchema>;
export type TalkVoiceChangeEvent = Static<typeof TalkVoiceChangeEventSchema>;
