// Long fenced block and compaction retry tests cover Markdown-safe chunking and
// subscription state reset around automatic compaction retries.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  createParagraphChunkedBlockReplyHarness,
  emitAssistantTextDeltaAndEnd,
  expectFencedChunks,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import { makeZeroUsageSnapshot } from "./usage.js";

type SessionEventHandler = (evt: unknown) => void;

describe("subscribeEmbeddedAgentSession", () => {
  it("splits long single-line fenced blocks with reopen/close", async () => {
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking: {
        minChars: 10,
        maxChars: 40,
      },
    });

    const text = `\`\`\`json\n${"x".repeat(120)}\n\`\`\``;
    emitAssistantTextDeltaAndEnd({ emit, text });
    await Promise.resolve();
    expectFencedChunks(onBlockReply.mock.calls, "```json");
  });
  it("waits for auto-compaction retry and clears buffered text", async () => {
    // A retrying compaction invalidates any assistant text buffered from the
    // failed attempt; waiters resolve only after the retry path reaches agent_end.
    const listeners: SessionEventHandler[] = [];
    const session = {
      subscribe: (listener: SessionEventHandler) => {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index !== -1) {
            listeners.splice(index, 1);
          }
        };
      },
    } as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"];

    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run-1",
    });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "oops" }],
    } as AssistantMessage;

    for (const listener of listeners) {
      listener({ type: "message_end", message: assistantMessage });
    }

    expect(subscription.assistantTexts.length).toBe(1);

    for (const listener of listeners) {
      listener({
        type: "compaction_end",
        willRetry: true,
      });
    }

    expect(subscription.isCompacting()).toBe(true);
    expect(subscription.assistantTexts.length).toBe(0);

    let resolved = false;
    const waitPromise = subscription.waitForCompactionRetry().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    for (const listener of listeners) {
      listener({ type: "agent_end" });
    }

    await waitPromise;
    expect(resolved).toBe(true);
  });
  it("resolves after compaction ends without retry", async () => {
    const listeners: SessionEventHandler[] = [];
    const session = {
      subscribe: (listener: SessionEventHandler) => {
        listeners.push(listener);
        return () => {};
      },
    } as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"];

    const subscription = subscribeEmbeddedAgentSession({
      session,
      runId: "run-2",
    });

    for (const listener of listeners) {
      listener({ type: "compaction_start" });
    }

    expect(subscription.isCompacting()).toBe(true);

    let resolved = false;
    const waitPromise = subscription.waitForCompactionRetry().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    for (const listener of listeners) {
      listener({ type: "compaction_end", willRetry: false });
    }

    await waitPromise;
    expect(resolved).toBe(true);
    expect(subscription.isCompacting()).toBe(false);
  });

  it("clears stale usage for pre-compaction messages only", () => {
    // Only assistant messages before the latest compactionSummary should be
    // zeroed; messages after the compactionSummary carry valid LLM usage data.
    const listeners: SessionEventHandler[] = [];
    const staleUsage = {
      input: 120,
      output: 30,
      cacheRead: 5,
      cacheWrite: 0,
      totalTokens: 155,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    };
    const freshUsage = {
      input: 50,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 70,
      cost: { input: 0.0005, output: 0.0004, cacheRead: 0, cacheWrite: 0, total: 0.0009 },
    };
    const session = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "old" }],
          usage: { ...staleUsage },
        },
        {
          role: "compactionSummary",
          content: [{ type: "text", text: "summary" }],
          timestamp: Date.now(),
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "new" }],
          usage: { ...freshUsage },
        },
      ],
      subscribe: (listener: SessionEventHandler) => {
        listeners.push(listener);
        return () => {};
      },
    } as unknown as Parameters<typeof subscribeEmbeddedAgentSession>[0]["session"];

    subscribeEmbeddedAgentSession({
      session,
      runId: "run-3",
    });

    for (const listener of listeners) {
      listener({ type: "compaction_end", willRetry: false });
    }

    const preCompactionUsage = (session.messages?.[0] as { usage?: unknown } | undefined)?.usage;
    expect(preCompactionUsage).toEqual(makeZeroUsageSnapshot());

    const postCompactionUsage = (session.messages?.[2] as { usage?: unknown } | undefined)?.usage;
    expect(postCompactionUsage).toEqual(freshUsage);
  });
});
