import { describe, expect, it, vi, beforeEach } from "vitest";
import { AgentSession } from "./agent-session.js";

// Mock sleep so tests don't actually wait
vi.mock("../utils/sleep.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

describe("AgentSession auto-retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("honors Retry-After headers and emits auto_retry_start with the requested delay", async () => {
    let emittedEvent: any;
    const session = {
      retryCount: 0,
      settingsManager: {
        getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 1_000 }),
        getProviderRetrySettings: () => ({ maxRetryDelayMs: 60000 }),
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
        getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 1_000 }),
        getProviderRetrySettings: () => ({ maxRetryDelayMs: 60000 }),
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

  it("caps excessive Retry-After values to the configured maxRetryDelayMs", async () => {
    let emittedEvent: any;
    const session = {
      retryCount: 0,
      settingsManager: {
        getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 1_000 }),
        getProviderRetrySettings: () => ({ maxRetryDelayMs: 150000 }), // 2.5 minutes max
      },
      agent: { state: { messages: [] } },
      emit: vi.fn((event) => {
        emittedEvent = event;
      }),
    };

    const prepareRetry = AgentSession.prototype["prepareRetry"].bind(
      session as unknown as AgentSession,
    );

    await prepareRetry({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Too Many Requests",
      status: 429,
      retryAfterSeconds: 3600, // 1 hour
    } as any);

    expect(emittedEvent).toMatchObject({
      type: "auto_retry_start",
      delayMs: 150_000,
    });
  });

  it("caps non-finite Retry-After values to the configured maxRetryDelayMs", async () => {
    let emittedEvent: any;
    const session = {
      retryCount: 0,
      settingsManager: {
        getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 1_000 }),
        getProviderRetrySettings: () => ({ maxRetryDelayMs: 150000 }),
      },
      agent: { state: { messages: [] } },
      emit: vi.fn((event) => {
        emittedEvent = event;
      }),
    };

    const prepareRetry = AgentSession.prototype["prepareRetry"].bind(
      session as unknown as AgentSession,
    );

    await prepareRetry({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Too Many Requests",
      status: 429,
      retryAfterSeconds: Infinity,
    } as any);

    expect(emittedEvent).toMatchObject({
      type: "auto_retry_start",
      delayMs: 150_000,
    });
  });

  it("disables capping when maxRetryDelayMs is 0", async () => {
    let emittedEvent: any;
    const session = {
      retryCount: 0,
      settingsManager: {
        getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 1_000 }),
        getProviderRetrySettings: () => ({ maxRetryDelayMs: 0 }), // 0 means disabled
      },
      agent: { state: { messages: [] } },
      emit: vi.fn((event) => {
        emittedEvent = event;
      }),
    };

    const prepareRetry = AgentSession.prototype["prepareRetry"].bind(
      session as unknown as AgentSession,
    );

    await prepareRetry({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Too Many Requests",
      status: 429,
      retryAfterSeconds: 3600, // 1 hour
    } as any);

    expect(emittedEvent).toMatchObject({
      type: "auto_retry_start",
      delayMs: 3_600_000, // Full 1 hour delay honored
    });
  });

  it("preserves configured backoff when it exceeds the provider ceiling", async () => {
    let emittedEvent: any;
    const session = {
      // If baseDelayMs is 100_000, retryCount = 4 => delayMs = 100_000 * 2^3 = 800_000
      retryCount: 3,
      settingsManager: {
        getRetrySettings: () => ({ enabled: true, maxRetries: 5, baseDelayMs: 100_000 }),
        getProviderRetrySettings: () => ({ maxRetryDelayMs: 300_000 }),
      },
      agent: { state: { messages: [] } },
      emit: vi.fn((event) => {
        emittedEvent = event;
      }),
    };

    const prepareRetry = AgentSession.prototype["prepareRetry"].bind(
      session as unknown as AgentSession,
    );

    // After retryCount++ in prepareRetry, retryCount becomes 4, so exponent is (4 - 1) = 3
    // 100_000 * 8 = 800_000ms.
    // Provider requests 10,000s = 10,000,000ms which gets clamped to 300,000ms.
    // Math.max(800_000, 300_000) = 800_000ms.

    await prepareRetry({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Too Many Requests",
      status: 429,
      retryAfterSeconds: 10000, // Excessive
    } as any);

    expect(emittedEvent).toMatchObject({
      type: "auto_retry_start",
      delayMs: 800_000,
    });
  });
});
