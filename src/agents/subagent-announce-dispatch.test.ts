import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnnounceIdFromChildRun } from "./announce-idempotency.js";
import {
  __testing as dispatchTesting,
  mapQueueOutcomeToDeliveryResult,
  runSubagentAnnounceDispatch,
} from "./subagent-announce-dispatch.js";

describe("mapQueueOutcomeToDeliveryResult", () => {
  it("maps steered to delivered", () => {
    expect(mapQueueOutcomeToDeliveryResult("steered")).toEqual({
      delivered: true,
      path: "steered",
    });
  });

  it("maps queued to delivered", () => {
    expect(mapQueueOutcomeToDeliveryResult("queued")).toEqual({
      delivered: true,
      path: "queued",
    });
  });

  it("maps none to not-delivered", () => {
    expect(mapQueueOutcomeToDeliveryResult("none")).toEqual({
      delivered: false,
      path: "none",
    });
  });
});

describe("runSubagentAnnounceDispatch", () => {
  afterEach(() => {
    dispatchTesting.setDepsForTest();
  });

  async function runNonCompletionDispatch(params: {
    queueOutcome: "none" | "queued" | "steered";
    directDelivered?: boolean;
  }) {
    const queue = vi.fn(async () => params.queueOutcome);
    const direct = vi.fn(async () => ({
      delivered: params.directDelivered ?? true,
      path: "direct" as const,
    }));
    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: false,
      queue,
      direct,
    });
    return { queue, direct, result };
  }

  it("uses queue-first ordering for non-completion mode", async () => {
    const { queue, direct, result } = await runNonCompletionDispatch({ queueOutcome: "none" });

    expect(queue).toHaveBeenCalledTimes(1);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(true);
    expect(result.path).toBe("direct");
    expect(result.phases).toEqual([
      { phase: "queue-primary", delivered: false, path: "none", error: undefined },
      { phase: "direct-primary", delivered: true, path: "direct", error: undefined },
    ]);
  });

  it("short-circuits direct send when non-completion queue delivers", async () => {
    const { queue, direct, result } = await runNonCompletionDispatch({ queueOutcome: "queued" });

    expect(queue).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(result.path).toBe("queued");
    expect(result.phases).toEqual([
      { phase: "queue-primary", delivered: true, path: "queued", error: undefined },
    ]);
  });

  it("uses queue-first ordering for completion mode", async () => {
    const queue = vi.fn(async () => "queued" as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      queue,
      direct,
    });

    expect(queue).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(result.path).toBe("queued");
    expect(result.phases).toEqual([
      { phase: "queue-primary", delivered: true, path: "queued", error: undefined },
    ]);
  });

  it("falls back to direct when completion queue cannot deliver", async () => {
    const queue = vi.fn(async () => "none" as const);
    const direct = vi.fn(async () => ({
      delivered: true,
      path: "direct" as const,
    }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      queue,
      direct,
    });

    expect(queue).toHaveBeenCalledTimes(1);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(result.path).toBe("direct");
    expect(result.phases).toEqual([
      { phase: "queue-primary", delivered: false, path: "none", error: undefined },
      { phase: "direct-primary", delivered: true, path: "direct", error: undefined },
    ]);
  });

  it("returns direct failure when completion direct fallback cannot deliver", async () => {
    const queue = vi.fn(async () => "none" as const);
    const direct = vi.fn(async () => ({
      delivered: false,
      path: "direct" as const,
      error: "failed",
    }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      queue,
      direct,
    });

    expect(result).toMatchObject({
      delivered: false,
      path: "direct",
      error: "failed",
    });
    expect(result.phases).toEqual([
      { phase: "queue-primary", delivered: false, path: "none", error: undefined },
      { phase: "direct-primary", delivered: false, path: "direct", error: "failed" },
    ]);
  });

  it("does not fall through to direct delivery when non-completion queue drops the new item", async () => {
    const queue = vi.fn(async () => "dropped" as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: false,
      queue,
      direct,
    });

    expect(queue).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(result).toEqual({
      delivered: false,
      path: "none",
      phases: [{ phase: "queue-primary", delivered: false, path: "none", error: undefined }],
    });
  });

  it("preserves queue result when completion dispatch aborts before direct fallback", async () => {
    const controller = new AbortController();
    const queue = vi.fn(async () => {
      controller.abort();
      return "none" as const;
    });
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      signal: controller.signal,
      queue,
      direct,
    });

    expect(queue).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      delivered: false,
      path: "none",
    });
    expect(result.phases).toEqual([
      {
        phase: "queue-primary",
        delivered: false,
        path: "none",
        error: undefined,
      },
    ]);
  });

  it("returns none immediately when signal is already aborted", async () => {
    const queue = vi.fn(async () => "none" as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));
    const controller = new AbortController();
    controller.abort();

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      signal: controller.signal,
      queue,
      direct,
    });

    expect(queue).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
    expect(result).toEqual({
      delivered: false,
      path: "none",
      phases: [],
    });
  });

  it("short-circuits when the announce was already delivered", async () => {
    const announceId = buildAnnounceIdFromChildRun({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-1",
    });
    dispatchTesting.setDepsForTest({
      getRuns: () =>
        new Map([
          [
            "run-1",
            {
              runId: "run-1",
              childSessionKey: "agent:main:subagent:worker",
              requesterSessionKey: "agent:main:main",
              requesterDisplayKey: "main",
              task: "task",
              cleanup: "keep",
              createdAt: 1,
              completionAnnouncedAt: 10,
              deliveryClaim: {
                announceId,
                state: "delivered",
                token: "token-1",
                path: "queued",
                claimedAt: 5,
                updatedAt: 10,
              },
            },
          ],
        ]),
      persist: vi.fn(),
    });
    const queue = vi.fn(async () => "queued" as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      announceId,
      expectsCompletionMessage: true,
      queue,
      direct,
    });

    expect(queue).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
    expect(result).toEqual({
      delivered: true,
      path: "queued",
      phases: [],
    });
  });

  it("rejects a concurrent in-flight announce claim", async () => {
    const announceId = buildAnnounceIdFromChildRun({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-2",
    });
    dispatchTesting.setDepsForTest({
      getRuns: () =>
        new Map([
          [
            "run-2",
            {
              runId: "run-2",
              childSessionKey: "agent:main:subagent:worker",
              requesterSessionKey: "agent:main:main",
              requesterDisplayKey: "main",
              task: "task",
              cleanup: "keep",
              createdAt: 1,
              deliveryClaim: {
                announceId,
                state: "claimed",
                token: "token-2",
                path: "none",
                claimedAt: 5,
                updatedAt: 5,
              },
            },
          ],
        ]),
      now: () => 10,
      persist: vi.fn(),
    });
    const queue = vi.fn(async () => "queued" as const);
    const direct = vi.fn(async () => ({ delivered: true, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      announceId,
      expectsCompletionMessage: true,
      queue,
      direct,
    });

    expect(queue).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
    expect(result).toEqual({
      delivered: false,
      path: "none",
      error: "delivery-already-in-flight",
      phases: [],
    });
  });
});
