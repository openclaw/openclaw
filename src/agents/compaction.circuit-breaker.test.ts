import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeInStages } from "./compaction.js";
import type { AgentMessage } from "./runtime/index.js";
import type { ExtensionContext } from "./sessions/index.js";

const compactionMocks = vi.hoisted(() => {
  return {
    estimateTokens: vi.fn(() => 4000),
    generateSummary: vi.fn(),
    logWarn: vi.fn(),
  };
});

vi.mock("./sessions/index.js", async () => {
  const actual = await vi.importActual<typeof import("./sessions/index.js")>("./sessions/index.js");
  return {
    ...actual,
    estimateTokens: compactionMocks.estimateTokens,
    generateSummary: compactionMocks.generateSummary,
  };
});

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: compactionMocks.logWarn,
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    raw: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

vi.mock("../infra/retry.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/retry.js")>("../infra/retry.js");
  return {
    ...actual,
    retryAsync: async <T>(fn: () => Promise<T>) => fn(),
  };
});

vi.mock("./compaction-planning-worker.js", async () => {
  const actual = await vi.importActual<typeof import("./compaction-planning-worker.js")>(
    "./compaction-planning-worker.js",
  );
  return {
    ...actual,
    buildStageSplitPlanWithWorker: vi.fn(
      async (params: {
        messages: AgentMessage[];
        maxChunkTokens: number;
        parts?: number;
        minMessagesForSplit?: number;
      }) => {
        const { messages, parts = 2, minMessagesForSplit = 4 } = params;
        if (messages.length < minMessagesForSplit) {
          return { mode: "single", chunks: [messages] };
        }
        const chunkSize = Math.ceil(messages.length / parts);
        const chunks: AgentMessage[][] = [];
        for (let i = 0; i < messages.length; i += chunkSize) {
          chunks.push(messages.slice(i, i + chunkSize));
        }
        return { mode: "staged", chunks };
      },
    ),
  };
});

const NON_TERMINAL_ERROR = new Error("summarizer rate limited");

describe("compaction circuit breaker in summarizeInStages (#58838)", () => {
  beforeEach(() => {
    compactionMocks.generateSummary.mockClear();
    compactionMocks.logWarn.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const testModel = {
    provider: "anthropic",
    model: "claude-3-opus",
  } as unknown as NonNullable<ExtensionContext["model"]>;

  function makeAssistantMsg(content: string): AgentMessage {
    return {
      role: "assistant",
      content: [{ type: "text", text: content }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        input: 100,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 200,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  function makeUserMsg(content: string): AgentMessage {
    return { role: "user", content, timestamp: Date.now() };
  }

  function buildLargeTranscript(numMessages: number): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < numMessages; i++) {
      messages.push(makeUserMsg(`User message ${i}`));
      messages.push(makeAssistantMsg(`Assistant response ${i}`));
    }
    return messages;
  }

  const baseParams = {
    model: testModel,
    apiKey: "test-key",
    signal: new AbortController().signal,
    reserveTokens: 1000,
    maxChunkTokens: 4000,
    contextWindow: 100000,
  };

  it("opens after 2 consecutive generic fallbacks", async () => {
    const messages = buildLargeTranscript(20);

    compactionMocks.generateSummary.mockImplementation(async () => {
      throw NON_TERMINAL_ERROR;
    });

    compactionMocks.estimateTokens.mockReturnValue(4000);

    const result = await summarizeInStages({
      ...baseParams,
      messages,
    });

    expect(result).toContain("Context contained");
    expect(compactionMocks.logWarn).toHaveBeenCalledWith(
      "compaction circuit breaker triggered in summarizeInStages",
      expect.objectContaining({
        consecutiveFallbackSplits: 2,
      }),
    );
  });

  it("skips remaining splits and merge retry when breaker opens", async () => {
    const messages = buildLargeTranscript(20);

    let callCount = 0;
    compactionMocks.generateSummary.mockImplementation(async () => {
      callCount++;
      throw NON_TERMINAL_ERROR;
    });

    compactionMocks.estimateTokens.mockReturnValue(4000);

    await summarizeInStages({
      ...baseParams,
      messages,
    });

    expect(callCount).toBe(2);
    expect(compactionMocks.logWarn).toHaveBeenCalledWith(
      "compaction circuit breaker triggered in summarizeInStages",
      expect.any(Object),
    );
  });

  it("happy path completes all splits without breaker", async () => {
    const messages = buildLargeTranscript(10);

    let callCount = 0;
    compactionMocks.generateSummary.mockImplementation(async () => {
      callCount++;
      return `Summary of chunk ${callCount}`;
    });

    compactionMocks.estimateTokens.mockReturnValue(4000);

    const result = await summarizeInStages({
      ...baseParams,
      messages,
    });

    expect(result).toContain("Summary of chunk");
    expect(compactionMocks.logWarn).not.toHaveBeenCalledWith(
      "compaction circuit breaker triggered in summarizeInStages",
      expect.any(Object),
    );
  });
});
