import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueAnnounce, resetAnnounceQueuesForTests } from "./subagent-announce-queue.js";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

describe("subagent-announce-queue", () => {
  afterEach(() => {
    resetAnnounceQueuesForTests();
  });

  it("retries failed sends without dropping queued announce items", async () => {
    const sendPrompts: string[] = [];
    let attempts = 0;
    const send = vi.fn(async (item: { prompt: string }) => {
      attempts += 1;
      sendPrompts.push(item.prompt);
      if (attempts === 1) {
        throw new Error("gateway timeout after 60000ms");
      }
    });

    enqueueAnnounce({
      key: "announce:test:retry",
      item: {
        prompt: "subagent completed",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0 },
      send,
    });

    await waitFor(() => attempts >= 2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sendPrompts).toEqual(["subagent completed", "subagent completed"]);
  });

  it("preserves queue summary state across failed summary delivery retries", async () => {
    const sendPrompts: string[] = [];
    let attempts = 0;
    const send = vi.fn(async (item: { prompt: string }) => {
      attempts += 1;
      sendPrompts.push(item.prompt);
      if (attempts === 1) {
        throw new Error("gateway timeout after 60000ms");
      }
    });

    enqueueAnnounce({
      key: "announce:test:summary-retry",
      item: {
        prompt: "first result",
        summaryLine: "first result",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send,
    });
    enqueueAnnounce({
      key: "announce:test:summary-retry",
      item: {
        prompt: "second result",
        summaryLine: "second result",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send,
    });

    await waitFor(() => attempts >= 2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sendPrompts[0]).toContain("[Queue overflow]");
    expect(sendPrompts[1]).toContain("[Queue overflow]");
  });

  it("retries collect-mode batches without losing queued items", async () => {
    const sendPrompts: string[] = [];
    let attempts = 0;
    const send = vi.fn(async (item: { prompt: string }) => {
      attempts += 1;
      sendPrompts.push(item.prompt);
      if (attempts === 1) {
        throw new Error("gateway timeout after 60000ms");
      }
    });

    enqueueAnnounce({
      key: "announce:test:collect-retry",
      item: {
        prompt: "queued item one",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send,
    });
    enqueueAnnounce({
      key: "announce:test:collect-retry",
      item: {
        prompt: "queued item two",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send,
    });

    await waitFor(() => attempts >= 2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sendPrompts[0]).toContain("Queued #1");
    expect(sendPrompts[0]).toContain("queued item one");
    expect(sendPrompts[0]).toContain("Queued #2");
    expect(sendPrompts[0]).toContain("queued item two");
    expect(sendPrompts[1]).toContain("Queued #1");
    expect(sendPrompts[1]).toContain("queued item one");
    expect(sendPrompts[1]).toContain("Queued #2");
    expect(sendPrompts[1]).toContain("queued item two");
  });
});
