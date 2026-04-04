import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enqueueAnnounce,
  maybeSendAnnounceCollectEmptySummary,
  resetAnnounceQueuesForTests,
  resolveAnnounceCollectEmptySummaryTarget,
} from "./subagent-announce-queue.js";

type CollectEmptySummaryQueue = Parameters<typeof maybeSendAnnounceCollectEmptySummary>[0]["queue"];

type SentItem = {
  execution: { agentPrompt: string };
  display: { text?: string; summaryLine?: string };
};

function createRetryingSend() {
  const prompts: string[] = [];
  let attempts = 0;
  let resolved = false;
  let resolveSecondAttempt = () => {};
  const waitForSecondAttempt = new Promise<void>((resolve) => {
    resolveSecondAttempt = resolve;
  });

  const send = vi.fn(async (item: SentItem) => {
    attempts += 1;
    prompts.push(item.display.text ?? item.display.summaryLine ?? item.execution.agentPrompt);
    if (attempts >= 2 && !resolved) {
      resolved = true;
      resolveSecondAttempt();
    }
    if (attempts === 1) {
      throw new Error("gateway timeout after 60000ms");
    }
  });

  return { send, prompts, waitForSecondAttempt };
}

function getSentItem(send: { mock: { calls: SentItem[][] } }, index: number): SentItem {
  const call = send.mock.calls.at(index);
  expect(call).toBeDefined();
  if (!call) {
    throw new Error(`expected send.mock.calls[${index}] to exist`);
  }
  const [item] = call;
  expect(item).toBeDefined();
  if (!item) {
    throw new Error(`expected send.mock.calls[${index}][0] to exist`);
  }
  return item;
}

describe("subagent-announce-queue", () => {
  it("reuses the last safe summary target when forced collect drain empties the queue", () => {
    const lastSummaryTarget = {
      execution: { visibility: "internal", agentPrompt: "internal" },
      display: { visibility: "summary-only", summaryLine: "safe summary" },
      enqueuedAt: 1,
      sessionKey: "agent:main:telegram:dm:u1",
      origin: { channel: "telegram", to: "telegram:1" },
      originKey: "telegram:telegram:1",
    } as const;

    expect(resolveAnnounceCollectEmptySummaryTarget({ items: [], lastSummaryTarget })).toEqual(
      lastSummaryTarget,
    );
  });

  it("does not reuse a stale summary target when summarized drops span multiple origins", () => {
    const lastSummaryTarget = {
      execution: { visibility: "internal", agentPrompt: "internal" },
      display: { visibility: "summary-only", summaryLine: "safe summary" },
      enqueuedAt: 1,
      sessionKey: "agent:main:telegram:dm:u1",
      origin: { channel: "telegram", to: "telegram:1" },
      originKey: "telegram:telegram:1",
    } as const;

    expect(
      resolveAnnounceCollectEmptySummaryTarget({
        items: [],
        lastSummaryTarget,
        summaryOverflowOriginKey: null,
      }),
    ).toBeUndefined();
  });

  it("sends collect-empty overflow summaries using the last safe summary target", async () => {
    const send = vi.fn(async () => {});
    const queue: CollectEmptySummaryQueue = {
      items: [],
      dropPolicy: "summarize",
      droppedCount: 1,
      summaryLines: ["first safe summary"],
      lastSummaryTarget: {
        announceId: "ann-prev",
        execution: { visibility: "internal", agentPrompt: "internal" },
        display: { visibility: "summary-only", summaryLine: "second safe summary" },
        enqueuedAt: 1,
        sessionKey: "agent:main:telegram:dm:u1",
        origin: { channel: "telegram", to: "telegram:2" },
        originKey: "telegram:telegram:2",
        internalEvents: [{ type: "task_completion" } as never],
      },
    };

    await expect(maybeSendAnnounceCollectEmptySummary({ queue, send })).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const sent = getSentItem(send, 0);
    expect(sent.display.text).toContain("[Queue overflow]");
    expect(sent.display.text).toContain("first safe summary");
    expect((sent as { announceId?: string }).announceId).toBeUndefined();
    expect((sent as { enqueuedAt?: number }).enqueuedAt).not.toBe(1);
    expect((sent as { internalEvents?: unknown[] }).internalEvents).toBeUndefined();
    expect(queue.droppedCount).toBe(0);
    expect(queue.summaryLines).toEqual([]);
  });

  it("drops ambiguous collect-empty summaries instead of sending them to the wrong origin", async () => {
    const send = vi.fn(async () => {});
    const queue: CollectEmptySummaryQueue = {
      items: [],
      dropPolicy: "summarize",
      droppedCount: 2,
      summaryLines: ["first summary", "second summary"],
      lastSummaryTarget: {
        execution: { visibility: "internal", agentPrompt: "internal" },
        display: { visibility: "summary-only", summaryLine: "safe summary" },
        enqueuedAt: 1,
        sessionKey: "agent:main:telegram:dm:u1",
        origin: { channel: "telegram", to: "telegram:2" },
        originKey: "telegram:telegram:2",
      },
      summaryOverflowOriginKey: null,
    };

    await expect(maybeSendAnnounceCollectEmptySummary({ queue, send })).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(queue.droppedCount).toBe(0);
    expect(queue.summaryLines).toEqual([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAnnounceQueuesForTests();
  });

  it("retries failed sends without dropping queued announce items", async () => {
    const sender = createRetryingSend();

    enqueueAnnounce({
      key: "announce:test:retry",
      item: {
        execution: { visibility: "internal", agentPrompt: "subagent completed" },
        display: { visibility: "user-visible", text: "subagent completed" },
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0 },
      send: sender.send,
    });

    await sender.waitForSecondAttempt;
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.prompts).toEqual(["subagent completed", "subagent completed"]);
  });

  it("preserves queue summary state across failed summary delivery retries", async () => {
    const sender = createRetryingSend();

    enqueueAnnounce({
      key: "announce:test:summary-retry",
      item: {
        execution: { visibility: "internal", agentPrompt: "first result" },
        display: { visibility: "user-visible", text: "first result", summaryLine: "first result" },
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send: sender.send,
    });
    enqueueAnnounce({
      key: "announce:test:summary-retry",
      item: {
        execution: { visibility: "internal", agentPrompt: "second result" },
        display: {
          visibility: "user-visible",
          text: "second result",
          summaryLine: "second result",
        },
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send: sender.send,
    });

    await sender.waitForSecondAttempt;
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.prompts[0]).toContain("[Queue overflow]");
    expect(sender.prompts[1]).toContain("[Queue overflow]");
  });

  it("retries collect-mode batches without losing queued items", async () => {
    const sender = createRetryingSend();

    enqueueAnnounce({
      key: "announce:test:collect-retry",
      item: {
        execution: { visibility: "internal", agentPrompt: "worker trigger one" },
        display: { visibility: "user-visible", text: "queued item one" },
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send: sender.send,
    });
    enqueueAnnounce({
      key: "announce:test:collect-retry",
      item: {
        execution: { visibility: "internal", agentPrompt: "worker trigger two" },
        display: { visibility: "user-visible", text: "queued item two" },
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send: sender.send,
    });

    await sender.waitForSecondAttempt;
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.prompts[0]).toContain("Queued #1");
    expect(sender.prompts[0]).toContain("queued item one");
    expect(sender.prompts[0]).toContain("Queued #2");
    expect(sender.prompts[0]).toContain("queued item two");
    expect(sender.prompts[1]).toContain("Queued #1");
    expect(sender.prompts[1]).toContain("queued item one");
    expect(sender.prompts[1]).toContain("Queued #2");
    expect(sender.prompts[1]).toContain("queued item two");
    expect(sender.prompts[0]).not.toContain("worker trigger one");
    expect(sender.prompts[0]).not.toContain("worker trigger two");
  });

  it("renders summary-only announce batches from summaryLine only", async () => {
    const sender = createRetryingSend();

    enqueueAnnounce({
      key: "announce:test:collect-summary-only",
      item: {
        execution: { visibility: "internal", agentPrompt: "internal trigger one" },
        display: {
          visibility: "summary-only",
          text: "hidden text one",
          summaryLine: "safe summary one",
        },
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send: sender.send,
    });
    enqueueAnnounce({
      key: "announce:test:collect-summary-only",
      item: {
        execution: { visibility: "internal", agentPrompt: "internal trigger two" },
        display: {
          visibility: "summary-only",
          text: "hidden text two",
          summaryLine: "safe summary two",
        },
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send: sender.send,
    });

    await sender.waitForSecondAttempt;
    expect(sender.prompts[0]).toContain("safe summary one");
    expect(sender.prompts[0]).toContain("safe summary two");
    expect(sender.prompts[0]).not.toContain("hidden text one");
    expect(sender.prompts[0]).not.toContain("hidden text two");
    expect(sender.prompts[0]).not.toContain("internal trigger one");
    expect(sender.prompts[0]).not.toContain("internal trigger two");
  });

  it("falls back to individual collect drain after invalid display batch render failure", async () => {
    const send = vi.fn(async () => {});

    enqueueAnnounce({
      key: "announce:test:collect-invalid-display",
      item: {
        execution: { visibility: "internal", agentPrompt: "first internal" },
        display: { visibility: "user-visible", text: "first visible" },
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send,
    });
    enqueueAnnounce({
      key: "announce:test:collect-invalid-display",
      item: {
        execution: { visibility: "internal", agentPrompt: "second internal" },
        display: { visibility: "summary-only" },
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send,
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
    const firstSent = getSentItem(send, 0);
    const secondSent = getSentItem(send, 1);
    expect(firstSent.display.text).toBe("first visible");
    expect(secondSent.display.summaryLine).toBeUndefined();
    expect(secondSent.execution.agentPrompt).toBe("second internal");
  });

  it("keeps individual-drain fallback across retries after collect render failure", async () => {
    const prompts: string[] = [];
    let attempts = 0;
    let resolved = false;
    let resolveSecondAttempt = () => {};
    const waitForSecondAttempt = new Promise<void>((resolve) => {
      resolveSecondAttempt = resolve;
    });

    const send = vi.fn(
      async (item: { execution: { agentPrompt: string }; display: { text?: string } }) => {
        attempts += 1;
        prompts.push(item.display.text ?? item.execution.agentPrompt);
        if (attempts >= 3 && !resolved) {
          resolved = true;
          resolveSecondAttempt();
        }
        if (attempts === 2) {
          throw new Error("transient send failure after collect fallback");
        }
      },
    );

    enqueueAnnounce({
      key: "announce:test:collect-invalid-display-retry",
      item: {
        execution: { visibility: "internal", agentPrompt: "first internal" },
        display: { visibility: "user-visible", text: "first visible" },
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send,
    });
    enqueueAnnounce({
      key: "announce:test:collect-invalid-display-retry",
      item: {
        execution: { visibility: "internal", agentPrompt: "second internal" },
        display: { visibility: "summary-only" },
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send,
    });

    await waitForSecondAttempt;
    expect(send).toHaveBeenCalledTimes(3);
    expect(prompts[0]).toBe("first visible");
    expect(prompts[1]).toBe("second internal");
    expect(prompts[2]).toBe("second internal");
    expect(prompts.join("\n")).not.toContain("Queued #1");
    expect(prompts.join("\n")).not.toContain("Queued #2");
  });

  it("uses a safe placeholder when summarizing dropped summary-only announce items without summaryLine", async () => {
    const send = vi.fn(async () => {});

    expect(() =>
      enqueueAnnounce({
        key: "announce:test:summary-only-drop-fallback",
        item: {
          execution: { visibility: "internal", agentPrompt: "hidden fallback prompt" },
          display: { visibility: "summary-only" },
          enqueuedAt: Date.now(),
          sessionKey: "agent:main:telegram:dm:u1",
        },
        settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
        send,
      }),
    ).not.toThrow();

    expect(() =>
      enqueueAnnounce({
        key: "announce:test:summary-only-drop-fallback",
        item: {
          execution: { visibility: "internal", agentPrompt: "second internal" },
          display: {
            visibility: "user-visible",
            text: "second visible",
            summaryLine: "second visible",
          },
          enqueuedAt: Date.now(),
          sessionKey: "agent:main:telegram:dm:u1",
        },
        settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
        send,
      }),
    ).not.toThrow();

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    const overflowSent = getSentItem(send, 0);
    const overflowSummary = overflowSent.display.text ?? "";
    expect(overflowSummary).toContain("[Queue overflow]");
    expect(overflowSummary).toContain("[summary unavailable]");
    expect(overflowSummary).not.toContain("hidden fallback prompt");
  });

  it("does not summarize dropped user-visible announce items from execution.agentPrompt when display text is missing", async () => {
    const send = vi.fn(async () => {});

    enqueueAnnounce({
      key: "announce:test:user-visible-drop-fallback",
      item: {
        execution: { visibility: "internal", agentPrompt: "hidden execution fallback" },
        display: { visibility: "user-visible" },
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send,
    });
    enqueueAnnounce({
      key: "announce:test:user-visible-drop-fallback",
      item: {
        execution: { visibility: "internal", agentPrompt: "second internal" },
        display: {
          visibility: "user-visible",
          text: "second visible",
          summaryLine: "second visible",
        },
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send,
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    const overflowSent = getSentItem(send, 0);
    const overflowSummary = overflowSent.display.text ?? "";
    expect(overflowSummary).toContain("[Queue overflow]");
    expect(overflowSummary).toContain("[summary unavailable]");
    expect(overflowSummary).not.toContain("hidden execution fallback");
  });

  it("emits summarize overflow before exiting forced individual collect drain", async () => {
    const send = vi.fn(async () => {});

    enqueueAnnounce({
      key: "announce:test:forced-individual-overflow-summary",
      item: {
        execution: { visibility: "internal", agentPrompt: "first internal" },
        display: { visibility: "user-visible", text: "first visible" },
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send,
    });
    enqueueAnnounce({
      key: "announce:test:forced-individual-overflow-summary",
      item: {
        execution: { visibility: "internal", agentPrompt: "invalid summary-only" },
        display: { visibility: "summary-only" },
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send,
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });

    const prompts = send.mock.calls.map((_, index) => {
      const item = getSentItem(send, index);
      return item.display.text ?? item.display.summaryLine ?? item.execution.agentPrompt ?? "";
    });
    expect(prompts[0]).toContain("[Queue overflow]");
    expect(prompts[0]).toContain("first visible");
    expect(prompts).toHaveLength(2);
  });

  it("uses debounce floor for retries when debounce exceeds backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const previousFast = process.env.OPENCLAW_TEST_FAST;
    delete process.env.OPENCLAW_TEST_FAST;

    try {
      const attempts: number[] = [];
      const send = vi.fn(async () => {
        attempts.push(Date.now());
        if (attempts.length === 1) {
          throw new Error("transient timeout");
        }
      });

      enqueueAnnounce({
        key: "announce:test:retry-debounce-floor",
        item: {
          execution: { visibility: "internal", agentPrompt: "subagent completed" },
          display: { visibility: "user-visible", text: "subagent completed" },
          enqueuedAt: Date.now(),
          sessionKey: "agent:main:telegram:dm:u1",
        },
        settings: { mode: "followup", debounceMs: 5_000 },
        send,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(2);
      const [firstAttempt, secondAttempt] = attempts;
      if (firstAttempt === undefined || secondAttempt === undefined) {
        throw new Error("expected two retry attempts");
      }
      expect(secondAttempt - firstAttempt).toBeGreaterThanOrEqual(5_000);
    } finally {
      if (previousFast === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousFast;
      }
    }
  });
});
