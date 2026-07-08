// Gateway Protocol schema module for model->user structured questions.
//
// These payloads cross the client<->gateway seam for the ask_user_question flow:
// the resolve params (any surface answering a pending question) and the list
// params (visibility-filtered pending questions). Answers are keyed by the
// model-facing question id.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/** One answered question: the text the user chose or typed. */
export const QuestionAnswerSchema = Type.Object(
  {
    text: Type.String(),
  },
  { additionalProperties: false },
);

/** Reviewer/user answer payload resolving one pending question record. */
export const QuestionResolveParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    answers: Type.Record(NonEmptyString, QuestionAnswerSchema),
  },
  { additionalProperties: false },
);

/** Empty request payload for listing pending questions visible to the caller. */
export const QuestionListParamsSchema = Type.Object({}, { additionalProperties: false });
