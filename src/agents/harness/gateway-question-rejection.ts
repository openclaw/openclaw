const TERMINAL_QUESTION_ERROR_REASONS = new Set([
  "QUESTION_ALREADY_TERMINAL",
  "QUESTION_NOT_FOUND",
]);

const QUESTION_INVALID_ANSWER_REASON = "QUESTION_INVALID_ANSWER";

export function readQuestionRejection(
  error: unknown,
): { code: unknown; reason?: string } | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  // SAFETY: the guard above proves error is a non-null object, and every field named here stays optional unknown.
  const requestError = error as { details?: unknown; name?: unknown; gatewayCode?: unknown };
  if (requestError.name !== "GatewayClientRequestError") {
    return undefined;
  }
  const details = requestError.details;
  const detailsIsRecord = details && typeof details === "object" && !Array.isArray(details);
  // SAFETY: detailsIsRecord proves details is a non-null, non-array object, and reason stays optional unknown.
  const reason = detailsIsRecord ? (details as { reason?: unknown }).reason : undefined;
  return {
    code: requestError.gatewayCode,
    reason: typeof reason === "string" ? reason : undefined,
  };
}

export function isTerminalAgentQuestionError(error: unknown): boolean {
  const reason = readQuestionRejection(error)?.reason;
  return reason !== undefined && TERMINAL_QUESTION_ERROR_REASONS.has(reason);
}

/**
 * Answer validation runs before `question.resolve` commits, so a rejected answer
 * leaves the question pending and the sender can still correct it. Callers that
 * own a user-visible surface read this to explain the rejection instead of
 * failing their own dispatch with an unhandled gateway error, which the ingress
 * would retry into the same rejection without ever reaching the sender.
 */
export function readQuestionAnswerRejection(error: unknown): { detail?: string } | undefined {
  const rejection = readQuestionRejection(error);
  if (
    rejection?.code !== "INVALID_REQUEST" ||
    rejection.reason !== QUESTION_INVALID_ANSWER_REASON
  ) {
    return undefined;
  }
  // The manager names the offending question in the message; the structured
  // reason only carries the code.
  const detail = error instanceof Error ? error.message.trim() : "";
  return detail ? { detail } : {};
}
