import { expect, it } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { resolveAnnounceDeliveryDeadline } from "./subagent-registry-cleanup.js";

it("honors a redriven completion at its delivery deadline", () => {
  const now = 2_000;
  const entry = createSubagentRunRecord({
    runId: "run-1",
    endedAt: now - 60 * 60_000,
    delivery: { status: "pending", windowStartedAt: now - 1_000, deadlineAt: now },
  });
  expect(resolveAnnounceDeliveryDeadline(entry, now)).toBe(now);
});
