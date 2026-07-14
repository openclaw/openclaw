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

  it("surfaces immediately (returns false) if retryAfterSeconds exceeds max SDK wait", async () => {
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
      retryAfterSeconds: 61, // default cap is 60s
    } as unknown as AssistantMessage);

    const result = await callPromise;

    expect(result).toBe(false); // abort retry immediately
    expect(session.retryCount).toBe(0); // restored for failover
    expect(emittedDelay).toBe(-1); // no delay emitted
  });

  it("surfaces immediately with a timer-safe bound if SDK max wait is disabled and retryAfter is huge", async () => {
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

    // Simulate disabling the max wait cap
    process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS = "0";

    const callPromise = AgentSession.prototype["prepareRetry"].call(session, {
      role: "assistant",
      stopReason: "error",
      status: 429,
      retryAfterSeconds: 2147484, // ~2.14m seconds (exceeds 2147483647 ms)
    } as unknown as AssistantMessage);

    const result = await callPromise;

    expect(result).toBe(false); // abort retry immediately due to MAX_NODE_TIMEOUT
    expect(session.retryCount).toBe(0); // restored for failover
    expect(emittedDelay).toBe(-1); // no delay emitted

    delete process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS;
  });
});
