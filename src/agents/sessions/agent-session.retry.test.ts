import type { AssistantMessage } from "openclaw/llm-core";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AgentSession } from "./agent-session.js";

describe("AgentSession retry delay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  it("uses the server-provided retryAfterSeconds when larger than base exponential backoff", async () => {
    let emittedDelay = -1;
    const session = {
      retryCount: 0,
      settingsManager: {
        getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 2000 }),
      },
      emit: (event: any) => {
        if (event.type === "auto_retry_start") {
          emittedDelay = event.delayMs;
        }
      },
      delay: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      agent: { state: { messages: [] } },
    } as unknown as AgentSession;

    const callPromise = AgentSession.prototype["prepareRetry"].call(session, {
      role: "assistant",
      stopReason: "error",
      status: 429,
      retryAfterSeconds: 30,
    } as unknown as AssistantMessage);

    await vi.advanceTimersByTimeAsync(30_000);
    const result = await callPromise;

    expect(result).toBe(true);
    expect(session.retryCount).toBe(1);
    expect(emittedDelay).toBe(30_000); // Should use server's 30s instead of base 2000ms
  });

  it("normalizes non-finite retryAfterSeconds back to base exponential backoff", async () => {
    let emittedDelay = -1;
    const session = {
      retryCount: 0,
      settingsManager: {
        getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 2000 }),
      },
      emit: (event: any) => {
        if (event.type === "auto_retry_start") {
          emittedDelay = event.delayMs;
        }
      },
      delay: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      agent: { state: { messages: [] } },
    } as unknown as AgentSession;

    const callPromise = AgentSession.prototype["prepareRetry"].call(session, {
      role: "assistant",
      stopReason: "error",
      status: 429,
      retryAfterSeconds: Number.POSITIVE_INFINITY,
    } as unknown as AssistantMessage);

    await vi.advanceTimersByTimeAsync(2000);
    const result = await callPromise;

    expect(result).toBe(true);
    expect(session.retryCount).toBe(1);
    expect(emittedDelay).toBe(2000); // Falls back to base delay since infinity is ignored
  });
});
