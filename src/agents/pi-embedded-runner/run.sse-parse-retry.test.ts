import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isLikelySSEParseError } from "../pi-embedded-helpers.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
} from "./run.overflow-compaction.shared-test.js";

const mockedIsLikelySSEParseError = vi.mocked(isLikelySSEParseError);

describe("runEmbeddedPiAgent SSE parse error retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries on SSE parse error in assistant response (stopReason=error)", async () => {
    // 第一次尝试返回 SSE 解析错误
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        lastAssistant: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Could not parse SSE event",
          model: "test-model",
          api: "messages",
          provider: "anthropic",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: Date.now(),
        },
      }),
    );
    // 第二次尝试成功
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    // mock isLikelySSEParseError 在第一次调用时返回 true
    mockedIsLikelySSEParseError.mockReturnValueOnce(true).mockReturnValue(false);

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-sse-retry-assistant",
    });

    // 应该调用了 2 次 attempt（第一次 SSE 错误，第二次成功）
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    // isLikelySSEParseError 被调用时应传递 { streamingContext: true }
    expect(mockedIsLikelySSEParseError).toHaveBeenCalledWith("Could not parse SSE event", {
      streamingContext: true,
    });
    // 结果不应包含错误
    expect(result.meta?.error).toBeUndefined();
  });

  it("retries on SSE parse error in prompt error path", async () => {
    const sseError = new Error("SyntaxError: Unexpected end of JSON input");

    // 第一次尝试在 prompt 阶段抛出 SSE 解析错误
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: sseError }));
    // 第二次尝试成功
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedIsLikelySSEParseError.mockReturnValueOnce(true).mockReturnValue(false);

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      runId: "run-sse-retry-prompt",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedIsLikelySSEParseError).toHaveBeenCalledWith(sseError.message, {
      streamingContext: true,
    });
    expect(result.meta?.error).toBeUndefined();
  });

  it("stops retrying after MAX_SSE_PARSE_RETRIES (3) attempts", async () => {
    const sseError = new Error("Could not parse SSE event");

    // 连续 4 次返回 SSE 解析错误（3 次重试 + 第 4 次不再重试）
    for (let i = 0; i < 4; i++) {
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: sseError }));
    }

    // 前 3 次调用返回 true（触发重试），后续返回 true 但不会被调用因为已达上限
    mockedIsLikelySSEParseError.mockReturnValue(true);

    // 当超过重试次数后，错误会被 throw 出来
    // 由于 classifyFailoverReason 返回 null，且 isFailoverErrorMessage 返回 false，
    // promptError 会被直接 throw
    await expect(
      runEmbeddedPiAgent({
        ...overflowBaseRunParams,
        runId: "run-sse-retry-exhausted",
      }),
    ).rejects.toThrow("Could not parse SSE event");

    // 应该尝试了 4 次（初始 + 3 次重试）
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
  });
});
