import { Guard } from "typebox/guard";

/** Provider-authored findings; continuation is offered only after explicit user review. */
export type ProviderRefusalReview = {
  explanation: string;
  continuation?: { message: string };
  errorType?: string;
};

const encoder = new TextEncoder();

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxBytes &&
    value.trim().length > 0 &&
    encoder.encode(value).byteLength <= maxBytes
  );
}

/** Keep exact provider text. Truncation must never make an invalid continuation usable. */
export function readProviderRefusalReview(value: unknown): ProviderRefusalReview | undefined {
  if (!Guard.IsObjectNotArray(value) || !isBoundedText(value.explanation, 64 * 1024)) {
    return undefined;
  }
  const continuation = Guard.IsObjectNotArray(value.continuation)
    ? value.continuation.message
    : undefined;
  return {
    explanation: value.explanation,
    ...(isBoundedText(continuation, 1024) ? { continuation: { message: continuation } } : {}),
    ...(typeof value.errorType === "string" && value.errorType.trim()
      ? { errorType: value.errorType }
      : {}),
  };
}
