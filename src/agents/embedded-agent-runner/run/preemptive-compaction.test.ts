// Preemptive compaction tests cover token-pressure estimates before prompt
// submission and the route chosen to compact, truncate, or proceed.
import type { ToolResultMessage } from "@openclaw/llm-core";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import "../../test-helpers/agent-session-token-mock.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";

let estimateLlmBoundaryTokenPressure: typeof import("./preemptive-compaction.js").estimateLlmBoundaryTokenPressure;
let buildPrePromptContextBudgetStatus: typeof import("./preemptive-compaction.js").buildPrePromptContextBudgetStatus;
let estimateToolSchemaTokenPressure: typeof import("./preemptive-compaction.js").estimateToolSchemaTokenPressure;
let estimateRenderedLlmBoundaryTokenPressure: typeof import("./preemptive-compaction.js").estimateRenderedLlmBoundaryTokenPressure;
let formatPrePromptPrecheckLog: typeof import("./preemptive-compaction.js").formatPrePromptPrecheckLog;
let shouldPreemptivelyCompactBeforePrompt: typeof import("./preemptive-compaction.js").shouldPreemptivelyCompactBeforePrompt;
let resolveProjectedRequestPressure: typeof import("./preemptive-compaction.js").resolveProjectedRequestPressure;

beforeAll(async () => {
  // Import after the session-token mock is installed so token estimates match
  // the runtime environment these helpers protect.
  vi.resetModules();
  ({
    estimateLlmBoundaryTokenPressure,
    buildPrePromptContextBudgetStatus,
    estimateRenderedLlmBoundaryTokenPressure,
    estimateToolSchemaTokenPressure,
    formatPrePromptPrecheckLog,
    shouldPreemptivelyCompactBeforePrompt,
    resolveProjectedRequestPressure,
  } = await import("./preemptive-compaction.js"));
});

let timestamp = 1;

function makeAssistantHistory(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: timestamp++,
  } as AgentMessage;
}

function shortHistoryInput() {
  return {
    messages: [makeAssistantHistory("short history")],
    systemPrompt: "sys",
    prompt: "hello",
    contextTokenBudget: 10_000,
    reserveTokens: 1_000,
  };
}

function makeProviderAssistant(params: {
  promptTokens: number;
  totalTokens: number;
  text?: string;
}): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: params.text ?? "provider answer" }],
    usage: {
      ...createZeroUsageFixture(),
      input: params.promptTokens,
      output: params.totalTokens - params.promptTokens,
      totalTokens: params.totalTokens,
      contextUsage: {
        state: "available",
        promptTokens: params.promptTokens,
        totalTokens: params.totalTokens,
      },
    },
    stopReason: "stop",
    timestamp: timestamp++,
  } as AgentMessage;
}

function makeUnavailableAssistant(params: {
  totalTokens: number;
  legacyCli?: boolean;
}): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "usage unavailable" }],
    api: params.legacyCli ? "cli" : "anthropic-messages",
    usage: {
      ...createZeroUsageFixture(),
      input: params.totalTokens,
      totalTokens: params.totalTokens,
      ...(params.legacyCli ? {} : { contextUsage: { state: "unavailable" as const } }),
    },
    stopReason: "stop",
    timestamp: timestamp++,
  } as AgentMessage;
}

function makeToolResultMessage(...texts: string[]): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: `call_${timestamp}`,
    toolName: "read",
    content: texts.map((text) => ({ type: "text", text })),
    isError: false,
    timestamp: timestamp++,
  };
}

function makeJsonToolResultMessage(payload: unknown): AgentMessage {
  // JSON tool results reach providers through rendered boundary payloads; this
  // fixture proves estimates count object payloads, not just text blocks.
  return {
    role: "toolResult",
    toolCallId: `call_${timestamp}`,
    toolName: "json_tool",
    content: [{ type: "json", payload }],
    isError: false,
    timestamp: timestamp++,
  } as unknown as AgentMessage;
}

function makeAssistantToolCall(args: unknown): AgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: `call_${timestamp}`,
        name: "bulk_lookup",
        arguments: args,
      },
    ],
    timestamp: timestamp++,
  } as AgentMessage;
}

describe("preemptive-compaction", () => {
  it.each([
    ["synthetic tool result ", 11_051, true],
    ["a9f32c078db41e65", 50_215, false],
  ] as const)(
    "admits prose but protects dense pending data: %s",
    (pattern, measuredTokens, fits) => {
      // gpt-4.1-mini input counts from the real Responses serializer, with a
      // 107-token prior response and five 16,031-character synthetic result blocks.
      const text = pattern.repeat(Math.ceil(16_031 / pattern.length)).slice(0, 16_031);
      const decision = resolveProjectedRequestPressure({
        context: { messages: [makeToolResultMessage(...Array<string>(5).fill(text))] },
        previousRequest: { requestIndex: 1, messageCount: 0, contextTokens: 107 },
        contextTokenBudget: 32_768,
        reserveTokens: 0,
      });
      expect(decision.estimatedPromptTokens).toBeGreaterThanOrEqual(measuredTokens);
      expect(decision.route === "fits").toBe(fits);
    },
  );

  it("rejects short-key JSON that exceeds the measured provider window", () => {
    // Real Responses input count: 26,806 tokens, versus 114 with an empty result.
    const text = '{"id":123,"ok":false,"path":"src/a.ts","value":[1,2,3]}\n'
      .repeat(1300)
      .slice(0, 65_000);
    const decision = resolveProjectedRequestPressure({
      context: { messages: [makeToolResultMessage(text)] },
      previousRequest: { requestIndex: 1, messageCount: 0, contextTokens: 107 },
      contextTokenBudget: 20_000,
      reserveTokens: 0,
    });
    expect(decision.estimatedPromptTokens).toBeGreaterThanOrEqual(26_806);
    expect(decision.route).not.toBe("fits");
  });

  const verboseHistory =
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ".repeat(40);
  const verboseSystem =
    "system guidance with multiple distinct words to avoid tokenizer overcompression ".repeat(25);
  const verbosePrompt =
    "user request with distinct content asking for a detailed answer and more context ".repeat(25);

  it("counts the current system prompt after a provider usage boundary", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [
        { role: "user", content: "x".repeat(1_000_000), timestamp: timestamp++ } as AgentMessage,
        makeProviderAssistant({ promptTokens: 240_000, totalTokens: 240_304 }),
        { role: "user", content: "small tail", timestamp: timestamp++ } as AgentMessage,
      ],
      systemPrompt: "new system instruction ".repeat(5_000),
      prompt: "continue",
      contextTokenBudget: 272_000,
      reserveTokens: 20_000,
    });

    expect(result.pressureSource).toBe("provider_context_usage");
    expect(result.estimatedPromptTokens).toBeGreaterThan(result.promptBudgetBeforeReserve);
    expect(result.route).toBe("compact_only");
  });

  it("uses the later assistant boundary when distinct responses have equal totals", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [
        makeProviderAssistant({ promptTokens: 179_900, totalTokens: 180_000, text: "first" }),
        makeToolResultMessage("x".repeat(100_000)),
        makeProviderAssistant({ promptTokens: 179_900, totalTokens: 180_000, text: "second" }),
        { role: "user", content: "small tail", timestamp: timestamp++ } as AgentMessage,
      ],
      prompt: "continue",
      contextTokenBudget: 210_000,
      reserveTokens: 20_000,
    });

    expect(result.estimatedPromptTokens).toBeGreaterThan(180_000);
    expect(result.estimatedPromptTokens).toBeLessThan(190_000);
    expect(result.route).toBe("fits");
  });

  it("still compacts when content after the provider boundary exceeds the budget", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [
        makeProviderAssistant({ promptTokens: 179_900, totalTokens: 180_000 }),
        makeToolResultMessage("x".repeat(40_000)),
      ],
      prompt: "continue",
      contextTokenBudget: 210_000,
      reserveTokens: 20_000,
    });

    expect(result.estimatedPromptTokens).toBeGreaterThan(190_000);
    expect(result.route).not.toBe("fits");
  });

  it("does not scan past a zero unavailable context marker", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: createUnavailableUsageHistory({ totalTokens: 0 }),
      prompt: "continue",
      contextTokenBudget: 210_000,
      reserveTokens: 20_000,
    });

    expect(result.pressureSource).toBe("transcript_estimate");
    expect(result.route).toBe("compact_only");
  });

  it("treats legacy CLI usage without context provenance as a barrier", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: createUnavailableUsageHistory({ totalTokens: 1_000, legacyCli: true }),
      prompt: "continue",
      contextTokenBudget: 210_000,
      reserveTokens: 20_000,
    });

    expect(result.pressureSource).toBe("transcript_estimate");
    expect(result.route).toBe("compact_only");
  });

  it("can reuse an older provider boundary past nonzero unavailable billing usage", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: createUnavailableUsageHistory({ totalTokens: 927_907 }),
      prompt: "continue",
      contextTokenBudget: 210_000,
      reserveTokens: 20_000,
    });

    expect(result.pressureSource).toBe("provider_context_usage");
    expect(result.route).toBe("fits");
  });

  it("formats all-route pre-prompt diagnostics for a fits decision", () => {
    const result = shouldPreemptivelyCompactBeforePrompt(shortHistoryInput());
    const line = formatPrePromptPrecheckLog({
      result,
      sessionKey: "discord:channel:thread",
      sessionId: "session-1",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      messageCount: 1,
      unwindowedMessageCount: 3,
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
      sessionFile: "sessions/session-1.json",
    });

    expect(line).toContain("[context-overflow-precheck] pre-prompt check");
    expect(line).toContain("sessionKey=discord:channel:thread");
    expect(line).toContain("provider=anthropic/claude-opus-4-6");
    expect(line).toContain("route=fits");
    expect(line).toContain(`estimatedPromptTokens=${result.estimatedPromptTokens}`);
    expect(line).toContain(`promptBudgetBeforeReserve=${result.promptBudgetBeforeReserve}`);
    expect(line).toContain("overflowTokens=0");
    expect(line).toContain(`toolResultReducibleChars=${result.toolResultReducibleChars}`);
    expect(line).toContain("reserveTokens=1000");
    expect(line).toContain(`effectiveReserveTokens=${result.effectiveReserveTokens}`);
    expect(line).toContain("contextTokenBudget=10000");
    expect(line).toContain("messages=1");
    expect(line).toContain("unwindowedMessages=3");
  });

  it("builds a durable estimated context budget status snapshot", () => {
    const result = shouldPreemptivelyCompactBeforePrompt(shortHistoryInput());

    const status = buildPrePromptContextBudgetStatus({
      result,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      messageCount: 1,
      unwindowedMessageCount: 3,
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
      sessionId: "session-1",
      now: 123,
    });

    expect(status).toMatchObject({
      schemaVersion: 1,
      source: "pre-prompt-estimate",
      updatedAt: 123,
      provider: "anthropic",
      model: "claude-opus-4-6",
      route: "fits",
      shouldCompact: false,
      contextTokenBudget: 10_000,
      promptBudgetBeforeReserve: result.promptBudgetBeforeReserve,
      reserveTokens: 1_000,
      effectiveReserveTokens: result.effectiveReserveTokens,
      overflowTokens: 0,
      messageCount: 1,
      unwindowedMessageCount: 3,
      sessionId: "session-1",
    });
    expect(status.remainingPromptBudgetTokens).toBe(
      result.promptBudgetBeforeReserve - result.estimatedPromptTokens,
    );
  });

  it("uses the larger unwindowed message estimate when explicitly provided", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("small assembled window")],
      unwindowedMessages: [makeAssistantHistory(verboseHistory.repeat(4))],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 500,
      reserveTokens: 50,
    });

    expect(result.shouldCompact).toBe(true);
    expect(result.route).toBe("compact_only");
    expect(result.estimatedPromptTokens).toBeGreaterThan(result.promptBudgetBeforeReserve);
  });

  it("uses rendered LLM-boundary pressure when the runtime owns the final payload shape", () => {
    // Runtime renderers can add large provider-facing payloads after transcript
    // assembly, so the precheck must prefer that boundary estimate when present.
    const renderedPrompt = "x".repeat(60_000);
    const estimatedPromptTokens = estimateRenderedLlmBoundaryTokenPressure({
      systemPrompt: "sys",
      prompt: renderedPrompt,
    });
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("the transcript view is intentionally small")],
      systemPrompt: "sys",
      prompt: "small prompt before runtime projection",
      contextTokenBudget: 16_000,
      reserveTokens: 4_000,
      llmBoundaryTokenPressure: {
        estimatedPromptTokens,
        source: "test_rendered_payload",
        renderedChars: renderedPrompt.length,
      },
    });

    expect(result.pressureSource).toBe("test_rendered_payload");
    expect(result.estimatedPromptTokens).toBe(estimatedPromptTokens);
    expect(result.route).toBe("compact_only");
    expect(result.shouldCompact).toBe(true);
  });

  it("counts array/object tool-result payloads at the LLM boundary", () => {
    const objectPayload = {
      rows: Array.from({ length: 120 }, (_, index) => ({
        path: `/tmp/generated-${index}.txt`,
        body: "x".repeat(1_500),
      })),
    };
    const messages = [makeJsonToolResultMessage(objectPayload)];
    const estimatedPromptTokens = estimateLlmBoundaryTokenPressure({
      messages,
      systemPrompt: "sys",
      prompt: "continue",
    });

    // The bodies alone contain 180k characters, beyond this 40k-token window.
    expect(estimatedPromptTokens).toBeGreaterThan(40_000);

    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "continue",
      contextTokenBudget: 40_000,
      reserveTokens: 20_000,
    });

    expect(result.route).not.toBe("fits");
    expect(result.estimatedPromptTokens).toBe(estimatedPromptTokens);
    expect(result.overflowTokens).toBeGreaterThan(0);
  });

  it("counts assistant tool-call arguments instead of trusting text-only token estimates", () => {
    const messages = [
      makeAssistantToolCall({
        queryPlan: "find relevant files",
        candidates: Array.from({ length: 100 }, (_, index) => ({
          path: `/repo/file-${index}.ts`,
          content: "z".repeat(1_000),
        })),
      }),
    ];
    const estimatedPromptTokens = estimateLlmBoundaryTokenPressure({
      messages,
      systemPrompt: "sys",
      prompt: "continue",
    });

    expect(estimatedPromptTokens).toBeGreaterThan(30_000);
  });

  it("caps reserve tokens so small context models keep usable prompt budget", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 16_000,
      reserveTokens: 20_000,
    });

    expect(result.effectiveReserveTokens).toBe(4_000);
    expect(result.promptBudgetBeforeReserve).toBe(12_000);
    expect(result.shouldCompact).toBe(false);
    expect(result.route).toBe("fits");
  });

  it("routes to compact then truncate when recent tool tails help but cannot fully cover the overflow", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(600);
    const longHistory = "old discussion with substantial retained context and decisions ".repeat(
      5000,
    );
    const messages = [
      makeAssistantHistory(longHistory),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
    ];
    const reserveTokens = 500;
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
      contextTokenBudget: 12_000,
      reserveTokens,
    });

    expect(result.route).toBe("compact_then_truncate");
    expect(result.shouldCompact).toBe(true);
    expect(result.overflowTokens).toBeGreaterThan(0);
    expect(result.toolResultReducibleChars).toBeGreaterThan(0);
  });

  it("treats mixed oversized-plus-aggregate tool tails as cumulative recovery potential", () => {
    const oversized = "x".repeat(45_000);
    const medium = "alpha beta gamma delta epsilon ".repeat(500);
    const messages: AgentMessage[] = [
      makeAssistantHistory("short history"),
      makeToolResultMessage(oversized),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
    ];
    const reserveTokens = 2_000;
    const estimatedPromptTokens = estimateLlmBoundaryTokenPressure({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
    });
    const potential = estimateToolResultReductionPotential({
      messages,
      contextWindowTokens: 20_000,
    });
    const desiredOverflowTokens = 2_000;
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: estimatedPromptTokens - desiredOverflowTokens + reserveTokens,
      reserveTokens,
    });

    expect(potential.oversizedCount).toBeGreaterThan(0);
    expect(potential.aggregateReducibleChars).toBeGreaterThan(0);
    expect(potential.maxReducibleChars).toBeGreaterThan(potential.aggregateReducibleChars);
    expect(potential.maxReducibleChars).toBeGreaterThan(desiredOverflowTokens * 4);
    expect(result.route).toBe("truncate_tool_results_only");
    expect(result.shouldCompact).toBe(false);
  });

  it("estimates CJK tool results at roughly one token per character", () => {
    const cjkText = "中".repeat(85_000);
    const toolResultTokens = estimateLlmBoundaryTokenPressure({
      messages: [makeToolResultMessage(cjkText)],
      systemPrompt: "sys",
      prompt: "continue",
    });
    const assistantTokens = estimateLlmBoundaryTokenPressure({
      messages: [makeAssistantHistory(cjkText)],
      systemPrompt: "sys",
      prompt: "continue",
    });
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeToolResultMessage(cjkText)],
      systemPrompt: "sys",
      prompt: "continue",
      contextTokenBudget: 128_000,
      reserveTokens: 20_000,
    });

    expect(toolResultTokens).toBeGreaterThanOrEqual(assistantTokens);
    expect(toolResultTokens - assistantTokens).toBeLessThanOrEqual(5);
    expect(result.estimatedPromptTokens).toBe(toolResultTokens);
    expect(result.promptBudgetBeforeReserve).toBeGreaterThan(result.estimatedPromptTokens);
    expect(result.route).toBe("fits");
    expect(result.shouldCompact).toBe(false);
    expect(result.overflowTokens).toBe(0);
  });

  it("includes tool schema tokens in the precheck estimate so large catalogs trigger overflow", () => {
    const messages = [makeAssistantHistory("short conversation text")];
    const contextTokenBudget = 128_000;
    const reserveTokens = 20_000;

    const withoutTools = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "continue",
      contextTokenBudget,
      reserveTokens,
    });

    const toolSchemaTokens = estimateToolSchemaTokenPressure(
      Array.from({ length: 79 }, (_, i) => ({
        name: `tool_${i}`,
        description: "x".repeat(4000),
        parameters: { type: "object", properties: { arg: { type: "string" } } },
      })),
    );

    expect(toolSchemaTokens).toBeGreaterThan(contextTokenBudget - reserveTokens);

    const withTools = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "continue",
      contextTokenBudget,
      reserveTokens,
      toolSchemaTokens,
    });

    expect(withoutTools.route).toBe("fits");
    expect(withTools.route).not.toBe("fits");
    expect(withTools.estimatedPromptTokens).toBeGreaterThan(withoutTools.estimatedPromptTokens);
    expect(withTools.overflowTokens).toBeGreaterThan(0);
  });

  it("does not double-count tool schema tokens when a provider boundary is available", () => {
    // The provider boundary totalTokens already includes the tool schemas from
    // its request. Adding toolSchemaTokens again would over-count an unchanged
    // catalog. This test verifies the fix: when a provider boundary exists,
    // toolSchemaTokens are not added on top of the boundary total.
    const providerTotal = 100_000;
    const messages = [
      makeProviderAssistant({ promptTokens: 80_000, totalTokens: providerTotal }),
      makeAssistantHistory("additional conversation after boundary"),
    ];
    const toolSchemaTokens = 40_000;
    const contextTokenBudget = 150_000;
    const reserveTokens = 20_000;

    const withoutToolSchema = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "continue",
      contextTokenBudget,
      reserveTokens,
    });

    const withToolSchema = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "continue",
      contextTokenBudget,
      reserveTokens,
      toolSchemaTokens,
    });

    // With a provider boundary, tool schema tokens must not inflate the estimate.
    expect(withToolSchema.estimatedPromptTokens).toBe(withoutToolSchema.estimatedPromptTokens);
    expect(withToolSchema.pressureSource).toBe("provider_context_usage");
  });

  it("does not throw when tool-result content cannot be serialized", () => {
    const circular: Record<string, unknown> = { self: undefined };
    circular.self = circular;
    const message = {
      role: "toolResult",
      toolCallId: "call_circular",
      toolName: "bad_tool",
      content: circular,
      isError: false,
      timestamp: timestamp++,
    } as unknown as AgentMessage;

    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [message],
      systemPrompt: "sys",
      prompt: "continue",
      contextTokenBudget: 128_000,
      reserveTokens: 20_000,
    });

    expect(Number.isFinite(result.estimatedPromptTokens)).toBe(true);
  });
});

function createUnavailableUsageHistory(params: Parameters<typeof makeUnavailableAssistant>[0]) {
  return [
    { role: "user", content: "x".repeat(1_000_000), timestamp: timestamp++ } as AgentMessage,
    makeProviderAssistant({ promptTokens: 179_900, totalTokens: 180_000 }),
    makeUnavailableAssistant(params),
  ];
}
