// Covers final fallback behavior when model-backed summarization fails.
import type { ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { UserMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactionError } from "../../packages/agent-core/src/harness/types.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { summarizeCompactionHistory } from "./compaction.js";

const agentSessionMocks = vi.hoisted(() => ({
  generateSummary: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-sessions", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/agent-sessions")>(
    "openclaw/plugin-sdk/agent-sessions",
  );
  return {
    ...actual,
    generateSummary: agentSessionMocks.generateSummary,
  };
});

vi.mock("./sessions/index.js", async () => {
  const actual = await vi.importActual<typeof import("./sessions/index.js")>("./sessions/index.js");
  return {
    ...actual,
    generateSummary: agentSessionMocks.generateSummary,
  };
});

const testModel = {
  id: "test",
  name: "test",
  contextWindow: 200_000,
  contextTokens: 200_000,
  maxTokens: 8192,
} as unknown as NonNullable<ExtensionContext["model"]>;

function summarizeHello(signal: AbortSignal): Promise<string> {
  return summarizeCompactionHistory({
    messages: [makeUserMessage("hello", 1) satisfies UserMessage],
    model: testModel,
    apiKey: "test-key", // pragma: allowlist secret
    signal,
    reserveTokens: 1000,
  });
}

async function finishAssertionWithTimers(assertion: Promise<unknown>): Promise<void> {
  // The async clock drain yields native turns. Observe failures immediately,
  // then rethrow only after the drain finishes.
  void assertion.catch(() => undefined);
  await vi.runAllTimersAsync();
  await assertion;
}

describe("compaction summarization fallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    agentSessionMocks.generateSummary.mockReset();
    agentSessionMocks.generateSummary.mockRejectedValue(
      new Error("Summarization failed: fetch failed"),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries provider-side AbortError and returns a real summary when caller signal is not aborted", async () => {
    // Reproduce the undici AbortError("This operation was aborted") shape thrown
    // when the LLM API closes the connection mid-stream without the caller signal
    // being fired. Before the fix, isAbortError() + isTimeoutError() both matched
    // this error shape, so shouldRetry returned false and no retry was attempted —
    // the compaction fell back to the "Summary unavailable" placeholder instead.
    const providerAbortErr = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    agentSessionMocks.generateSummary
      .mockRejectedValueOnce(providerAbortErr)
      .mockResolvedValueOnce("recovered summary after provider disconnect");

    const summary = summarizeHello(new AbortController().signal); // not aborted

    const result = expect(summary).resolves.toBe("recovered summary after provider disconnect");
    await finishAssertionWithTimers(result);
    // Two calls: first fails with provider-side AbortError, second succeeds.
    expect(agentSessionMocks.generateSummary).toHaveBeenCalledTimes(2);
  });

  it("retries a summarization_failed result and persists the recovered summary", async () => {
    agentSessionMocks.generateSummary
      .mockRejectedValueOnce(
        new CompactionError(
          "summarization_failed",
          "Summarization failed: model returned no summary text",
        ),
      )
      .mockResolvedValueOnce("recovered non-empty summary");

    const result = expect(summarizeHello(new AbortController().signal)).resolves.toBe(
      "recovered non-empty summary",
    );
    await finishAssertionWithTimers(result);
    expect(agentSessionMocks.generateSummary).toHaveBeenCalledTimes(2);
  });

  it("stops retry backoff promptly when the caller aborts mid-sleep", async () => {
    // The first attempt fails with a retryable error, then the caller aborts
    // while retryAsync sits in its backoff sleep (>= 500ms minDelay). The
    // sleep must reject on abort instead of riding out the full delay.
    const controller = new AbortController();
    agentSessionMocks.generateSummary.mockRejectedValueOnce(new Error("transient rate limit"));

    const startedAt = Date.now();
    const promise = summarizeHello(controller.signal);
    const rejection = expect(promise).rejects.toThrow("aborted");
    setTimeout(() => controller.abort(), 50);
    await finishAssertionWithTimers(rejection);
    const elapsedMs = Date.now() - startedAt;

    // Well under the 500ms minimum backoff — the abort interrupted the sleep.
    expect(elapsedMs).toBeLessThan(400);
    expect(agentSessionMocks.generateSummary).toHaveBeenCalledTimes(1);
  });

  it("rethrows the raw error without retrying when the caller already aborted", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    agentSessionMocks.generateSummary.mockRejectedValue(abortErr);
    const controller = new AbortController();
    controller.abort();

    const result = expect(summarizeHello(controller.signal)).rejects.toBe(abortErr);
    await finishAssertionWithTimers(result);
    // Caller cancellation is terminal and must not be masked as a CompactionError.
    expect(agentSessionMocks.generateSummary).toHaveBeenCalledTimes(1);
  });

  it("does not retry transport timeouts", async () => {
    const timeoutErr = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    agentSessionMocks.generateSummary.mockRejectedValue(timeoutErr);

    const result = expect(summarizeHello(new AbortController().signal)).rejects.toThrow(
      "Summarization failed for 1 messages: request timed out",
    );
    await finishAssertionWithTimers(result);
    expect(agentSessionMocks.generateSummary).toHaveBeenCalledTimes(1);
  });

  it("throws CompactionError with the last error after retries are exhausted", async () => {
    agentSessionMocks.generateSummary.mockRejectedValue(new Error("provider unavailable"));

    const promise = summarizeHello(new AbortController().signal);
    const result = expect(promise).rejects.toBeInstanceOf(CompactionError);
    const message = expect(promise).rejects.toThrow(
      "Summarization failed for 1 messages: provider unavailable",
    );
    await finishAssertionWithTimers(Promise.all([result, message]));
    expect(agentSessionMocks.generateSummary).toHaveBeenCalledTimes(3);
  });
});
