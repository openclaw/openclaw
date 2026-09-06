import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../../announce-idempotency.js";
import { clearSubagentPendingDelivery } from "../registry/subagent-registry-lifecycle-delivery.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  clearRetainedCompletionHandoffKeysForTest,
  releaseAnnounceCompletionHandoffForChildRun,
  retainCompletionHandoffKey,
  settleCompletionHandoffRetention,
  shouldJoinOriginalCompletionHandoff,
} from "./subagent-announce-completion-handoff-retention.js";

vi.mock("./subagent-announce-delivery.runtime.js", () => ({
  isActiveEmbeddedRunId: vi.fn(() => false),
}));

describe("completion handoff retention lifecycle", () => {
  const childSessionKey = "agent:main:subagent:child";
  const childRunId = "child-run-1";
  const handoffKey = buildAnnounceIdempotencyKey(
    buildAnnounceIdFromChildRun({ childSessionKey, childRunId }),
  );

  beforeEach(() => {
    clearRetainedCompletionHandoffKeysForTest();
  });

  afterEach(() => {
    clearRetainedCompletionHandoffKeysForTest();
  });

  it("preserves retention across retryable pending attempts", () => {
    retainCompletionHandoffKey(handoffKey);
    expect(shouldJoinOriginalCompletionHandoff(handoffKey)).toBe(true);
    expect(shouldJoinOriginalCompletionHandoff(handoffKey)).toBe(true);

    settleCompletionHandoffRetention(handoffKey, {
      delivered: false,
      path: "direct",
      reason: "completion_handoff_pending",
      disposition: "retryable",
      terminal: true,
    });

    expect(shouldJoinOriginalCompletionHandoff(handoffKey)).toBe(true);
    expect(shouldJoinOriginalCompletionHandoff(handoffKey)).toBe(true);
  });

  it("releases retention on terminal non-retryable outcomes", () => {
    retainCompletionHandoffKey(handoffKey);
    settleCompletionHandoffRetention(handoffKey, {
      delivered: false,
      path: "none",
      reason: "requester_abandoned",
      error: "requester session abandoned after timeout",
    });
    expect(shouldJoinOriginalCompletionHandoff(handoffKey)).toBe(false);

    retainCompletionHandoffKey(handoffKey);
    settleCompletionHandoffRetention(handoffKey, {
      delivered: true,
      path: "direct",
    });
    expect(shouldJoinOriginalCompletionHandoff(handoffKey)).toBe(false);

    retainCompletionHandoffKey(handoffKey);
    settleCompletionHandoffRetention(handoffKey, {
      delivered: false,
      path: "direct",
      disposition: "permanent_failure",
      error: "hard fail",
    });
    expect(shouldJoinOriginalCompletionHandoff(handoffKey)).toBe(false);
  });

  it("releases retention when announce cleanup retires a child run", () => {
    retainCompletionHandoffKey(handoffKey);
    expect(shouldJoinOriginalCompletionHandoff(handoffKey)).toBe(true);

    releaseAnnounceCompletionHandoffForChildRun({ childSessionKey, childRunId });
    expect(shouldJoinOriginalCompletionHandoff(handoffKey)).toBe(false);

    retainCompletionHandoffKey(handoffKey);
    const entry = {
      runId: childRunId,
      childSessionKey,
      delivery: { status: "pending" },
    } as unknown as SubagentRunRecord;
    clearSubagentPendingDelivery(entry);
    expect(shouldJoinOriginalCompletionHandoff(handoffKey)).toBe(false);
  });
});
