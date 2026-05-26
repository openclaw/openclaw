import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import "../../test-helpers/agent-session-token-mock.js";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";

let PREEMPTIVE_OVERFLOW_ERROR_TEXT: typeof import("./preemptive-compaction.js").PREEMPTIVE_OVERFLOW_ERROR_TEXT;
let estimateAppendOnlyLlmBoundaryTokenPressure: typeof import("./preemptive-compaction.js").estimateAppendOnlyLlmBoundaryTokenPressure;
let estimateLlmBoundaryTokenPressure: typeof import("./preemptive-compaction.js").estimateLlmBoundaryTokenPressure;
let buildPrePromptContextBudgetStatus: typeof import("./preemptive-compaction.js").buildPrePromptContextBudgetStatus;
let estimatePrePromptTokens: typeof import("./preemptive-compaction.js").estimatePrePromptTokens;
let estimateRenderedLlmBoundaryTokenPressure: typeof import("./preemptive-compaction.js").estimateRenderedLlmBoundaryTokenPressure;
let formatPrePromptPrecheckLog: typeof import("./preemptive-compaction.js").formatPrePromptPrecheckLog;
let shouldPreemptivelyCompactBeforePrompt: typeof import("./preemptive-compaction.js").shouldPreemptivelyCompactBeforePrompt;

beforeAll(async () => {
  vi.resetModules();
  ({
    PREEMPTIVE_OVERFLOW_ERROR_TEXT,
    estimateAppendOnlyLlmBoundaryTokenPressure,
    estimateLlmBoundaryTokenPressure,
    buildPrePromptContextBudgetStatus,
    estimatePrePromptTokens,
    estimateRenderedLlmBoundaryTokenPressure,
    formatPrePromptPrecheckLog,
    shouldPreemptivelyCompactBeforePrompt,
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

function makeToolResultMessage(...texts: string[]): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call_${timestamp}`,
    toolName: "read",
    content: texts.map((text) => ({ type: "text", text })),
    isError: false,
    timestamp: timestamp++,
  } as AgentMessage;
}

function makeJsonToolResultMessage(payload: unknown): AgentMessage {
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
  const verboseHistory =
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ".repeat(40);
  const verboseSystem =
    "system guidance with multiple distinct words to avoid tokenizer overcompression ".repeat(25);
  const verbosePrompt =
    "user request with distinct content asking for a detailed answer and more context ".repeat(25);

  it("exports a context-overflow-compatible precheck error text", () => {
    expect(PREEMPTIVE_OVERFLOW_ERROR_TEXT).toContain("Context overflow:");
    expect(PREEMPTIVE_OVERFLOW_ERROR_TEXT).toContain("(precheck)");
  });

  it("raises the estimate as prompt-side content grows", () => {
    const smaller = estimatePrePromptTokens({
      messages: [makeAssistantHistory(verboseHistory)],
      systemPrompt: "sys",
      prompt: "hello",
    });
    const larger = estimatePrePromptTokens({
      messages: [makeAssistantHistory(verboseHistory)],
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
    });

    expect(larger).toBeGreaterThan(smaller);
  });

  it("requests preemptive compaction when the reserve-based prompt budget would be exceeded", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory(verboseHistory)],
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
      contextTokenBudget: 500,
      reserveTokens: 50,
    });

    expect(result.shouldCompact).toBe(true);
    expect(result.route).toBe("compact_only");
    expect(result.estimatedPromptTokens).toBeGreaterThan(result.promptBudgetBeforeReserve);
  });

  it("does not request preemptive compaction when the reserve-based prompt budget still fits", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
    });

    expect(result.shouldCompact).toBe(false);
    expect(result.route).toBe("fits");
    expect(result.estimatedPromptTokens).toBeLessThan(result.promptBudgetBeforeReserve);
  });

  it("formats all-route pre-prompt diagnostics for a fits decision", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
    });
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
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
    });

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

    expect(estimatedPromptTokens).toBeGreaterThan(80_000);

    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "continue",
      contextTokenBudget: 96_000,
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
    const estimatedPromptTokens = estimatePrePromptTokens({
      messages,
      systemPrompt: "sys",
      prompt: "continue",
    });

    expect(estimatedPromptTokens).toBeGreaterThan(30_000);
  });

  it("prechecks a regression-sized synthetic tool-heavy transcript as over budget", () => {
    const toolResultCharsPerMessage = Math.ceil(427_000 / 120);
    const generalCharsPerMessage = Math.ceil((503_000 - 427_000) / 121);
    const messages: AgentMessage[] = [];
    for (let index = 0; index < 241; index += 1) {
      if (index % 2 === 0) {
        messages.push(
          makeToolResultMessage(
            "t".repeat(toolResultCharsPerMessage),
            JSON.stringify({ index, payload: "p".repeat(80) }),
          ),
        );
      } else {
        messages.push(makeAssistantHistory("h".repeat(generalCharsPerMessage)));
      }
    }

    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "system".repeat(200),
      prompt: "continue",
      contextTokenBudget: 200_000,
      reserveTokens: 32_000,
    });

    expect(result.estimatedPromptTokens).toBeGreaterThan(200_000);
    expect(result.promptBudgetBeforeReserve).toBe(168_000);
    expect(result.route).not.toBe("fits");
    expect(result.overflowTokens).toBeGreaterThan(0);
  });

  it("caps reserve tokens so small context models keep usable prompt budget", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 16_000,
      reserveTokens: 20_000,
    });

    expect(result.effectiveReserveTokens).toBe(8_000);
    expect(result.promptBudgetBeforeReserve).toBe(8_000);
    expect(result.shouldCompact).toBe(false);
    expect(result.route).toBe("fits");
  });

  it("keeps the requested reserve when it leaves enough prompt budget", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 32_000,
      reserveTokens: 20_000,
    });

    expect(result.effectiveReserveTokens).toBe(20_000);
    expect(result.promptBudgetBeforeReserve).toBe(12_000);
    expect(result.shouldCompact).toBe(false);
  });

  it("routes to direct tool-result truncation when recent tool tails can clearly absorb the overflow", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(2200);
    const messages: AgentMessage[] = [
      makeAssistantHistory("short history"),
      makeToolResultMessage(medium, medium, medium, medium),
    ];
    const reserveTokens = 2_000;
    const contextTokenBudget = 26_000;
    const estimatedPromptTokens = estimatePrePromptTokens({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
    });
    const desiredOverflowTokens = 200;
    const adjustedContextTokenBudget =
      estimatedPromptTokens - desiredOverflowTokens + reserveTokens;
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: Math.max(contextTokenBudget, adjustedContextTokenBudget),
      reserveTokens,
    });

    expect(result.route).toBe("truncate_tool_results_only");
    expect(result.shouldCompact).toBe(false);
    expect(result.overflowTokens).toBeGreaterThan(0);
    expect(result.toolResultReducibleChars).toBeGreaterThan(0);
  });

  it("routes to compact then truncate when recent tool tails help but cannot fully cover the overflow", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(220);
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
    ];
    const reserveTokens = 2_000;
    const estimatedPromptTokens = estimatePrePromptTokens({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
    });
    const potential = estimateToolResultReductionPotential({
      messages,
      contextWindowTokens: 128_000,
    });
    const desiredOverflowTokens = 2_000;
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: estimatedPromptTokens - desiredOverflowTokens + reserveTokens,
      reserveTokens,
    });

    expect(potential.oversizedReducibleChars).toBeGreaterThan(0);
    expect(potential.aggregateReducibleChars).toBeGreaterThan(0);
    expect(potential.oversizedReducibleChars).toBeLessThan(potential.maxReducibleChars);
    expect(potential.maxReducibleChars).toBeGreaterThan(desiredOverflowTokens * 4);
    expect(result.route).toBe("truncate_tool_results_only");
    expect(result.shouldCompact).toBe(false);
  });

  describe("public estimator freshness", () => {
    it("returns the same boundary estimate on repeat scans of the same unchanged messages", () => {
      const messages: AgentMessage[] = [
        makeAssistantHistory("alpha bravo charlie ".repeat(8)),
        makeToolResultMessage("result one ".repeat(6), "result two ".repeat(4)),
        makeAssistantToolCall({ k: "v".repeat(200) }),
      ];
      const first = estimateLlmBoundaryTokenPressure({
        messages,
        systemPrompt: "sys",
        prompt: "ping",
      });
      const second = estimateLlmBoundaryTokenPressure({
        messages,
        systemPrompt: "sys",
        prompt: "ping",
      });
      expect(second).toBe(first);
    });

    it("re-reads content after in-place mutation so SDK callers see fresh estimates", () => {
      // estimateLlmBoundaryTokenPressure is re-exported through
      // src/plugin-sdk/agent-harness-runtime.ts. Plugin SDK callers may reuse
      // and mutate AgentMessage objects across calls, so the public helper must
      // always recount from current content. The append-only WeakMap cache lives
      // on the internal estimateAppendOnlyLlmBoundaryTokenPressure helper, which
      // is not part of the SDK surface.
      const messages: AgentMessage[] = [
        makeAssistantHistory("baseline content ".repeat(10)),
        makeToolResultMessage("baseline tool result ".repeat(8)),
      ];
      const baseline = estimateLlmBoundaryTokenPressure({
        messages,
        systemPrompt: "sys",
        prompt: "ping",
      });
      const assistantContent = (
        messages[0] as unknown as { content: { type: string; text: string }[] }
      ).content;
      assistantContent[0].text = `${assistantContent[0].text} ${"X".repeat(5_000)}`;
      const afterMutation = estimateLlmBoundaryTokenPressure({
        messages,
        systemPrompt: "sys",
        prompt: "ping",
      });
      expect(afterMutation).toBeGreaterThan(baseline);
    });

    it("shouldPreemptivelyCompactBeforePrompt recomputes pressure on mutated content by default", () => {
      const messages: AgentMessage[] = [makeAssistantHistory("seed ".repeat(20))];
      const before = shouldPreemptivelyCompactBeforePrompt({
        messages,
        systemPrompt: "sys",
        prompt: "ping",
        contextTokenBudget: 8_000,
        reserveTokens: 256,
      });
      const assistantContent = (
        messages[0] as unknown as { content: { type: string; text: string }[] }
      ).content;
      assistantContent[0].text = `${assistantContent[0].text} ${"Y".repeat(20_000)}`;
      const after = shouldPreemptivelyCompactBeforePrompt({
        messages,
        systemPrompt: "sys",
        prompt: "ping",
        contextTokenBudget: 8_000,
        reserveTokens: 256,
      });
      expect(after.estimatedPromptTokens).toBeGreaterThan(before.estimatedPromptTokens);
    });

    it("recounts duplicate message identities so repeated entries add their bytes", () => {
      const shared = makeAssistantHistory("shared content ".repeat(20));
      const standalone = estimateLlmBoundaryTokenPressure({
        messages: [shared],
        systemPrompt: "sys",
        prompt: "ping",
      });
      const doubled = estimateLlmBoundaryTokenPressure({
        messages: [shared, shared],
        systemPrompt: "sys",
        prompt: "ping",
      });
      const empty = estimateLlmBoundaryTokenPressure({
        messages: [],
        systemPrompt: "sys",
        prompt: "ping",
      });
      expect(doubled - standalone).toBeGreaterThanOrEqual(standalone - empty - 1);
      expect(doubled - standalone).toBeLessThanOrEqual(standalone - empty + 1);
    });
  });

  describe("internal append-only cached estimator", () => {
    it("matches the fresh public helper on a single scan", () => {
      const messages: AgentMessage[] = [
        makeAssistantHistory("identical content ".repeat(8)),
        makeToolResultMessage("identical tool result ".repeat(6)),
      ];
      const fresh = estimateLlmBoundaryTokenPressure({
        messages,
        systemPrompt: "sys",
        prompt: "ping",
      });
      const cached = estimateAppendOnlyLlmBoundaryTokenPressure({
        messages,
        systemPrompt: "sys",
        prompt: "ping",
      });
      expect(cached).toBe(fresh);
    });

    it("reflects a new message identity appended after a prior scan", () => {
      const transcript: AgentMessage[] = [makeAssistantHistory("seed message ".repeat(6))];
      const before = estimateAppendOnlyLlmBoundaryTokenPressure({
        messages: transcript,
        systemPrompt: "sys",
        prompt: "ping",
      });
      const onlyNew = makeAssistantHistory("freshly appended ".repeat(6));
      const onlyNewTokens = estimateAppendOnlyLlmBoundaryTokenPressure({
        messages: [onlyNew],
        systemPrompt: "",
        prompt: "",
      });
      const baseline = estimateAppendOnlyLlmBoundaryTokenPressure({
        messages: [],
        systemPrompt: "sys",
        prompt: "ping",
      });
      const after = estimateAppendOnlyLlmBoundaryTokenPressure({
        messages: [...transcript, onlyNew],
        systemPrompt: "sys",
        prompt: "ping",
      });
      expect(after).toBeGreaterThan(before);
      expect(after - before).toBeLessThanOrEqual(onlyNewTokens + baseline);
    });

    it("adds the per-message cost for each duplicate identity without short-circuiting on cache hit", () => {
      // Guards against a regression where a "seen" flag instead of the per-message
      // cost in the WeakMap would silently drop the second occurrence's bytes.
      const shared = makeAssistantHistory("shared content ".repeat(20));
      const standalone = estimateAppendOnlyLlmBoundaryTokenPressure({
        messages: [shared],
        systemPrompt: "sys",
        prompt: "ping",
      });
      const doubled = estimateAppendOnlyLlmBoundaryTokenPressure({
        messages: [shared, shared],
        systemPrompt: "sys",
        prompt: "ping",
      });
      const empty = estimateAppendOnlyLlmBoundaryTokenPressure({
        messages: [],
        systemPrompt: "sys",
        prompt: "ping",
      });
      expect(doubled - standalone).toBeGreaterThanOrEqual(standalone - empty - 1);
      expect(doubled - standalone).toBeLessThanOrEqual(standalone - empty + 1);
    });

    it("counts assistant tool-call argument bytes identically on repeat scans", () => {
      const heavyArgs = { payload: "X".repeat(20_000) };
      const messages = [makeAssistantToolCall(heavyArgs)];
      const cold = estimateAppendOnlyLlmBoundaryTokenPressure({
        messages,
        systemPrompt: "",
        prompt: "",
      });
      const warm = estimateAppendOnlyLlmBoundaryTokenPressure({
        messages,
        systemPrompt: "",
        prompt: "",
      });
      expect(warm).toBe(cold);
    });

    it("is not re-exported through the plugin SDK surface", () => {
      // The append-only cached estimator must stay an internal embedded-runner
      // helper. Reading the SDK file directly guards against an accidental
      // future re-export through src/plugin-sdk/agent-harness-runtime.ts.
      const sdkPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../plugin-sdk/agent-harness-runtime.ts",
      );
      const sdk = readFileSync(sdkPath, "utf8");
      expect(sdk).not.toContain("estimateAppendOnlyLlmBoundaryTokenPressure");
    });
  });
});
