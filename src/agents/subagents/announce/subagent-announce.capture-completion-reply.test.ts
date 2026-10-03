import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureSubagentCompletionReplyUsing,
  readLatestSubagentOutputWithRetryUsing,
} from "./subagent-announce-capture.js";

const sessionKey = "agent:main:subagent:child";
const readSubagentOutput = vi.fn<() => Promise<string | undefined>>();
const capture = (
  overrides: Partial<Parameters<typeof captureSubagentCompletionReplyUsing>[0]> = {},
) =>
  captureSubagentCompletionReplyUsing({
    sessionKey,
    maxWaitMs: 5,
    retryIntervalMs: 5,
    readSubagentOutput,
    ...overrides,
  });

beforeEach(() => {
  vi.useFakeTimers();
  readSubagentOutput.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("captureSubagentCompletionReply", () => {
  it("returns immediate assistant output without polling", async () => {
    readSubagentOutput.mockResolvedValue("Immediate completion");
    await expect(capture()).resolves.toBe("Immediate completion");
    expect(readSubagentOutput).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("captures the final assistant reply at the deadline", async () => {
    readSubagentOutput
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("Requester-visible final result");
    const pending = capture();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("Requester-visible final result");
    expect(readSubagentOutput).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("charges slow output reads against the bounded retry deadline", async () => {
    const startedAt = performance.now();
    readSubagentOutput.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 15);
      });
      return undefined;
    });
    const pending = readLatestSubagentOutputWithRetryUsing({
      sessionKey,
      maxWaitMs: 25,
      retryIntervalMs: 10,
      readSubagentOutput,
    });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(readSubagentOutput).toHaveBeenCalledTimes(2);
    expect(performance.now() - startedAt).toBe(40);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ maxWaitMs: 0 }, { waitForReply: false }])("does not poll with %j", async (options) => {
    await expect(capture(options)).resolves.toBeUndefined();
    expect(readSubagentOutput).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
