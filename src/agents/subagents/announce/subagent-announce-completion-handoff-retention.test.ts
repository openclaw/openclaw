import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
  buildRequesterSettleAnnounceId,
} from "../../announce-idempotency.js";
import { clearSubagentPendingDelivery } from "../registry/subagent-registry-lifecycle-delivery.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  clearRetainedCompletionHandoffKeysForTest,
  releaseAnnounceCompletionHandoffForChildRun,
  releaseAnnounceCompletionHandoffForRequesterSettleBatch,
  resolvePendingGatewayCompletionHandoff,
  settleCompletionHandoffRetention,
  shouldPreferOriginalCompletionHandoff,
} from "./subagent-announce-completion-handoff-retention.js";

vi.mock("../../embedded-agent-runner/runs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../embedded-agent-runner/runs.js")>();
  return {
    ...actual,
    isActiveEmbeddedRunId: vi.fn(() => false),
  };
});

describe("completion handoff retention lifecycle", () => {
  const childSessionKey = "agent:main:subagent:child";
  const childRunId = "child-run-1";
  const handoffKey = buildAnnounceIdempotencyKey(
    buildAnnounceIdFromChildRun({ childSessionKey, childRunId }),
  );

  function retain(key: string) {
    resolvePendingGatewayCompletionHandoff({
      parentOnly: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: key,
    });
  }

  function isRetained(key: string) {
    return shouldPreferOriginalCompletionHandoff({ directIdempotencyKey: key });
  }

  beforeEach(() => {
    clearRetainedCompletionHandoffKeysForTest();
  });

  afterEach(() => {
    clearRetainedCompletionHandoffKeysForTest();
  });

  it("preserves retention across retryable pending attempts", () => {
    retain(handoffKey);
    expect(isRetained(handoffKey)).toBe(true);
    expect(isRetained(handoffKey)).toBe(true);

    settleCompletionHandoffRetention(handoffKey, {
      delivered: false,
      path: "direct",
      reason: "completion_handoff_pending",
      disposition: "retryable",
      terminal: true,
    });

    expect(isRetained(handoffKey)).toBe(true);
    expect(isRetained(handoffKey)).toBe(true);
  });

  it("fences retryable replay failures while the original handoff is retained", () => {
    retain(handoffKey);

    const fenced = settleCompletionHandoffRetention(handoffKey, {
      delivered: false,
      path: "direct",
      error: "original handoff replay failed",
      disposition: "retryable",
    });

    expect(fenced).toMatchObject({
      delivered: false,
      path: "direct",
      disposition: "retryable",
      terminal: true,
      error: "original handoff replay failed",
    });
    expect(isRetained(handoffKey)).toBe(true);

    // First-attempt failures with no retained ownership stay unfenced so
    // ordinary steer-fallback can still run.
    clearRetainedCompletionHandoffKeysForTest();
    const unfenced = settleCompletionHandoffRetention(handoffKey, {
      delivered: false,
      path: "direct",
      error: "transient network error",
      disposition: "retryable",
    });
    expect(unfenced.terminal).toBeUndefined();
  });

  it("releases retention on terminal non-retryable outcomes", () => {
    retain(handoffKey);
    settleCompletionHandoffRetention(handoffKey, {
      delivered: false,
      path: "none",
      reason: "requester_abandoned",
      error: "requester session abandoned after timeout",
    });
    expect(isRetained(handoffKey)).toBe(false);

    retain(handoffKey);
    settleCompletionHandoffRetention(handoffKey, {
      delivered: true,
      path: "direct",
    });
    expect(isRetained(handoffKey)).toBe(false);

    retain(handoffKey);
    settleCompletionHandoffRetention(handoffKey, {
      delivered: false,
      path: "direct",
      disposition: "permanent_failure",
      error: "hard fail",
    });
    expect(isRetained(handoffKey)).toBe(false);
  });

  it("releases retention when announce cleanup retires a child run", () => {
    retain(handoffKey);
    expect(isRetained(handoffKey)).toBe(true);

    releaseAnnounceCompletionHandoffForChildRun({ childSessionKey, childRunId });
    expect(isRetained(handoffKey)).toBe(false);

    retain(handoffKey);
    const entry = {
      runId: childRunId,
      childSessionKey,
      delivery: { status: "pending" },
    } as unknown as SubagentRunRecord;
    clearSubagentPendingDelivery(entry);
    expect(isRetained(handoffKey)).toBe(false);
  });

  it("releases requester-settle retention when a settle batch retires", () => {
    const batchRunIds = ["run-a", "run-b"];
    const baseKey = buildAnnounceIdempotencyKey(
      buildRequesterSettleAnnounceId({
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:main",
        batchRunIds,
      }),
    );
    const retryKey = buildAnnounceIdempotencyKey(
      buildRequesterSettleAnnounceId({
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:main",
        batchRunIds,
        attemptIndex: 1,
      }),
    );
    const yieldKey = buildAnnounceIdempotencyKey(
      buildRequesterSettleAnnounceId({
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:main",
        batchRunIds: ["run-b"],
        rearmGeneration: 1,
      }),
    );

    retain(baseKey);
    retain(retryKey);
    retain(yieldKey);
    expect(isRetained(baseKey)).toBe(true);
    expect(isRetained(retryKey)).toBe(true);
    expect(isRetained(yieldKey)).toBe(true);

    releaseAnnounceCompletionHandoffForRequesterSettleBatch({
      requesterAgentId: "main",
      requesterSessionKey: "agent:main:main",
      batchRunIds,
    });
    expect(isRetained(baseKey)).toBe(false);
    expect(isRetained(retryKey)).toBe(false);
    // Different yield/batch identity must stay retained until that batch retires.
    expect(isRetained(yieldKey)).toBe(true);

    releaseAnnounceCompletionHandoffForRequesterSettleBatch({
      requesterAgentId: "main",
      requesterSessionKey: "agent:main:main",
      batchRunIds: ["run-b"],
      rearmGeneration: 1,
    });
    expect(isRetained(yieldKey)).toBe(false);
  });

  it("maps pending Gateway responses into undelivered retained custody", () => {
    expect(
      resolvePendingGatewayCompletionHandoff({
        parentOnly: false,
        expectsCompletionMessage: true,
        directIdempotencyKey: handoffKey,
      }),
    ).toMatchObject({
      delivered: false,
      reason: "completion_handoff_pending",
      disposition: "retryable",
      terminal: true,
    });
    expect(isRetained(handoffKey)).toBe(true);
    expect(
      shouldPreferOriginalCompletionHandoff({
        directIdempotencyKey: handoffKey,
        requesterRunId: "successor",
      }),
    ).toBe(true);
  });
});
