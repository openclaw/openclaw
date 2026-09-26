import type { QuestionSourceBindingRoute } from "../../../packages/gateway-protocol/src/schema/questions.js";
import type { ReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { QuestionDispatchRefusedError } from "./gateway-question-dispatch.js";

type CallerQuestionState = {
  answerAuthority?: {
    assertCaller: (caller: ReplyToolAuthorityOverlay) => void;
  } | null;
};

export type QuestionInputAuthority = {
  kind: "run" | "source-bound";
  assertCurrent: () => void;
  sourceBindingRoutes?: readonly QuestionSourceBindingRoute[];
};

export function withQuestionSourceBindingRoutes<T extends object>(
  params: T,
  authority?: { sourceBindingRoutes?: readonly QuestionSourceBindingRoute[] },
): T & { sourceBindingRoutes?: QuestionSourceBindingRoute[] } {
  return authority?.sourceBindingRoutes?.length
    ? { ...params, sourceBindingRoutes: [...authority.sourceBindingRoutes] }
    : params;
}

export function refuseQuestionSourceBindingRejection(
  rejection: { code?: unknown; reason?: string } | undefined,
  error: unknown,
): void {
  if (
    rejection?.code === "FORBIDDEN" &&
    (rejection.reason === "QUESTION_SOURCE_BINDING_CHANGED" ||
      rejection.reason === "QUESTION_SOURCE_BINDING_UNAVAILABLE")
  ) {
    throw new QuestionDispatchRefusedError(
      "Conversation binding changed before the question answer was sent.",
      { cause: error },
    );
  }
}

/** Source-bound authority for a creator-policy claim. The current check stays synchronous. */
export function createSourceBoundCallerAuthority(
  params: {
    caller?: ReplyToolAuthorityOverlay;
    callerFingerprint?: string;
    creatorFingerprint?: string;
    assertSourceCurrent: () => void;
    sourceBindingRoutes?: readonly QuestionSourceBindingRoute[];
  },
  state: CallerQuestionState | undefined,
  isCurrent: () => boolean,
) {
  const fingerprintRefused =
    !params.creatorFingerprint || params.callerFingerprint !== params.creatorFingerprint;
  return {
    kind: "source-bound" as const,
    sourceBindingRoutes: params.sourceBindingRoutes,
    assertCurrent: () => {
      try {
        params.assertSourceCurrent();
        if (state && params.caller) {
          if (!state.answerAuthority) {
            throw new Error("pending question has no prepared creator authority");
          }
          state.answerAuthority.assertCaller(params.caller);
        } else if (state && fingerprintRefused) {
          throw new Error("question answer caller policy does not match its creator");
        }
        if (state && !isCurrent()) {
          throw new Error("pending question is no longer current");
        }
        params.assertSourceCurrent();
      } catch (error) {
        throw new QuestionDispatchRefusedError(
          error instanceof Error ? error.message : "question answer authority refused",
          { cause: error },
        );
      }
    },
  };
}
