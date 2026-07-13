import type { Static } from "typebox";
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/** Acknowledges playback through a named realtime provider mark. */
export const TalkSessionAcknowledgeMarkParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    markName: NonEmptyString,
  },
  { additionalProperties: false },
);

export type TalkSessionAcknowledgeMarkParams = Static<
  typeof TalkSessionAcknowledgeMarkParamsSchema
>;
