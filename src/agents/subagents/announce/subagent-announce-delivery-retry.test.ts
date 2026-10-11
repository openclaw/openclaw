// Regression coverage for the announce-delivery retryability contract: a given
// delivery error must resolve to exactly one retryability outcome. A
// writer-claim-rebound error is retryable (the retry loop in
// runAnnounceDeliveryWithRetry burns attempts on it), so the permanent
// classifier must not also claim it — otherwise exhausted retries are
// followed by the consumer skipping replay entirely.
import { describe, expect, it } from "vitest";
import { isPermanentAnnounceDeliveryError } from "./subagent-announce-delivery-retry.js";

function writerClaimReboundError(): Error {
  return Object.assign(
    new Error("session writer claim changed before transcript persistence"),
    { name: "SessionTranscriptWriterClaimReboundError" },
  );
}

describe("isPermanentAnnounceDeliveryError retryability contract", () => {
  it("does not classify a writer-claim-rebound error as permanent", () => {
    expect(isPermanentAnnounceDeliveryError(writerClaimReboundError())).toBe(false);
  });

  it("does not classify a nested writer-claim-rebound error as permanent", () => {
    expect(
      isPermanentAnnounceDeliveryError(
        new Error("outbound delivery failed", { cause: writerClaimReboundError() }),
      ),
    ).toBe(false);
  });

  it("does not classify a message-matched writer rebound as permanent", () => {
    expect(
      isPermanentAnnounceDeliveryError(
        new Error("requester turn failed: session writer claim changed before transcript persistence"),
      ),
    ).toBe(false);
  });

  it("still classifies genuine permanent failures as permanent", () => {
    expect(
      isPermanentAnnounceDeliveryError(
        new Error("outbound delivery failed", { cause: new Error("chat not found") }),
      ),
    ).toBe(true);
  });

  it("still classifies transient failures as non-permanent", () => {
    expect(isPermanentAnnounceDeliveryError(new Error("connect ECONNRESET"))).toBe(false);
  });
});
