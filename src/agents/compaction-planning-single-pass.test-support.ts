// Compaction must not force map-reduce when the whole history fits one summarizer call.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as agentSessions from "./sessions/index.js";

vi.mock("./sessions/index.js", async () => {
  const actual = await vi.importActual<typeof agentSessions>("./sessions/index.js");
  return {
    ...actual,
    generateSummary: vi.fn(),
  };
});
import { resolveSummarizationRequestBudget } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import { serializeConversation } from "../../packages/agent-core/src/harness/compaction/utils.js";
import { convertToLlm } from "../../packages/agent-core/src/harness/messages.js";
import { adjustMaxTokensForThinking } from "../../packages/ai/src/providers/simple-options.js";
import {
  BASE_CHUNK_RATIO,
  buildStageSplitPlan,
  estimateMessagesTokens,
  projectCompactionMessagesForPlanning,
  computeAdaptiveChunkRatio,
  SAFETY_MARGIN,
  SUMMARIZATION_OVERHEAD_TOKENS,
} from "./compaction-planning.js";
import { runCompactionPlanningWorkerInput } from "./compaction-planning.worker.js";
import type { AgentMessage } from "./runtime/index.js";

const { generateSummary } = await import("./sessions/index.js");
const { summarizeInStages } = await import("./compaction.js");
const mockGenerateSummary = vi.mocked(generateSummary);

beforeEach(() => {
  mockGenerateSummary.mockReset();
  mockGenerateSummary.mockResolvedValue("summary");
});

// Mirrors the reported deployment: a 262K-window summarizer over a ~164K transcript.
const LARGE_CONTEXT_WINDOW = 262_144;
const LARGE_SUMMARY_OUTPUT_BUDGET = 65_536;
const TEST_MODEL = {
  id: "test-summary-model",
  name: "Test Summary Model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: LARGE_CONTEXT_WINDOW,
  maxTokens: LARGE_SUMMARY_OUTPUT_BUDGET,
} satisfies Parameters<typeof resolveSummarizationRequestBudget>[0]["model"];

function buildTranscript(messageCount: number, charsPerMessage: number): AgentMessage[] {
  return Array.from({ length: messageCount }, (_, index) => ({
    role: "user",
    content: `turn ${index} ${"context ".repeat(Math.floor(charsPerMessage / 8))}`,
    timestamp: 1_000 + index,
  }));
}

function buildAlternatingTextMessages(pairs: number): AgentMessage[] {
  return Array.from({ length: pairs * 2 }, (_, index) =>
    index % 2 === 0
      ? {
          role: "user" as const,
          content: "ok",
          timestamp: 1_000 + index,
        }
      : {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "ok" }],
          api: "openai-responses" as const,
          provider: "openai",
          model: "test-summary-model",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: 1_000 + index,
        },
  ) as AgentMessage[];
}

function buildShellMessages(count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: "bashExecution",
    command: `printf shell-${index}`,
    output: "ok",
    exitCode: index === count - 1 ? 1 : 0,
    cancelled: false,
    truncated: index === count - 1,
    fullOutputPath: index === count - 1 ? "/tmp/full-output.log" : undefined,
    timestamp: 1_000 + index,
  })) as AgentMessage[];
}

function buildPlainShellOutputMessages(shellMessages: AgentMessage[]): AgentMessage[] {
  return shellMessages.map((message) => ({
    role: "user",
    content: message.role === "bashExecution" ? message.output : "ok",
    timestamp: message.timestamp,
  })) as AgentMessage[];
}

async function summarizeAndCountCalls(params: {
  messages: AgentMessage[];
  model?: Parameters<typeof summarizeInStages>[0]["model"];
  reserveTokens?: number;
  contextWindow: number;
  maxChunkTokens?: number;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}): Promise<number> {
  mockGenerateSummary.mockClear();
  await summarizeInStages({
    messages: params.messages,
    model: params.model ?? TEST_MODEL,
    apiKey: "test-key", // pragma: allowlist secret
    reserveTokens: params.reserveTokens ?? 0,
    maxChunkTokens: params.maxChunkTokens ?? 1,
    contextWindow: params.contextWindow,
    thinkingLevel: params.thinkingLevel,
    summarizationInstructions: { identifierPolicy: "off" },
    signal: new AbortController().signal,
  });
  return mockGenerateSummary.mock.calls.length;
}

function resolveRequestBudget(
  messages: AgentMessage[],
  options: {
    model?: Parameters<typeof resolveSummarizationRequestBudget>[0]["model"];
    reserveTokens?: number;
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    previousSummary?: string;
    customInstructions?: string;
  } = {},
) {
  return resolveSummarizationRequestBudget({
    messages,
    model: options.model ?? TEST_MODEL,
    reserveTokens: options.reserveTokens ?? 0,
    thinkingLevel: options.thinkingLevel,
    previousSummary: options.previousSummary,
    customInstructions: options.customInstructions,
  });
}

function resolvePlan(params: Parameters<typeof buildStageSplitPlan>[0]) {
  return buildStageSplitPlan({
    ...resolveRequestBudget(params.messages),
    ...params,
  });
}

function resolveMaxChunkTokens(messages: AgentMessage[], contextWindow: number): number {
  const ratio = computeAdaptiveChunkRatio(messages, contextWindow);
  return Math.max(1, Math.floor(contextWindow * ratio) - SUMMARIZATION_OVERHEAD_TOKENS);
}

describe("compaction single-pass fast path", () => {
  it("reserves the provider's effective high-reasoning allowance", async () => {
    const anthropicModel = {
      ...TEST_MODEL,
      id: "claude-3-5-sonnet-20241022",
      api: "anthropic-messages",
      provider: "anthropic",
      reasoning: true,
    } satisfies Parameters<typeof resolveSummarizationRequestBudget>[0]["model"];
    const messages = buildTranscript(10, 2_000);
    const reserveTokens = 20_000;
    const withoutThinking = resolveRequestBudget(messages, {
      model: anthropicModel,
      reserveTokens,
      thinkingLevel: "off",
    });
    const withThinking = resolveRequestBudget(messages, {
      model: anthropicModel,
      reserveTokens,
      thinkingLevel: "high",
    });

    expect(withThinking.completionAllowanceTokens).toBeGreaterThan(
      withoutThinking.completionAllowanceTokens,
    );
    const contextWindow = Math.floor(
      messages.length > 0
        ? withThinking.singlePassInputTokens * SAFETY_MARGIN +
            (withoutThinking.completionAllowanceTokens + withThinking.completionAllowanceTokens) / 2
        : 1,
    );
    expect(
      await summarizeAndCountCalls({
        messages,
        model: anthropicModel,
        reserveTokens,
        contextWindow,
        thinkingLevel: "off",
      }),
    ).toBe(1);
    expect(
      await summarizeAndCountCalls({
        messages,
        model: anthropicModel,
        reserveTokens,
        contextWindow,
        thinkingLevel: "high",
      }),
    ).toBeGreaterThan(1);
  });

  it("reserves the Bedrock adapter's effective high-reasoning allowance", async () => {
    const bedrockModel = {
      ...TEST_MODEL,
      id: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      name: "Claude 3.5 Sonnet",
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      reasoning: true,
    } satisfies Parameters<typeof resolveSummarizationRequestBudget>[0]["model"];
    const messages = buildTranscript(10, 2_000);
    const reserveTokens = 20_000;
    const withoutThinking = resolveRequestBudget(messages, {
      model: bedrockModel,
      reserveTokens,
      thinkingLevel: "off",
    });
    const withThinking = resolveRequestBudget(messages, {
      model: bedrockModel,
      reserveTokens,
      thinkingLevel: "high",
    });

    expect(withThinking.completionAllowanceTokens).toBeGreaterThan(
      withoutThinking.completionAllowanceTokens,
    );
    const contextWindow = Math.floor(
      withThinking.singlePassInputTokens * SAFETY_MARGIN +
        (withoutThinking.completionAllowanceTokens + withThinking.completionAllowanceTokens) / 2,
    );
    expect(
      await summarizeAndCountCalls({
        messages,
        model: bedrockModel,
        reserveTokens,
        contextWindow,
        thinkingLevel: "off",
      }),
    ).toBe(1);
    expect(
      await summarizeAndCountCalls({
        messages,
        model: bedrockModel,
        reserveTokens,
        contextWindow,
        thinkingLevel: "high",
      }),
    ).toBeGreaterThan(1);
  });

  it("budgets each Anthropic transport's actual max-reasoning allowance", () => {
    // adjustMaxTokensForThinking natively supports "max" (32 768) and only
    // clamps "xhigh", so any max->high narrowing is a per-transport decision:
    //   - streamSimpleAnthropic (packages/ai/src/providers/anthropic.ts) and
    //     resolveSimpleBedrockOptions forward the requested level unchanged;
    //   - the managed transport stream
    //     (packages/ai/src/transports/anthropic-transport-stream.ts) coerces
    //     "max" to "high", and only runs behind the
    //     "openclaw-anthropic-messages-transport" alias.
    // Assert against that contract rather than assuming Anthropic max == high.
    const reserveTokens = 8_192;
    const messages = buildTranscript(10, 2_000);
    const summaryOutputTokens = Math.min(Math.floor(0.8 * reserveTokens), TEST_MODEL.maxTokens);

    /** Allowance the given transport really requests for a thinking level. */
    const transportAllowance = (level: "high" | "max") => {
      const adjusted = adjustMaxTokensForThinking(summaryOutputTokens, TEST_MODEL.maxTokens, level);
      return adjusted.thinkingBudget >= 1024 ? adjusted.maxTokens : summaryOutputTokens;
    };

    const baseClaude = {
      ...TEST_MODEL,
      id: "claude-3-5-sonnet-20241022",
      name: "Claude 3.5 Sonnet",
      reasoning: true,
    };
    const models = {
      // Default simple-runtime route: forwards "max" unchanged.
      anthropicDirect: {
        ...baseClaude,
        api: "anthropic-messages",
        provider: "anthropic",
      },
      // Managed transport alias: coerces "max" to "high".
      anthropicManagedTransport: {
        ...baseClaude,
        api: "openclaw-anthropic-messages-transport",
        provider: "anthropic",
      },
      // Bedrock adapter: forwards "max" unchanged.
      bedrock: {
        ...baseClaude,
        id: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
        api: "bedrock-converse-stream",
        provider: "amazon-bedrock",
      },
    } as const;

    const budgetFor = (
      model: Parameters<typeof resolveSummarizationRequestBudget>[0]["model"],
      thinkingLevel: "high" | "max",
    ) =>
      resolveRequestBudget(messages, { model, reserveTokens, thinkingLevel })
        .completionAllowanceTokens;

    // Transports that forward "max" must budget the full max allowance.
    expect(budgetFor(models.anthropicDirect, "max")).toBe(transportAllowance("max"));
    expect(budgetFor(models.bedrock, "max")).toBe(transportAllowance("max"));
    // The managed transport narrows "max" to "high", so its budget must too.
    expect(budgetFor(models.anthropicManagedTransport, "max")).toBe(transportAllowance("high"));
    // "high" is never narrowed, so every route agrees on it.
    for (const model of Object.values(models)) {
      expect(budgetFor(model, "high")).toBe(transportAllowance("high"));
    }
    // The narrowing is exactly one thinking-budget step (32 768 - 16 384).
    expect(
      budgetFor(models.anthropicDirect, "max") - budgetFor(models.anthropicManagedTransport, "max"),
    ).toBe(16_384);
    // Forwarding transports must not silently collapse "max" onto "high".
    expect(budgetFor(models.anthropicDirect, "max")).toBeGreaterThan(
      budgetFor(models.anthropicDirect, "high"),
    );
    expect(budgetFor(models.bedrock, "max")).toBeGreaterThan(budgetFor(models.bedrock, "high"));
  });

  it("falls back to bounded chunks when a verified single-pass request overflows", async () => {
    const messages = buildTranscript(120, 5_500);
    const contextWindow = LARGE_CONTEXT_WINDOW;
    const maxChunkTokens = resolveMaxChunkTokens(messages, contextWindow);
    const contextOverflow = new Error(
      "This model's maximum context length was exceeded by the request",
    );
    mockGenerateSummary.mockReset();
    mockGenerateSummary.mockRejectedValueOnce(contextOverflow).mockResolvedValue("bounded summary");

    await expect(
      summarizeInStages({
        messages,
        model: TEST_MODEL,
        apiKey: "test-key", // pragma: allowlist secret
        reserveTokens: 0,
        maxChunkTokens,
        contextWindow,
        summarizationInstructions: { identifierPolicy: "off" },
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("bounded summary");

    const requestSizes = mockGenerateSummary.mock.calls.map(
      ([requestMessages]) => requestMessages.length,
    );
    expect(requestSizes[0]).toBe(messages.length);
    expect(requestSizes.slice(1).length).toBeGreaterThan(0);
    expect(requestSizes.slice(1).every((size) => size < messages.length)).toBe(true);
  });

  it("budgets the converted shell transcript rather than its raw output only", async () => {
    const shellMessages = buildShellMessages(1_024);
    const plainMessages = buildPlainShellOutputMessages(shellMessages);
    const shellBudget = resolveRequestBudget(shellMessages);
    const plainBudget = resolveRequestBudget(plainMessages, { customInstructions: "" });

    expect(shellBudget.singlePassInputTokens).toBeGreaterThan(plainBudget.singlePassInputTokens);
    const contextWindow = 12_000;
    expect(plainBudget.singlePassInputTokens * SAFETY_MARGIN).toBeLessThan(contextWindow);
    expect(shellBudget.singlePassInputTokens * SAFETY_MARGIN).toBeGreaterThan(contextWindow);
    expect(await summarizeAndCountCalls({ messages: plainMessages, contextWindow })).toBe(1);
    expect(
      await summarizeAndCountCalls({ messages: shellMessages, contextWindow }),
    ).toBeGreaterThan(1);
  });

  it("summarizes in one call when the whole history fits the summarizer window", () => {
    const messages = buildTranscript(120, 5_500);
    const totalTokens = estimateMessagesTokens(messages);
    // Guard the fixture: this must be a transcript that genuinely fits.
    expect(totalTokens).toBeGreaterThan(120_000);
    expect(totalTokens + SUMMARIZATION_OVERHEAD_TOKENS).toBeLessThan(LARGE_CONTEXT_WINDOW);

    const plan = resolvePlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW),
      contextWindow: LARGE_CONTEXT_WINDOW,
    });

    expect(plan.mode).toBe("single");
  });

  it("still splits when the history genuinely exceeds the summarizer window", () => {
    const messages = buildTranscript(400, 5_500);
    const totalTokens = estimateMessagesTokens(messages);
    expect(totalTokens + SUMMARIZATION_OVERHEAD_TOKENS).toBeGreaterThan(LARGE_CONTEXT_WINDOW);

    const plan = resolvePlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW),
      contextWindow: LARGE_CONTEXT_WINDOW,
    });

    expect(plan.mode).toBe("split");
  });

  it("splits when the generated summary would exceed the remaining window", () => {
    const messages = buildTranscript(120, 5_500);
    const totalTokens = estimateMessagesTokens(messages);
    expect(totalTokens + SUMMARIZATION_OVERHEAD_TOKENS).toBeLessThan(LARGE_CONTEXT_WINDOW);
    expect(
      totalTokens * 1.2 + SUMMARIZATION_OVERHEAD_TOKENS + LARGE_SUMMARY_OUTPUT_BUDGET,
    ).toBeGreaterThan(LARGE_CONTEXT_WINDOW);

    const plan = resolvePlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW),
      contextWindow: LARGE_CONTEXT_WINDOW,
      completionAllowanceTokens: LARGE_SUMMARY_OUTPUT_BUDGET,
    });

    expect(plan.mode).toBe("split");
  });

  it("keeps splitting for small-window summarizers", () => {
    // A 32K summarizer cannot absorb the same transcript, so chunking must remain.
    const messages = buildTranscript(120, 5_500);
    const smallWindow = 32_768;

    const plan = resolvePlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, smallWindow),
      contextWindow: smallWindow,
    });

    expect(plan.mode).toBe("split");
  });

  it("does not treat an absent context window as unlimited headroom", () => {
    // Callers that omit contextWindow must keep the pre-existing chunk behavior.
    const messages = buildTranscript(120, 5_500);
    const maxChunkTokens = resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW);
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(maxChunkTokens);

    const plan = resolvePlan({ messages, maxChunkTokens });

    expect(plan.mode).toBe("split");
  });

  it("documents the ratio ceiling that forces the redundant split", () => {
    // Even the widest ratio caps the chunk budget below a fitting transcript,
    // which is why the fast path cannot be expressed via maxChunkTokens alone.
    const messages = buildTranscript(120, 5_500);
    const widestBudget =
      Math.floor(LARGE_CONTEXT_WINDOW * BASE_CHUNK_RATIO) - SUMMARIZATION_OVERHEAD_TOKENS;

    expect(estimateMessagesTokens(messages)).toBeGreaterThan(widestBudget);
  });
});

describe("single-pass budget gating", () => {
  it("does not lift the chunk budget for the small-message shortcut", () => {
    // Three ~25K messages against a 65,536-token summarizer: the transcript does
    // NOT fit, but messages.length < minMessagesForSplit already returned "single"
    // before any fit check. Lifting the chunk cap here sends ~75K in one request.
    const smallWindow = 65_536;
    const messages = buildTranscript(3, 200_000);
    const totalTokens = estimateMessagesTokens(messages);
    expect(messages).toHaveLength(3);
    expect(totalTokens).toBeGreaterThan(smallWindow);

    const plan = resolvePlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, smallWindow),
      contextWindow: smallWindow,
      completionAllowanceTokens: 0,
    });

    // The planner must tell callers whether the whole request was verified to fit,
    // so a legacy single-stage shortcut keeps its bounded chunk budget.
    expect(plan.mode).toBe("single");
    expect((plan as { fitsWholeRequest?: boolean }).fitsWholeRequest ?? false).toBe(false);
  });

  it("marks a verified whole-request fit", () => {
    const messages = buildTranscript(120, 5_500);
    const plan = resolvePlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW),
      contextWindow: LARGE_CONTEXT_WINDOW,
      completionAllowanceTokens: 0,
    });

    expect(plan.mode).toBe("single");
    expect((plan as { fitsWholeRequest?: boolean }).fitsWholeRequest).toBe(true);
  });
});

describe("single-pass plan serialization", () => {
  it("survives the worker round trip", () => {
    // The worker returns indexes, not messages, so the flag must be serialized
    // explicitly or a verified single-pass plan silently becomes bounded again.
    const messages = buildTranscript(120, 5_500);
    const budget = resolveRequestBudget(messages);
    const value = runCompactionPlanningWorkerInput({
      kind: "stageSplit",
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW),
      contextWindow: LARGE_CONTEXT_WINDOW,
      singlePassInputTokens: budget.singlePassInputTokens,
      completionAllowanceTokens: budget.completionAllowanceTokens,
    });

    expect(value).toMatchObject({ kind: "stageSplit", mode: "single", fitsWholeRequest: true });
  });

  it("does not mark the small-message shortcut as a verified fit", () => {
    const messages = buildTranscript(3, 200_000);
    const budget = resolveRequestBudget(messages);
    const value = runCompactionPlanningWorkerInput({
      kind: "stageSplit",
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, 65_536),
      contextWindow: 65_536,
      singlePassInputTokens: budget.singlePassInputTokens,
      completionAllowanceTokens: budget.completionAllowanceTokens,
    });

    expect(value).toMatchObject({ kind: "stageSplit", mode: "single", fitsWholeRequest: false });
  });
});

describe("single-pass serialization overhead", () => {
  it("declines a whole-history request that only fits before serialization", () => {
    const messages = buildAlternatingTextMessages(7_000);
    const requestBudget = resolveRequestBudget(messages);
    const contentEstimate = estimateMessagesTokens(messages);
    const contextWindow = Math.floor(
      (contentEstimate * SAFETY_MARGIN + requestBudget.singlePassInputTokens * SAFETY_MARGIN) / 2 +
        requestBudget.completionAllowanceTokens,
    );

    // The content-only estimate approves this window, but the real serialized
    // request (including both valid user and assistant sections) does not.
    expect(contentEstimate * SAFETY_MARGIN + requestBudget.completionAllowanceTokens).toBeLessThan(
      contextWindow,
    );
    expect(
      requestBudget.singlePassInputTokens * SAFETY_MARGIN + requestBudget.completionAllowanceTokens,
    ).toBeGreaterThan(contextWindow);

    // Keep the chunk budget under the transcript so the legacy shortcut cannot
    // answer first and the fit check is the branch under test.
    const plan = resolvePlan({
      messages,
      maxChunkTokens: 2_048,
      contextWindow,
      completionAllowanceTokens: requestBudget.completionAllowanceTokens,
    });

    // Serialized, the same history overflows, so chunking must stay bounded.
    expect(plan).not.toMatchObject({ mode: "single", fitsWholeRequest: true });
  });

  it("still approves a history that fits once serialization is counted", () => {
    const messages = buildAlternatingTextMessages(200);
    // Below maxChunkTokens the legacy shortcut answers first, so keep the chunk
    // budget under the transcript to exercise the fit check itself.
    const plan = resolvePlan({
      messages,
      maxChunkTokens: 64,
      contextWindow: LARGE_CONTEXT_WINDOW,
      completionAllowanceTokens: LARGE_SUMMARY_OUTPUT_BUDGET,
    });

    expect(plan).toMatchObject({ mode: "single", fitsWholeRequest: true });
  });
});

describe("single-pass overhead across the worker projection", () => {
  // Histories at or above the worker threshold reach the planner already
  // shortened, so serialization overhead has to be derived from the message
  // count rather than measured on the projected text.
  it("keeps counting per-message overhead when the projection truncates content", () => {
    const messages = Array.from({ length: 20_000 }, (_, index) => ({
      role: "user",
      content: `${index}`.padStart(6, "0").padEnd(20, "x"),
      timestamp: 1_000 + index,
    })) as AgentMessage[];
    const projected = projectCompactionMessagesForPlanning(messages);
    const contextWindow = 40_000;
    const summaryOutputTokens = 6_553;

    // The projection really does shorten the transcript it hands the planner.
    const projectedChars = projected.reduce(
      (sum, message) =>
        sum + JSON.stringify("content" in message ? (message.content ?? "") : "").length,
      0,
    );
    const originalChars = messages.reduce(
      (sum, message) =>
        sum + JSON.stringify("content" in message ? (message.content ?? "") : "").length,
      0,
    );
    expect(projectedChars).toBeLessThan(originalChars);

    // Keep the chunk budget under the transcript so the legacy shortcut cannot
    // answer first; the fit check is the branch under test.
    const plan = resolvePlan({
      messages: projected,
      maxChunkTokens: 32_768,
      contextWindow,
      completionAllowanceTokens: summaryOutputTokens,
    });

    // 20,000 messages carry ~20,000 tokens of role labels alone, so the whole
    // history cannot be approved for one request.
    expect(plan).not.toMatchObject({ mode: "single", fitsWholeRequest: true });
  });
});

describe("single-pass framing cost per role", () => {
  it("declines the 5,000-pair history the serializer estimates at 36,250 tokens", () => {
    // [User]: is 8 chars, [Assistant]: is 13, each entry adds a 2-char separator.
    // 5,000 pairs therefore carry 125,000 chars of framing over 20,000 of content.
    const messages = buildAlternatingTextMessages(5_000);
    const serialized = serializeConversation(convertToLlm(messages));
    expect(serialized.match(/^\[User\]: ok$/gmu)).toHaveLength(5_000);
    expect(serialized.match(/^\[Assistant\]: ok$/gmu)).toHaveLength(5_000);

    const plan = resolvePlan({
      messages,
      // Below the content estimate so the fit check is the branch under test.
      maxChunkTokens: 2_048,
      contextWindow: 22_000,
      completionAllowanceTokens: 4_096,
    });

    expect(plan).not.toMatchObject({ mode: "single", fitsWholeRequest: true });
  });

  it("charges assistant framing more than user framing", () => {
    const asUser = Array.from({ length: 4_000 }, (_, index) => ({
      role: "user",
      content: "ok",
      timestamp: 1_000 + index,
    })) as AgentMessage[];
    // Assistant content must be blocks: the estimator counts zero tokens for a
    // string, which would let the legacy totalTokens shortcut answer before any
    // framing is evaluated and make the assertion vacuous.
    const asAssistant = asUser.map((message) => ({
      ...message,
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    })) as AgentMessage[];
    // maxChunkTokens stays below the 4,000-token content estimate so the legacy
    // totalTokens shortcut cannot answer before the fit check runs; verified by probe
    // that both roles reach the fit branch. 24,576 then separates them: the user
    // history is approved and the assistant history is declined purely on framing.
    const window = 19_000;

    // Same content, same count: only the role labels differ, and [Assistant]:
    // is wide enough to push this history over the window.
    const userPlan = resolvePlan({
      messages: asUser,
      maxChunkTokens: 1_024,
      contextWindow: window,
      completionAllowanceTokens: 1_024,
    });
    const assistantPlan = resolvePlan({
      messages: asAssistant as AgentMessage[],
      maxChunkTokens: 1_024,
      contextWindow: window,
      completionAllowanceTokens: 1_024,
    });

    expect(userPlan).toMatchObject({ mode: "single", fitsWholeRequest: true });
    expect(assistantPlan).not.toMatchObject({ mode: "single", fitsWholeRequest: true });
  });
});

function buildToolTurns(turns: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: "abcdefghijklmnopqrst" },
        { type: "toolCall", id: `call-${index}`, name: "f", arguments: {} },
      ],
      timestamp: 1_000 + index * 2,
    } as unknown as AgentMessage);
    messages.push({
      role: "toolResult",
      content: [{ type: "text", text: "abcdefghijklmnopqrst" }],
      toolCallId: `call-${index}`,
      timestamp: 1_001 + index * 2,
    } as unknown as AgentMessage);
  }
  return messages;
}

describe("single-pass framing for combined assistant turns", () => {
  // serializeConversation emits [Assistant]: and [Assistant tool calls]: as two
  // separate sections, so a turn carrying text and calls costs both frames.

  it("declines a tool-heavy history that only fits when one frame is ignored", () => {
    // Charging one assistant frame needs ~61,000 tokens here; charging both needs
    // ~76,600. A 65,536 window is approved by the former and must be declined by
    // the latter.
    const plan = resolvePlan({
      messages: buildToolTurns(2_000),
      maxChunkTokens: 8_192,
      contextWindow: 65_536,
      completionAllowanceTokens: 6_553,
    });

    expect(plan).not.toMatchObject({ mode: "single", fitsWholeRequest: true });
  });

  it("charges a text-and-calls turn more than a text-only turn", () => {
    const withCalls = buildToolTurns(1_200);
    const textOnly = withCalls.map((message) =>
      (message as { role?: string }).role === "assistant"
        ? {
            ...message,
            content: [{ type: "text", text: "abcdefghijklmnopqrst" }],
          }
        : message,
    ) as AgentMessage[];
    // 36,864 sits between the two: text-only needs ~32,064, text+calls ~41,424.
    const window = 36_864;

    expect(
      resolvePlan({
        messages: textOnly,
        maxChunkTokens: 4_096,
        contextWindow: window,
        completionAllowanceTokens: 2_048,
      }),
    ).toMatchObject({ mode: "single", fitsWholeRequest: true });
    expect(
      resolvePlan({
        messages: withCalls,
        maxChunkTokens: 4_096,
        contextWindow: window,
        completionAllowanceTokens: 2_048,
      }),
    ).not.toMatchObject({ mode: "single", fitsWholeRequest: true });
  });
});

describe("single-pass fixtures survive real conversion", () => {
  // Guards the fixture contract itself: toolCall blocks carry `arguments`, and
  // serializeConversation() reads it via Object.entries, so a wrong field name
  // throws instead of quietly under-measuring.
  it("serializes tool turns through the real conversion path", () => {
    const messages = buildToolTurns(3);
    const serialized = serializeConversation(convertToLlm(messages));

    expect(serialized).toContain("[Assistant]:");
    expect(serialized).toContain("[Assistant tool calls]:");
    expect(serialized).toContain("f()");
    expect(serialized).toContain("[Tool result]:");
  });
});
