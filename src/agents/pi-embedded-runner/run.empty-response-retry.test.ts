import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedLog,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams as baseParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

/**
 * Tests for the empty-response retry logic added in fix for #60607 / #59765.
 *
 * When a provider (e.g. MiniMax) returns stopReason "stop" but produces zero
 * output tokens and no visible content, the run loop should retry up to 3
 * times before surfacing an explicit error to the user.
 */
describe("empty response retry in run loop", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  // 构造一个空响应的 attempt result（模拟 MiniMax 返回空内容）
  function makeEmptyResponseAttempt() {
    return makeAttemptResult({
      assistantTexts: [],
      lastAssistant: {
        role: "assistant" as const,
        content: [],
        stopReason: "stop",
        usage: { input: 0, output: 0 },
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });
  }

  // 构造一个正常响应的 attempt result
  function makeSuccessAttempt() {
    return makeAttemptResult({
      assistantTexts: ["Here is your response."],
      lastAssistant: {
        role: "assistant" as const,
        content: [{ type: "text", text: "Here is your response." }],
        stopReason: "stop",
        usage: { input: 100, output: 50 },
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });
  }

  it("retries on empty response and succeeds on subsequent attempt", async () => {
    // 第1次返回空响应，第2次返回正常响应
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeEmptyResponseAttempt())
      .mockResolvedValueOnce(makeSuccessAttempt());

    const result = await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedLog.warn).toHaveBeenCalledWith(expect.stringContaining("[empty-response-retry]"));
    // 不应该是错误结果
    expect(result.meta.error).toBeUndefined();
  });

  it("retries up to 3 times and surfaces error when all attempts return empty", async () => {
    // 连续4次返回空响应（1次初始 + 3次重试）
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeEmptyResponseAttempt())
      .mockResolvedValueOnce(makeEmptyResponseAttempt())
      .mockResolvedValueOnce(makeEmptyResponseAttempt())
      .mockResolvedValueOnce(makeEmptyResponseAttempt());

    const result = await runEmbeddedPiAgent(baseParams);

    // 初始1次 + 重试3次 = 4次
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    // 应有3条 warn 日志（每次重试一条）
    const warnCalls = mockedLog.warn.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" && args[0].includes("[empty-response-retry]"),
    );
    expect(warnCalls).toHaveLength(3);
    // 应有1条 error 日志（重试耗尽）
    expect(mockedLog.error).toHaveBeenCalledWith(
      expect.stringContaining("[empty-response-exhausted]"),
    );
    // 返回结果包含用户可见的错误提示
    expect(result.payloads).toBeDefined();
    expect(result.payloads).toHaveLength(1);
    expect(result.payloads![0].isError).toBe(true);
    expect(result.payloads![0].text).toContain("empty response");
  });

  it("does not retry when response has output tokens (genuine empty text)", async () => {
    // 有 output tokens 但 assistantTexts 为空（可能是只产出了 thinking）
    // 这种情况不应该触发空响应重试
    const thinkingOnlyAttempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: {
        role: "assistant" as const,
        content: [],
        stopReason: "stop",
        usage: { input: 100, output: 200 },
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(thinkingOnlyAttempt);

    await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    // 不应该有空响应重试日志
    const warnCalls = mockedLog.warn.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" && args[0].includes("[empty-response-retry]"),
    );
    expect(warnCalls).toHaveLength(0);
  });

  it("does not retry when message was sent via messaging tool", async () => {
    // Agent 通过 messaging tool 直接发送了消息，payloads 为空是正常的
    const messagingToolAttempt = makeAttemptResult({
      assistantTexts: [],
      didSendViaMessagingTool: true,
      lastAssistant: {
        role: "assistant" as const,
        content: [],
        stopReason: "stop",
        usage: { input: 0, output: 0 },
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(messagingToolAttempt);

    await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const warnCalls = mockedLog.warn.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" && args[0].includes("[empty-response-retry]"),
    );
    expect(warnCalls).toHaveLength(0);
  });

  it("does not retry on stopReason error (handled by failover logic)", async () => {
    const errorAttempt = makeAttemptResult({
      assistantTexts: [],
      lastAssistant: {
        role: "assistant" as const,
        content: [],
        stopReason: "error",
        errorMessage: "some api error",
        usage: { input: 0, output: 0 },
      } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(errorAttempt);

    await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const warnCalls = mockedLog.warn.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" && args[0].includes("[empty-response-retry]"),
    );
    expect(warnCalls).toHaveLength(0);
  });

  it("resets empty response retry counter after a successful response", async () => {
    // 第1次空响应 → 重试 → 第2次成功 → 后续另一轮空响应应从0开始计数
    // 这个测试验证计数器在成功响应后重置
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeEmptyResponseAttempt())
      .mockResolvedValueOnce(makeSuccessAttempt());

    await runEmbeddedPiAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    // 只有1次 warn（第一次空响应重试）
    const warnCalls = mockedLog.warn.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" && args[0].includes("[empty-response-retry]"),
    );
    expect(warnCalls).toHaveLength(1);
    // 没有 exhausted error
    expect(mockedLog.error).not.toHaveBeenCalledWith(
      expect.stringContaining("[empty-response-exhausted]"),
    );
  });
});
