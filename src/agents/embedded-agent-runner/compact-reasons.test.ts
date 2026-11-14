import { expect, it } from "vitest";
import { describeFailoverError, resolveFailoverReasonFromError } from "../failover-error.js";
import {
  classifyCompactionReason,
  isBenignCompactionSkipResult,
  isBenignCompactionSkipReason,
  resolveCompactionFailure,
} from "./compact-reasons.js";

const providerError = Object.assign(new Error("provider rejected the request"), {
  status: 429,
  code: "rate_limit_exceeded",
});
const safeguardCancellation = { reason: "Summarization could not finish.", error: providerError };

it("recovers provider classification through the generic wrapper", () => {
  const failure = resolveCompactionFailure({
    error: new Error("Error: Compaction cancelled"),
    safeguardCancellation,
  });
  expect(failure.reason).toBe(safeguardCancellation.reason);
  expect(describeFailoverError(failure.error)).toMatchObject({
    reason: "rate_limit",
    status: 429,
    code: "rate_limit_exceeded",
  });
});

it("does not classify an intentional decline from keywords in its display reason", () => {
  const reason = "Quality audit rejected a summary about a request timeout.";
  const failure = resolveCompactionFailure({
    error: new Error("Compaction cancelled"),
    safeguardCancellation: { reason },
  });
  expect(failure.reason).toContain("Quality audit rejected");
  expect(resolveFailoverReasonFromError(failure.error)).toBeNull();
});

it.each(["AbortError", "caller abort"])("preserves %s despite stale cancellation", (kind) => {
  const error = new Error("Compaction cancelled");
  if (kind === "AbortError") {
    error.name = kind;
  }
  const abortSignal = kind === "caller abort" ? AbortSignal.abort(error) : undefined;
  const failure = resolveCompactionFailure({ error, safeguardCancellation, abortSignal });
  expect(failure).toEqual({ reason: error.message, error });
  expect(failure.error).toBe(error);
  if (abortSignal) {
    expect(resolveFailoverReasonFromError(failure.error)).toBeNull();
  }
});

it.each([
  ['Authentication failed for "anthropic". Credentials may have expired.', "auth_failed"],
  ["Provider API error (429): too many requests", "provider_error_4xx"],
  ["OpenAI API error (500): upstream failed", "provider_error_5xx"],
])("classifies compaction failure %s", (reason, expected) => {
  expect(classifyCompactionReason(reason)).toBe(expected);
});

it("requires an explicit successful-result opt-in for empty transcripts", () => {
  const reason = "no real conversation messages";
  expect(isBenignCompactionSkipReason(reason)).toBe(false);
  expect(isBenignCompactionSkipResult({ ok: true, compacted: false, reason })).toBe(true);
  expect(isBenignCompactionSkipResult({ ok: false, compacted: false, reason })).toBe(false);
  expect(isBenignCompactionSkipResult({ ok: true, compacted: true, reason })).toBe(false);
});

it.each([undefined, "No API provider registered for api: ollama"])(
  "does not hide the failure reason %s",
  (reason) => {
    expect(isBenignCompactionSkipResult({ ok: true, compacted: false, reason })).toBe(false);
  },
);
