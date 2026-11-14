import type { QuestionWaitAnswerResult } from "../../../packages/gateway-protocol/src/schema/questions.js";
import type {
  SourceQuestionInputV1,
  SourceQuestionV1,
} from "../../auto-reply/source-question.types.js";
import {
  QuestionDispatchRefusedError,
  QuestionDispatchUnsupportedError,
} from "./gateway-question-dispatch.js";
import type { AgentHarnessUserInputQuestion } from "./user-input-types.js";

/** One question's source publication; the existing question registry retains ownership. */
export function createSourceQuestionPublication(params: {
  input: Extract<SourceQuestionInputV1, { mode: "new-task" }> | undefined;
  questions: readonly AgentHarnessUserInputQuestion[];
  assertCurrent: () => void;
}) {
  const { input, questions, assertCurrent } = params;
  if (!input) {
    return undefined;
  }
  const publish = input.onQuestion;
  if (
    !publish ||
    questions.some(
      (question) =>
        question.isSecret ||
        question.resource ||
        question.url ||
        // Store bindings are deliberately absent from the portable harness type.
        Object.hasOwn(question, "secretStore") ||
        question.options?.some(
          (option) => option.resourceUri || option.preview || option.thumbnail,
        ),
    )
  ) {
    throw new QuestionDispatchUnsupportedError(
      "This source does not accept this business question",
    );
  }
  const controller = new AbortController();
  let published: SourceQuestionV1 | undefined;
  let trackedAnswer: Promise<QuestionWaitAnswerResult> | undefined;
  let confirmedResolutionId: string | undefined;
  let publication: Promise<void> | undefined;
  const retire = () => controller.abort(new Error("Source question is no longer pending"));
  const assertActive = () => {
    assertCurrent();
    if (controller.signal.aborted) {
      throw new QuestionDispatchRefusedError("Source question is no longer pending");
    }
  };
  return {
    retire,
    hasConfirmed: (resolutionId: string) => confirmedResolutionId === resolutionId,
    trackAnswer(answer: Promise<QuestionWaitAnswerResult>) {
      trackedAnswer = answer;
      const settled = (result?: QuestionWaitAnswerResult) => {
        if (trackedAnswer !== answer) {
          return;
        }
        confirmedResolutionId = result?.status === "answered" ? result.resolutionId : undefined;
        retire();
      };
      void answer.then(settled, () => settled());
    },
    assertExpected(expected: SourceQuestionV1 | undefined) {
      assertActive();
      if (!published || expected !== published) {
        throw new QuestionDispatchRefusedError("Source question instance does not match");
      }
    },
    async publish(this: void, expiresAtMs: number | undefined): Promise<void> {
      assertActive();
      if (expiresAtMs === undefined || !Number.isFinite(expiresAtMs)) {
        throw new QuestionDispatchUnsupportedError("Source question expiry is unavailable");
      }
      if (!publication) {
        published = Object.freeze({
          version: 1,
          expiresAtMs,
          signal: controller.signal,
          questions: Object.freeze(
            questions.map(
              ({ id, header, question, multiSelect, isOther, answerFormat, allowEmpty, options }) =>
                Object.freeze({
                  id,
                  header,
                  question,
                  ...(multiSelect !== undefined ? { multiSelect } : {}),
                  ...(isOther !== undefined ? { isOther } : {}),
                  ...(answerFormat ? { answerFormat } : {}),
                  ...(allowEmpty !== undefined ? { allowEmpty } : {}),
                  options: Object.freeze(
                    (options ?? []).map(({ label, description, value }) =>
                      Object.freeze({
                        label,
                        ...(description ? { description } : {}),
                        ...(value ? { value } : {}),
                      }),
                    ),
                  ),
                }),
            ),
          ),
        });
        const publishedQuestion = published;
        publication = (async () => {
          try {
            await publish(publishedQuestion);
            assertActive();
          } catch (error) {
            retire();
            throw error;
          }
        })();
      }
      await publication;
    },
  };
}

/** Source questions cannot use the legacy implicit/plain-text claim path. */
export function assertSourceQuestionReference(
  publication: ReturnType<typeof createSourceQuestionPublication>,
  expected: SourceQuestionV1 | undefined,
): void {
  if (publication) {
    publication.assertExpected(expected);
  } else if (expected) {
    throw new QuestionDispatchRefusedError("Source question instance is no longer available");
  }
}
