import type { ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactionError } from "../../packages/agent-core/src/harness/types.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { summarizeCompactionHistory } from "./compaction.js";

const agentSessionMocks = vi.hoisted(() => ({
  generateSummary: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-sessions")>()),
  generateSummary: agentSessionMocks.generateSummary,
}));

vi.mock("./sessions/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sessions/index.js")>()),
  generateSummary: agentSessionMocks.generateSummary,
}));

const testModel = {
  id: "test",
  name: "test",
  contextWindow: 200_000,
  contextTokens: 200_000,
  maxTokens: 8192,
} as unknown as NonNullable<ExtensionContext["model"]>;

function summarizeHello(signal = new AbortController().signal): Promise<string> {
  return summarizeCompactionHistory({
    messages: [makeUserMessage("hello", 1)],
    model: testModel,
    apiKey: "test-key", // pragma: allowlist secret
    signal,
    reserveTokens: 1000,
  });
}

async function finish(assertion: Promise<unknown>, calls: number) {
  // Observe failures before yielding to the async clock drain.
  void assertion.catch(() => undefined);
  await vi.runAllTimersAsync();
  await assertion;
  expect(agentSessionMocks.generateSummary).toHaveBeenCalledTimes(calls);
}

describe("compaction summarization fallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    agentSessionMocks.generateSummary.mockReset().mockRejectedValue(new Error("fetch failed"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    // A provider disconnect can look like caller cancellation without aborting its signal.
    Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
    new CompactionError(
      "summarization_failed",
      "Summarization failed: model returned no summary text",
    ),
  ])("retries %s and returns the recovered summary without caller cancellation", async (error) => {
    agentSessionMocks.generateSummary
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce("recovered summary");
    await finish(expect(summarizeHello()).resolves.toBe("recovered summary"), 2);
  });

  it("stops retry backoff promptly when the caller aborts mid-sleep", async () => {
    const controller = new AbortController();
    agentSessionMocks.generateSummary.mockRejectedValueOnce(new Error("transient rate limit"));

    const startedAt = Date.now();
    const rejection = expect(summarizeHello(controller.signal)).rejects.toThrow("aborted");
    setTimeout(() => controller.abort(), 50);
    await finish(rejection, 1);
    // Well under the 500ms minimum backoff — the abort interrupted the sleep.
    expect(Date.now() - startedAt).toBeLessThan(400);
  });

  it("rethrows the raw error without retrying when the caller already aborted", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    agentSessionMocks.generateSummary.mockRejectedValue(abortErr);
    const controller = new AbortController();
    controller.abort();

    await finish(expect(summarizeHello(controller.signal)).rejects.toBe(abortErr), 1);
  });

  it("does not retry transport timeouts", async () => {
    const timeoutErr = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    agentSessionMocks.generateSummary.mockRejectedValue(timeoutErr);

    await finish(
      expect(summarizeHello()).rejects.toThrow(
        "Summarization failed for 1 messages: request timed out",
      ),
      1,
    );
  });

  it("throws CompactionError with the last error after retries are exhausted", async () => {
    agentSessionMocks.generateSummary.mockRejectedValue(new Error("provider unavailable"));

    const promise = summarizeHello();
    const result = expect(promise).rejects.toBeInstanceOf(CompactionError);
    const message = expect(promise).rejects.toThrow(
      "Summarization failed for 1 messages: provider unavailable",
    );
    await finish(Promise.all([result, message]), 3);
  });
});
