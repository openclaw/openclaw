import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "./agent-session.js";

describe("AgentSession auto-retry", () => {
  it("honors Retry-After headers and emits auto_retry_start with the requested delay", async () => {
    let emittedEvent: any;
    const session = {
      retryCount: 0,
      settingsManager: {
        getRetrySettings: () => ({
          enabled: true,
          maxRetries: 3,
          baseDelayMs: 1_000,
        }),
      },
      agent: { state: { messages: [] } },
      emit: vi.fn((event) => {
        emittedEvent = event;
      }),
    };

    const prepareRetry = AgentSession.prototype["prepareRetry"].bind(
      session as unknown as AgentSession,
    );

    const willRetry = await prepareRetry({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Too Many Requests",
      status: 429,
      retryAfterSeconds: 30,
    } as any);

    expect(willRetry).toBe(true);
    expect(session.retryCount).toBe(1);
    expect(session.emit).toHaveBeenCalled();
    expect(emittedEvent).toMatchObject({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 30_000,
    });
  });

  it("uses base delay backoff when no Retry-After is provided", async () => {
    let emittedEvent: any;
    const session = {
      retryCount: 0,
      settingsManager: {
        getRetrySettings: () => ({
          enabled: true,
          maxRetries: 3,
          baseDelayMs: 1_000,
        }),
      },
      agent: { state: { messages: [] } },
      emit: vi.fn((event) => {
        emittedEvent = event;
      }),
    };

    const prepareRetry = AgentSession.prototype["prepareRetry"].bind(
      session as unknown as AgentSession,
    );

    const willRetry = await prepareRetry({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Service Unavailable",
      status: 503,
    } as any);

    expect(willRetry).toBe(true);
    expect(session.retryCount).toBe(1);
    expect(emittedEvent).toMatchObject({
      type: "auto_retry_start",
      attempt: 1,
      delayMs: 1_000,
    });
  });
});
