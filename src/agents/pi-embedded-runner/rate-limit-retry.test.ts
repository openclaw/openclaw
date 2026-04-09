import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFailoverReasonFromError } from "../failover-error.js";
import { classifyFailoverReason } from "../pi-embedded-helpers.js";
import type { PromptRetryContext } from "./rate-limit-retry.js";

const computeBackoffMock = vi.fn((_attempt: number) => 1_000);
const sleepWithAbortMock = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined);

import {
  parseRetryAfterMs,
  retryPromptOnRateLimit,
  runPromptWithRateLimitRetry,
} from "./rate-limit-retry.js";

function make429Error(extra?: Record<string, unknown>): Error & { status: number } {
  return Object.assign(new Error("Too Many Requests"), { status: 429, ...extra });
}

function makeContext(overrides?: Partial<PromptRetryContext>): PromptRetryContext {
  return {
    prompt: async () => undefined,
    classifyTerminalFailure: () => null,
    isReplaySafe: () => true,
    rewind: () => undefined,
    provider: "test-provider",
    modelId: "test-model",
    computeBackoff: (attempt: number) => computeBackoffMock(attempt),
    sleepWithAbort: (delayMs: number, abortSignal?: AbortSignal) =>
      sleepWithAbortMock(delayMs, abortSignal),
    ...overrides,
  };
}

describe("retryPromptOnRateLimit", () => {
  beforeEach(() => {
    vi.useRealTimers();
    computeBackoffMock.mockClear();
    computeBackoffMock.mockImplementation((attempt: number) => attempt * 1_000);
    sleepWithAbortMock.mockReset();
    sleepWithAbortMock.mockImplementation(async () => undefined);
  });

  it("retries on a thrown rate limit and succeeds on the second prompt call", async () => {
    const prompt = vi
      .fn<PromptRetryContext["prompt"]>()
      .mockRejectedValueOnce(make429Error())
      .mockResolvedValueOnce(undefined);

    await retryPromptOnRateLimit(makeContext({ prompt }));

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).toHaveBeenCalledWith(1_000, undefined);
  });

  it("exhausts 3 retries on persistent thrown rate limits and rethrows", async () => {
    const error = make429Error({ headers: { "retry-after": "2" } });
    const prompt = vi.fn<PromptRetryContext["prompt"]>().mockRejectedValue(error);

    await expect(retryPromptOnRateLimit(makeContext({ prompt }))).rejects.toBe(error);

    expect(prompt).toHaveBeenCalledTimes(4);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    Object.assign(new Error("Service Unavailable"), { status: 503 }),
    Object.assign(new Error("Unauthorized"), { status: 401 }),
  ])("does not retry non-rate-limit thrown errors", async (error) => {
    const prompt = vi.fn<PromptRetryContext["prompt"]>().mockRejectedValue(error);

    await expect(retryPromptOnRateLimit(makeContext({ prompt }))).rejects.toBe(error);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it.each([
    Object.assign(new Error("Resource has been exhausted"), { code: "RESOURCE_EXHAUSTED" }),
    new Error("wrapped abort", {
      cause: Object.assign(new Error("Resource exhausted"), { status: "RESOURCE_EXHAUSTED" }),
    }),
    Object.assign(new Error("Rate exceeded"), { code: "THROTTLING" }),
  ])("detects wrapped rate-limit errors via unified failover classification", async (error) => {
    const prompt = vi
      .fn<PromptRetryContext["prompt"]>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);

    await retryPromptOnRateLimit(makeContext({ prompt }));

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(1);
  });

  it("preserves thrown error properties on exhaustion for downstream failover", async () => {
    const headers = { "retry-after": "2" };
    const error = make429Error({ headers });
    const prompt = vi.fn<PromptRetryContext["prompt"]>().mockRejectedValue(error);

    const thrown = await retryPromptOnRateLimit(makeContext({ prompt })).catch(
      (err: unknown) => err,
    );

    expect(thrown).toBe(error);
    expect((thrown as Error).message).toBe("Too Many Requests");
    expect((thrown as { status: number }).status).toBe(429);
    expect((thrown as { headers: unknown }).headers).toBe(headers);
  });

  it("retries terminal assistant rate limits and rewinds before replay", async () => {
    let promptCalls = 0;
    const prompt = vi.fn<PromptRetryContext["prompt"]>(async () => {
      promptCalls += 1;
    });
    const rewind = vi.fn();
    const classifyTerminalFailure = vi.fn(() =>
      promptCalls === 1
        ? { isRateLimit: true, rawError: { headers: { "retry-after": "5" } } }
        : null,
    );

    await retryPromptOnRateLimit(makeContext({ prompt, classifyTerminalFailure, rewind }));

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(rewind).toHaveBeenCalledTimes(1);
    expect(rewind.mock.invocationCallOrder[0]).toBeLessThan(
      sleepWithAbortMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(sleepWithAbortMock).toHaveBeenCalledWith(5_000, undefined);
  });

  it("calls rewind before each terminal retry", async () => {
    let promptCalls = 0;
    const prompt = vi.fn<PromptRetryContext["prompt"]>(async () => {
      promptCalls += 1;
    });
    const rewind = vi.fn();
    const classifyTerminalFailure = vi.fn(() =>
      promptCalls <= 2 ? { isRateLimit: true, rawError: new Error("rate limit") } : null,
    );

    await retryPromptOnRateLimit(makeContext({ prompt, classifyTerminalFailure, rewind }));

    expect(prompt).toHaveBeenCalledTimes(3);
    expect(rewind).toHaveBeenCalledTimes(2);
  });

  it("does not retry terminal non-rate-limit errors", async () => {
    const prompt = vi.fn<PromptRetryContext["prompt"]>().mockResolvedValue(undefined);
    const classifyTerminalFailure = vi.fn(() => ({
      isRateLimit: false,
      rawError: new Error("bad request"),
    }));

    await expect(
      retryPromptOnRateLimit(makeContext({ prompt, classifyTerminalFailure })),
    ).resolves.toBeUndefined();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it("returns normally when a terminal rate limit is not replay-safe", async () => {
    const prompt = vi.fn<PromptRetryContext["prompt"]>().mockResolvedValue(undefined);
    const classifyTerminalFailure = vi.fn(() => ({
      isRateLimit: true,
      rawError: new Error("rate limit"),
    }));
    const isReplaySafe = vi.fn(() => false);
    const rewind = vi.fn();

    await expect(
      retryPromptOnRateLimit(
        makeContext({ prompt, classifyTerminalFailure, isReplaySafe, rewind }),
      ),
    ).resolves.toBeUndefined();

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(isReplaySafe).toHaveBeenCalledTimes(1);
    expect(rewind).not.toHaveBeenCalled();
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it("evaluates replay safety fresh on each retry attempt", async () => {
    const firstError = make429Error();
    const secondError = make429Error();
    const prompt = vi
      .fn<PromptRetryContext["prompt"]>()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(secondError);
    const isReplaySafe = vi
      .fn(() => true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await expect(retryPromptOnRateLimit(makeContext({ prompt, isReplaySafe }))).rejects.toBe(
      secondError,
    );

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(isReplaySafe).toHaveBeenCalledTimes(2);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After over computed backoff", async () => {
    const prompt = vi
      .fn<PromptRetryContext["prompt"]>()
      .mockRejectedValueOnce(make429Error({ headers: { "retry-after": "6" } }))
      .mockResolvedValueOnce(undefined);

    await retryPromptOnRateLimit(makeContext({ prompt }));

    expect(sleepWithAbortMock).toHaveBeenCalledWith(6_000, undefined);
  });

  it("caps Retry-After delays at 30 seconds", async () => {
    const prompt = vi
      .fn<PromptRetryContext["prompt"]>()
      .mockRejectedValueOnce(make429Error({ headers: { "retry-after": "86400" } }))
      .mockResolvedValueOnce(undefined);

    await retryPromptOnRateLimit(makeContext({ prompt }));

    expect(sleepWithAbortMock).toHaveBeenCalledWith(30_000, undefined);
  });

  it("falls back to exponential backoff when Retry-After is absent", async () => {
    const prompt = vi
      .fn<PromptRetryContext["prompt"]>()
      .mockRejectedValueOnce(make429Error())
      .mockResolvedValueOnce(undefined);

    await retryPromptOnRateLimit(makeContext({ prompt }));

    expect(computeBackoffMock).toHaveBeenCalledWith(1);
    expect(sleepWithAbortMock).toHaveBeenCalledWith(1_000, undefined);
  });

  it("does not retry when the abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    const error = make429Error();
    const prompt = vi.fn<PromptRetryContext["prompt"]>().mockRejectedValue(error);

    await expect(
      retryPromptOnRateLimit(makeContext({ prompt, abortSignal: controller.signal })),
    ).rejects.toBe(error);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it("propagates abort reason when retry sleep is interrupted", async () => {
    const controller = new AbortController();
    const prompt = vi.fn<PromptRetryContext["prompt"]>().mockRejectedValue(make429Error());
    sleepWithAbortMock.mockImplementationOnce(async () => {
      controller.abort("sessions_yield");
      throw new Error("aborted", { cause: new DOMException("signal is aborted", "AbortError") });
    });

    const thrown = await retryPromptOnRateLimit(
      makeContext({ prompt, abortSignal: controller.signal }),
    ).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBe("sessions_yield");
  });
});

describe("exhausted error → downstream failover classification bridge", () => {
  beforeEach(() => {
    computeBackoffMock.mockClear();
    computeBackoffMock.mockImplementation((attempt: number) => attempt * 1_000);
    sleepWithAbortMock.mockReset();
    sleepWithAbortMock.mockImplementation(async () => undefined);
  });

  it("exhausted thrown 429 is classified as rate_limit by resolveFailoverReasonFromError", async () => {
    const error = make429Error({ headers: { "retry-after": "1" } });
    const prompt = vi.fn<PromptRetryContext["prompt"]>().mockRejectedValue(error);

    const thrown = await retryPromptOnRateLimit(makeContext({ prompt })).catch(
      (err: unknown) => err,
    );

    expect(thrown).toBe(error);
    expect(resolveFailoverReasonFromError(thrown)).toBe("rate_limit");
  });

  it("exhausted terminal errorMessage is classified as rate_limit by classifyFailoverReason", async () => {
    const errorMessage = "Too many requests";
    let promptCalls = 0;
    const prompt = vi.fn<PromptRetryContext["prompt"]>(async () => {
      promptCalls += 1;
    });
    const classifyTerminalFailure = vi.fn(() => ({
      isRateLimit: true,
      rawError: { errorMessage },
    }));

    await retryPromptOnRateLimit(makeContext({ prompt, classifyTerminalFailure, rewind: vi.fn() }));

    expect(classifyFailoverReason(errorMessage)).toBe("rate_limit");
  });
});

describe("parseRetryAfterMs", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [{ headers: { "retry-after": "5" } }, 5_000],
    [{ headers: { "Retry-After": "6" } }, 6_000],
    [{ headers: { "RETRY-AFTER": "4" } }, 4_000],
    [{ response: { headers: { "retry-after": "7" } } }, 7_000],
    [{ cause: { headers: { "retry-after": "3" } } }, 3_000],
    [{ error: { headers: { "retry-after": "11" } } }, 11_000],
    [{ cause: { error: { headers: { "retry-after": "9" } } } }, 9_000],
  ])("parses delta-seconds from common header shapes", (error, expected) => {
    expect(parseRetryAfterMs(error)).toBe(expected);
  });

  it("parses HTTP-date values", () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2026-03-25T10:00:00.000Z");
      vi.setSystemTime(now);

      expect(
        parseRetryAfterMs({
          headers: { "retry-after": new Date("2026-03-25T10:00:10.000Z").toUTCString() },
        }),
      ).toBe(10_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads Retry-After from Headers instances", () => {
    const headers = new Headers();
    headers.set("retry-after", "8");

    expect(parseRetryAfterMs({ headers })).toBe(8_000);
  });
});

describe("runPromptWithRateLimitRetry", () => {
  const baseAssistantUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  beforeEach(() => {
    computeBackoffMock.mockClear();
    computeBackoffMock.mockImplementation((attempt: number) => attempt * 1_000);
    sleepWithAbortMock.mockReset();
    sleepWithAbortMock.mockImplementation(async () => undefined);
  });

  function createRetryTestSession() {
    const initialMessages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: Date.now(),
      },
    ];
    const agent = {
      state: { messages: initialMessages.slice() },
    };
    // Mirror the real AgentSession behavior: `messages` is a getter over agent.state.messages.
    const session = {
      get messages(): AgentMessage[] {
        return agent.state.messages;
      },
      set messages(value: AgentMessage[]) {
        agent.state.messages = value;
      },
      prompt: vi.fn<(prompt: string, options?: { images?: unknown[] }) => Promise<void>>(),
      agent,
    };
    return session;
  }

  function createRateLimitAssistant(): AgentMessage {
    return {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "mock-1",
      usage: baseAssistantUsage,
      stopReason: "error",
      errorMessage: "Too many requests",
      timestamp: Date.now(),
    } as AgentMessage;
  }

  it("rethrows exhausted thrown rate limits so callers stay on the promptError path", async () => {
    const session = createRetryTestSession();
    const error = Object.assign(new Error("Too Many Requests"), { status: 429 });
    session.prompt.mockRejectedValue(error);

    await expect(
      runPromptWithRateLimitRetry({
        activeSession: session,
        effectivePrompt: "hello",
        images: [],
        abortable: async <T>(promise: Promise<T>) => await promise,
        assistantTexts: [],
        toolMetas: [],
        didSendViaMessagingTool: () => false,
        getSuccessfulCronAdds: () => 0,
        getReasoningEmitCount: () => 0,
        didEmitAssistantUpdate: () => false,
        getCompactionCount: () => 0,
        provider: "openai",
        modelId: "mock-1",
        computeBackoff: computeBackoffMock,
        sleepWithAbort: sleepWithAbortMock,
      }),
    ).rejects.toBe(error);

    expect(session.prompt).toHaveBeenCalledTimes(4);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(3);
  });

  it("rewinds terminal rate-limit assistants via agent.state.messages", async () => {
    const session = createRetryTestSession();
    session.prompt.mockImplementation(async () => {
      session.messages.push(createRateLimitAssistant());
      session.agent.state.messages = session.messages.slice();
    });

    await runPromptWithRateLimitRetry({
      activeSession: session,
      effectivePrompt: "hello",
      images: [],
      abortable: async <T>(promise: Promise<T>) => await promise,
      assistantTexts: [],
      toolMetas: [],
      didSendViaMessagingTool: () => false,
      getSuccessfulCronAdds: () => 0,
      getReasoningEmitCount: () => 0,
      didEmitAssistantUpdate: () => false,
      getCompactionCount: () => 0,
      provider: "openai",
      modelId: "mock-1",
      computeBackoff: computeBackoffMock,
      sleepWithAbort: sleepWithAbortMock,
    });

    expect(session.prompt).toHaveBeenCalledTimes(4);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(3);
    expect(session.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: "Too many requests",
    });
  });

  it("does not retry when reasoning has been emitted", async () => {
    const session = createRetryTestSession();
    let reasoningEmitCount = 0;
    session.prompt.mockImplementation(async () => {
      reasoningEmitCount = 1;
      session.messages.push(createRateLimitAssistant());
      session.agent.state.messages = session.messages.slice();
    });

    await runPromptWithRateLimitRetry({
      activeSession: session,
      effectivePrompt: "hello",
      images: [],
      abortable: async <T>(promise: Promise<T>) => await promise,
      assistantTexts: [],
      toolMetas: [],
      didSendViaMessagingTool: () => false,
      getSuccessfulCronAdds: () => 0,
      getReasoningEmitCount: () => reasoningEmitCount,
      didEmitAssistantUpdate: () => false,
      getCompactionCount: () => 0,
      provider: "openai",
      modelId: "mock-1",
      computeBackoff: computeBackoffMock,
      sleepWithAbort: sleepWithAbortMock,
    });

    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it("rewinds to post-compaction state when compaction occurs during prompt", async () => {
    const session = createRetryTestSession();
    let compactionCount = 0;
    let promptCalls = 0;

    session.prompt.mockImplementation(async () => {
      promptCalls++;
      if (promptCalls === 1) {
        const compacted: AgentMessage[] = [
          {
            role: "user",
            content: [{ type: "text", text: "compacted summary" }],
            timestamp: Date.now(),
          } as AgentMessage,
        ];
        session.messages = compacted;
        compactionCount++;
        session.messages.push(
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
            timestamp: Date.now(),
          } as AgentMessage,
          createRateLimitAssistant(),
        );
        session.agent.state.messages = session.messages.slice();
      }
    });

    await runPromptWithRateLimitRetry({
      activeSession: session,
      effectivePrompt: "hello",
      images: [],
      abortable: async <T>(promise: Promise<T>) => await promise,
      assistantTexts: [],
      toolMetas: [],
      didSendViaMessagingTool: () => false,
      getSuccessfulCronAdds: () => 0,
      getReasoningEmitCount: () => 0,
      didEmitAssistantUpdate: () => false,
      getCompactionCount: () => compactionCount,
      provider: "openai",
      modelId: "mock-1",
      computeBackoff: computeBackoffMock,
      sleepWithAbort: sleepWithAbortMock,
    });

    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(session.agent.state.messages).toHaveLength(1);
    expect(session.agent.state.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "compacted summary" }],
    });
  });

  it("detects terminal errors after compaction shortens message array", async () => {
    const session = createRetryTestSession();
    session.messages = [
      {
        role: "user",
        content: [{ type: "text", text: "msg1" }],
        timestamp: Date.now(),
      } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "reply1" }],
        api: "openai-responses",
        provider: "openai",
        model: "mock-1",
        usage: baseAssistantUsage,
        stopReason: "stop",
        timestamp: Date.now(),
      } as AgentMessage,
      {
        role: "user",
        content: [{ type: "text", text: "msg2" }],
        timestamp: Date.now(),
      } as AgentMessage,
    ];
    session.agent.state.messages = session.messages.slice();
    let compactionCount = 0;
    let promptCalls = 0;

    session.prompt.mockImplementation(async () => {
      promptCalls++;
      if (promptCalls === 1) {
        session.messages = [
          {
            role: "user",
            content: [{ type: "text", text: "summary" }],
            timestamp: Date.now(),
          } as AgentMessage,
        ];
        compactionCount++;
        session.messages.push(
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
            timestamp: Date.now(),
          } as AgentMessage,
          createRateLimitAssistant(),
        );
        session.agent.state.messages = session.messages.slice();
      }
    });

    await runPromptWithRateLimitRetry({
      activeSession: session,
      effectivePrompt: "hello",
      images: [],
      abortable: async <T>(promise: Promise<T>) => await promise,
      assistantTexts: [],
      toolMetas: [],
      didSendViaMessagingTool: () => false,
      getSuccessfulCronAdds: () => 0,
      getReasoningEmitCount: () => 0,
      didEmitAssistantUpdate: () => false,
      getCompactionCount: () => compactionCount,
      provider: "openai",
      modelId: "mock-1",
      computeBackoff: computeBackoffMock,
      sleepWithAbort: sleepWithAbortMock,
    });

    expect(session.prompt).toHaveBeenCalledTimes(2);
  });
});
