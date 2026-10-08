// A recorded delivery result must classify the transport it actually used, so a
// no-route (`none`) attempt is an intentional non-delivery rather than a failed
// obligation that can never be discharged (#154834).
import { describe, expect, it } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { recordAnnounceDeliveryResult } from "./subagent-registry-lifecycle-delivery.js";

function noRouteEntry() {
  return createSubagentRunRecord({
    runId: "run-none",
    expectsCompletionMessage: true,
    endedAt: 4_000,
  });
}

describe("recordAnnounceDeliveryResult no-route disposition", () => {
  it("resolves a non-delivered `none` path to intentional_non_delivery", () => {
    const entry = noRouteEntry();
    recordAnnounceDeliveryResult(
      entry,
      { delivered: false, path: "none" },
      new Map([[entry.runId, entry]]),
    );
    expect(entry.delivery?.disposition).toBe("intentional_non_delivery");
    // The no-sink marker stays for diagnostics; the disposition is what decides
    // that the row is not an outstanding obligation.
    expect(entry.delivery?.lastDropReason).toBe("sink_unavailable");
  });

  it("keeps a real transport failure retryable", () => {
    const entry = noRouteEntry();
    recordAnnounceDeliveryResult(
      entry,
      {
        delivered: false,
        path: "direct",
        error: "boom",
      },
      new Map([[entry.runId, entry]]),
    );
    expect(entry.delivery?.disposition).toBe("retryable");
    expect(entry.delivery?.lastDropReason).toBeUndefined();
  });

  it("preserves an explicit disposition over the path default", () => {
    const entry = noRouteEntry();
    recordAnnounceDeliveryResult(
      entry,
      {
        delivered: false,
        path: "none",
        disposition: "permanent_failure",
      },
      new Map([[entry.runId, entry]]),
    );
    expect(entry.delivery?.disposition).toBe("permanent_failure");
  });

  it("credits a delivered result", () => {
    const entry = noRouteEntry();
    recordAnnounceDeliveryResult(
      entry,
      { delivered: true, path: "direct" },
      new Map([[entry.runId, entry]]),
    );
    expect(entry.delivery?.disposition).toBe("delivered");
  });
});
