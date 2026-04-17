import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSubagentAnnounceCountersForTest } from "./subagent-announce-counters.js";

// Mock runtime module — runAnnounceDeliveryWithRetry does not touch it directly,
// but importing the delivery module pulls the runtime barrel in.
vi.mock("./subagent-announce-delivery.runtime.js", () => ({
  callGateway: vi.fn(),
  createBoundDeliveryRouter: () => ({
    resolveDestination: () => ({ mode: "direct" }),
  }),
  getGlobalHookRunner: () => undefined,
  isEmbeddedPiRunActive: () => false,
  loadConfig: () => ({ session: { mainKey: "main", scope: "per-sender" } }),
  loadSessionStore: () => ({}),
  queueEmbeddedPiMessage: () => false,
  resolveAgentIdFromSessionKey: () => "main",
  resolveConversationIdFromTargets: () => "",
  resolveExternalBestEffortDeliveryTarget: () => ({ deliver: false }),
  resolveQueueSettings: () => ({ mode: "direct" }),
  resolveStorePath: () => "/tmp/sessions-main.json",
}));

import {
  AnnounceRetryBudgetExhaustedError,
  runAnnounceDeliveryWithRetry,
} from "./subagent-announce-delivery.js";

describe("runAnnounceDeliveryWithRetry", () => {
  beforeEach(() => {
    resetSubagentAnnounceCountersForTest();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.OPENCLAW_ANNOUNCE_RETRY_BUDGET_MS;
  });

  it("returns the result on first success without retrying", async () => {
    const run = vi.fn(async () => "ok");
    const result = await runAnnounceDeliveryWithRetry({
      operation: "test-op",
      run,
    });
    expect(result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries transient gateway timeout and eventually succeeds", async () => {
    let attempts = 0;
    const run = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("gateway timeout after 30000ms");
      }
      return "ok";
    });
    const result = await runAnnounceDeliveryWithRetry({
      operation: "test-retry-success",
      run,
    });
    expect(result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("stops retrying with permanent error when budget is exhausted", async () => {
    // Set a tiny budget so the next sleep exceeds it. Combined with
    // OPENCLAW_TEST_FAST retry delays [8, 16, 32] ms, a 5ms budget causes
    // the first retry-sleep (8ms) to overrun.
    process.env.OPENCLAW_ANNOUNCE_RETRY_BUDGET_MS = "5";
    const run = vi.fn(async () => {
      throw new Error("gateway timeout after 30000ms");
    });

    await expect(
      runAnnounceDeliveryWithRetry({
        operation: "test-budget",
        run,
      }),
    ).rejects.toBeInstanceOf(AnnounceRetryBudgetExhaustedError);

    // The budget-exhausted error message must mention "budget exhausted" so
    // outer layers classify it as permanent.
    await expect(
      runAnnounceDeliveryWithRetry({
        operation: "test-budget-msg",
        run,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("budget exhausted"),
    });
  });

  it("does not retry on non-transient errors even if budget remains", async () => {
    process.env.OPENCLAW_ANNOUNCE_RETRY_BUDGET_MS = "60000";
    const run = vi.fn(async () => {
      throw new Error("unsupported channel foo");
    });

    await expect(
      runAnnounceDeliveryWithRetry({
        operation: "test-permanent",
        run,
      }),
    ).rejects.toThrow(/unsupported channel/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("aborts retry when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async () => "ok");
    await expect(
      runAnnounceDeliveryWithRetry({
        operation: "test-abort",
        signal: controller.signal,
        run,
      }),
    ).rejects.toThrow(/aborted/);
    expect(run).not.toHaveBeenCalled();
  });
});
