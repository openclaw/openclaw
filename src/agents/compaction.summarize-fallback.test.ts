import type { ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompactionError } from "../../packages/agent-core/src/harness/types.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { summarizeCompactionHistory } from "./compaction.js";

const { generateSummary } = vi.hoisted(() => ({ generateSummary: vi.fn() }));

vi.mock("openclaw/plugin-sdk/agent-sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-sessions")>()),
  generateSummary,
}));

vi.mock("./sessions/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sessions/index.js")>()),
  generateSummary,
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
  expect(generateSummary).toHaveBeenCalledTimes(calls);
}

describe("compaction summarization fallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    generateSummary.mockReset().mockRejectedValue(new Error("fetch failed"));
  });

  afterEach(() => vi.useRealTimers());

  it.each([
    // A provider disconnect can look like caller cancellation without aborting its signal.
    Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
    new CompactionError(
      "summarization_failed",
      "Summarization failed: model returned no summary text",
    ),
  ])("retries %s and returns the recovered summary without caller cancellation", async (error) => {
    generateSummary.mockRejectedValueOnce(error).mockResolvedValueOnce("recovered summary");
    await finish(expect(summarizeHello()).resolves.toBe("recovered summary"), 2);
  });

  it("rethrows the raw error without retrying when the caller already aborted", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    generateSummary.mockRejectedValue(abortErr);
    const controller = new AbortController();
    controller.abort();

    const result = expect(summarizeHello(controller.signal)).rejects.toBe(abortErr);
    // Caller cancellation is terminal and must not be masked as a CompactionError.
    await finish(result, 1);
  });

  it.each([
    [Object.assign(new Error("request timed out"), { name: "TimeoutError" }), 1],
    [new Error("provider unavailable"), 3],
  ] as const)("wraps %s after %i attempt(s)", async (error, calls) => {
    generateSummary.mockRejectedValue(error);
    const promise = summarizeHello();
    await finish(
      Promise.all([
        expect(promise).rejects.toBeInstanceOf(CompactionError),
        expect(promise).rejects.toThrow(`Summarization failed for 1 messages: ${error.message}`),
      ]),
      calls,
    );
  });
});
