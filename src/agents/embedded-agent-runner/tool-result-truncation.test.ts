// Tool-result truncation tests cover live and persisted shrinking of oversized
// tool outputs while preserving transcript shape and update notifications.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "openclaw/plugin-sdk/llm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import type { SessionEntry as SessionStoreEntry } from "../../config/sessions/types.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { formatFullOutputFooter } from "../sessions/tools/tool-contracts.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { resolveAutoLiveToolResultMaxChars } from "../tool-result-limits.js";
import { prepareEmbeddedAttemptPromptContext } from "./run/attempt-prompt-build.js";
import { buildRuntimeContextCustomMessage } from "./run/runtime-context-prompt.js";
import {
  clearEmbeddedSessionPromptStates,
  createToolResultPromptProjectionState,
  getEmbeddedSessionPromptState,
  type ToolResultPromptProjectionState,
} from "./session-prompt-state.js";

let truncateToolResultMessage: typeof import("./tool-result-truncation.js").truncateToolResultMessage;
let truncateOversizedToolResultsInMessages: typeof import("./tool-result-truncation.js").truncateOversizedToolResultsInMessages;
let truncateOversizedToolResultsInSessionManager: typeof import("./tool-result-truncation.js").truncateOversizedToolResultsInSessionManager;
let sessionLikelyHasOversizedToolResults: typeof import("./tool-result-truncation.js").sessionLikelyHasOversizedToolResults;
let estimateToolResultReductionPotential: typeof import("./tool-result-truncation.js").estimateToolResultReductionPotential;
let resolveLiveToolResultMaxChars: typeof import("./tool-result-truncation.js").resolveLiveToolResultMaxChars;
let resolveLiveToolResultAggregateMaxChars: typeof import("./tool-result-truncation.js").resolveLiveToolResultAggregateMaxChars;
let toolResultWarningDedupe: typeof import("./tool-result-truncation.js").toolResultWarningDedupe;
let tmpDir: string | undefined;
const sessionDirs = useSessionStoreTempDirs(afterAll, "tool-result-truncation-test-");

async function loadFreshToolResultTruncationModuleForTest() {
  // Load after each setup so module-level constants and mocks stay isolated
  // across persisted-session and live-truncation tests.
  ({
    truncateToolResultMessage,
    truncateOversizedToolResultsInMessages,
    truncateOversizedToolResultsInSessionManager,
    sessionLikelyHasOversizedToolResults,
    estimateToolResultReductionPotential,
    resolveLiveToolResultMaxChars,
    resolveLiveToolResultAggregateMaxChars,
    toolResultWarningDedupe,
  } = await import("./tool-result-truncation.js"));
}

let testTimestamp = 1;
const nextTimestamp = () => testTimestamp++;

function createPromptProjectionStateForTest(): ToolResultPromptProjectionState {
  return {
    replacements: new Map(),
    frozen: new Set(),
    ambiguousBaseKeys: new Set(),
    restoredCacheTtl: new Map(),
    sourceHashByKey: new Map(),
  };
}

beforeEach(async () => {
  testTimestamp = 1;
  await loadFreshToolResultTruncationModuleForTest();
});

afterEach(async () => {
  toolResultWarningDedupe.promptPressure.clear();
  toolResultWarningDedupe.sessionRecovery.clear();
  clearEmbeddedSessionPromptStates([
    "session-99495",
    "session-99495-reclamation",
    "session-99495-shrink",
  ]);
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    tmpDir = undefined;
  }
});

function makeToolResult(text: string, toolCallId = "call_1", details?: unknown): ToolResultMessage {
  // Tool-result fixtures use increasing timestamps so persisted branch rewrites
  // can preserve ordering while changing content.
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    ...(details !== undefined ? { details } : {}),
    timestamp: nextTimestamp(),
  };
}

async function preparePromptProjectionStateForTest(params: {
  sessionId: string;
  messages: AgentMessage[];
  state: ToolResultPromptProjectionState;
  raw?: boolean;
}) {
  const prompt = params.raw ? "raw probe" : "continue";
  await prepareEmbeddedAttemptPromptContext({
    capabilityToolNames: new Set(),
    attempt: {
      config: {},
      contextTokenBudget: 128_000,
      sessionId: params.sessionId,
      sessionKey: `agent:main:${params.sessionId}`,
      suppressNextUserMessagePersistence: false,
    },
    includeBoundaryTimestamp: false,
    isRawModelRun: params.raw ?? false,
    messages: params.messages,
    prompt: {
      effectivePrompt: prompt,
      effectiveTranscriptPrompt: prompt,
    },
    replaceSessionMessages: () => {},
    sessionAgentId: "main",
    systemPromptText: params.raw ? "" : "system",
    toolResultPromptProjectionState: params.state,
  });
}

describe("tool-result warning dedupe", () => {
  const warningDedupeLimit = 1_024;

  it.each([
    ["prompt pressure", () => toolResultWarningDedupe.promptPressure],
    ["session recovery", () => toolResultWarningDedupe.sessionRecovery],
  ])("bounds and evicts the oldest %s warning keys", (_name, getCache) => {
    const cache = getCache();

    for (let index = 0; index <= warningDedupeLimit; index += 1) {
      expect(cache.check(`session-${index}`)).toBe(false);
    }

    expect(cache.size()).toBe(warningDedupeLimit);
    expect(cache.peek("session-0")).toBe(false);
    expect(cache.peek("session-1")).toBe(true);
    expect(cache.peek(`session-${warningDedupeLimit}`)).toBe(true);
    expect(cache.check("session-0")).toBe(false);
    expect(cache.check(`session-${warningDedupeLimit}`)).toBe(true);
  });
});

function textWithFullOutputFooter(text: string, fullOutputPath: string): string {
  return `${text}\n\n[Showing truncated output. ${formatFullOutputFooter(fullOutputPath)}]`;
}

function realisticSpillPath(dir: string, name: string): string {
  return path.join(dir, `${name}-${"segment-".repeat(8)}output.log`);
}

function makeUserMessage(text: string): UserMessage {
  return {
    role: "user",
    content: text,
    timestamp: nextTimestamp(),
  };
}

function makeAssistantMessage(text: string): AssistantMessage {
  return makeAgentAssistantMessage({
    content: [{ type: "text", text }],
    model: "gpt-5.2",
    stopReason: "stop",
    timestamp: nextTimestamp(),
  });
}

function getFirstToolResultText(message: AgentMessage | ToolResultMessage): string {
  if (message.role !== "toolResult") {
    return "";
  }
  const firstBlock = message.content[0];
  return firstBlock && "text" in firstBlock ? firstBlock.text : "";
}

function truncateToolResultText(
  text: string,
  maxChars: number,
  options?: Parameters<typeof truncateToolResultMessage>[2],
): string {
  return getFirstToolResultText(truncateToolResultMessage(makeToolResult(text), maxChars, options));
}

function calculateMaxToolResultChars(contextWindowTokens: number): number {
  return resolveLiveToolResultMaxChars({ contextWindowTokens });
}

function getToolResultTextLength(message: AgentMessage): number {
  if (message.role !== "toolResult") {
    return 0;
  }
  return message.content.reduce((length, block) => {
    if (!block || typeof block !== "object" || !("text" in block)) {
      return length;
    }
    return length + (typeof block.text === "string" ? block.text.length : 0);
  }, 0);
}

async function createTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-result-truncation-test-"));
  return tmpDir;
}

async function createShortTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "oc-"));
  return tmpDir;
}

describe("truncateToolResultText", () => {
  it("supports custom suffix and min keep chars", () => {
    const text = "x".repeat(5_000);
    const result = truncateToolResultText(text, 300, {
      suffix: () => "\n\n[custom-truncated]",
      minKeepChars: 250,
    });
    expect(result).toContain("[custom-truncated]");
    expect(result.length).toBeGreaterThan(250);
  });

  it.each([
    { text: "aaa😀z", maxChars: 5, suffix: () => "!", minKeepChars: 0, expected: "aaa!" },
    { text: "abcdef", maxChars: 1, suffix: () => "😀", minKeepChars: 0, expected: "" },
    {
      text: "x".repeat(100),
      maxChars: 4,
      suffix: (truncatedChars: number) => `[${truncatedChars}]`,
      minKeepChars: 1,
      expected: "[100",
    },
  ])(
    "bounds suffix-only and code-point cuts at $maxChars chars",
    ({ text, maxChars, suffix, minKeepChars, expected }) => {
      expect(truncateToolResultText(text, maxChars, { suffix, minKeepChars })).toBe(expected);
    },
  );

  it.each(["m", "你𠀀😀"])(
    "keeps both head and tail cuts on complete code points (%s)",
    (middle) => {
      const marker = "\n\n⚠️ [... middle content omitted — showing head and tail ...]\n\n";
      const text = `${"a".repeat(6)}😀${middle.repeat(100)}😀${"x".repeat(22)} Error`;
      expect(
        truncateToolResultText(text, 100, {
          suffix: () => "!",
          minKeepChars: 1,
        }),
      ).toBe(`${"a".repeat(6)}${marker}${"x".repeat(22)} Error!`);
    },
  );
});

describe("truncateToolResultMessage", () => {
  it("truncates Codex protocol toolResult content blocks and mirrored content", () => {
    const oversized = "x".repeat(50_000);
    const msg = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "exec",
      content: [
        {
          type: "toolResult",
          toolUseId: "call_1",
          text: oversized,
          content: oversized,
        },
      ],
      isError: false,
      timestamp: nextTimestamp(),
    } as unknown as ToolResultMessage;

    const result = truncateToolResultMessage(msg, 10_000, {
      suffix: () => "\n\n[persist-truncated]",
      minKeepChars: 2_000,
    });
    expect(result.role).toBe("toolResult");
    if (result.role !== "toolResult") {
      throw new Error("expected toolResult");
    }
    const firstBlock = result.content[0] as unknown as { text?: unknown; content?: unknown };
    expect(typeof firstBlock.text).toBe("string");
    expect(firstBlock.text).toContain("[persist-truncated]");
    expect(String(firstBlock.text).length).toBeLessThan(oversized.length);
    expect(firstBlock.content).toBe(firstBlock.text);
  });

  it("truncates dense CJK by weighted budget while leaving same-size ASCII unchanged", () => {
    const maxChars = 16_000;
    const asciiMessage = makeToolResult("a".repeat(maxChars));
    expect(truncateToolResultMessage(asciiMessage, maxChars)).toBe(asciiMessage);

    const cjk = "你".repeat(maxChars);
    const cjkMessage = makeToolResult(cjk);
    const result = truncateToolResultMessage(cjkMessage, maxChars);
    const resultText = getFirstToolResultText(result);

    expect(result).not.toBe(cjkMessage);
    expect(resultText.length).toBeLessThan(cjk.length);
    expect(estimateStringChars(resultText)).toBeLessThanOrEqual(maxChars);
    expect(resultText).toContain("truncated");
  });

  it.each([
    {
      kind: "mixed CJK/ASCII",
      texts: ["你".repeat(1_000), "a".repeat(4_000)],
      maxChars: 4_000,
      options: undefined,
    },
    {
      kind: "small blocks",
      texts: ["a".repeat(50), "b".repeat(50), "c".repeat(500)],
      maxChars: 100,
      options: { suffix: () => "!", minKeepChars: 99 },
    },
    {
      kind: "empty blocks",
      texts: [...Array<string>(150).fill(""), "x".repeat(500)],
      maxChars: 100,
      options: { suffix: () => "!", minKeepChars: 0 },
    },
  ])("reserves the weighted notice budget for $kind", ({ kind, texts, maxChars, options }) => {
    const msg = {
      ...makeToolResult("unused"),
      content: texts.map((text) => ({ type: "text" as const, text })),
    };
    const result = truncateToolResultMessage(msg, maxChars, options);
    expect(result.role).toBe("toolResult");
    if (result.role !== "toolResult") {
      throw new Error("expected toolResult");
    }
    const output = result.content.map((block) => (block.type === "text" ? block.text : ""));
    expect(output.reduce((sum, text) => sum + estimateStringChars(text), 0)).toBeLessThanOrEqual(
      maxChars,
    );
    if (kind === "mixed CJK/ASCII") {
      expect(result.content).toHaveLength(2);
    } else if (kind === "small blocks") {
      expect(output[2]).toContain("!");
      expect(output.every((text) => text.length > 0)).toBe(true);
    } else {
      expect(
        result.content.slice(0, -1).every((block) => block.type !== "text" || block.text === ""),
      ).toBe(true);
      expect(output.at(-1)).toMatch(/!$/u);
    }
  });
});

describe("calculateMaxToolResultChars", () => {
  it.each([
    { contextWindowTokens: 8_000, perResultMaxChars: 9_600, aggregateMaxChars: 38_400 },
    { contextWindowTokens: 20_000, perResultMaxChars: 16_000, aggregateMaxChars: 64_000 },
    { contextWindowTokens: 128_000, perResultMaxChars: 32_000, aggregateMaxChars: 256_000 },
    { contextWindowTokens: 200_000, perResultMaxChars: 64_000, aggregateMaxChars: 400_000 },
    { contextWindowTokens: 1_000_000, perResultMaxChars: 64_000, aggregateMaxChars: 2_000_000 },
  ])(
    "resolves aggregate live cap for $contextWindowTokens token windows",
    ({ contextWindowTokens, perResultMaxChars, aggregateMaxChars }) => {
      expect(calculateMaxToolResultChars(contextWindowTokens)).toBe(perResultMaxChars);
      if (contextWindowTokens === 200_000) {
        expect(resolveAutoLiveToolResultMaxChars(contextWindowTokens)).toBe(64_000);
        expect(perResultMaxChars).toBeGreaterThan(calculateMaxToolResultChars(8_000));
      }
      expect(
        resolveLiveToolResultAggregateMaxChars({
          contextWindowTokens,
          perResultMaxChars,
        }),
      ).toBe(aggregateMaxChars);
    },
  );
});

describe("sessionLikelyHasOversizedToolResults", () => {
  it.each([
    { kind: "CJK", text: "你".repeat(5_000), count: 1, contextWindowTokens: 50_000 },
    { kind: "oversized", text: "x".repeat(500_000), count: 1, contextWindowTokens: 128_000 },
    {
      kind: "aggregate",
      text: "alpha beta gamma delta epsilon ".repeat(500),
      count: 6,
      contextWindowTokens: 20_000,
    },
  ])("detects $kind pressure", ({ text, count, contextWindowTokens }) => {
    const messages = Array.from({ length: count }, (_, index) =>
      makeToolResult(text, `call_${index}`),
    );
    expect(sessionLikelyHasOversizedToolResults({ messages, contextWindowTokens })).toBe(true);
  });
});

describe("estimateToolResultReductionPotential", () => {
  type Estimate = ReturnType<typeof estimateToolResultReductionPotential>;
  it.each([
    {
      kind: "small",
      texts: ["small result"],
      contextWindowTokens: 128_000,
      check: (estimate: Estimate) => {
        expect(estimate.toolResultCount).toBe(1);
        expect(estimate.maxReducibleChars).toBe(0);
      },
    },
    {
      kind: "aggregate",
      texts: Array<string>(6).fill("alpha beta gamma delta epsilon ".repeat(400)),
      contextWindowTokens: 20_000,
      check: (estimate: Estimate) => {
        expect(estimate.toolResultCount).toBe(6);
        expect(estimate.oversizedCount).toBe(0);
        expect(estimate.aggregateReducibleChars).toBeGreaterThan(0);
        expect(estimate.maxReducibleChars).toBe(estimate.aggregateReducibleChars);
      },
    },
    {
      kind: "mixed",
      texts: [
        "x".repeat(500_000),
        ...Array<string>(2).fill("alpha beta gamma delta epsilon ".repeat(800)),
      ],
      contextWindowTokens: 128_000,
      aggregateMaxCharsOverride: 50_000,
      check: (estimate: Estimate) => {
        expect(estimate.oversizedCount).toBeGreaterThan(0);
        expect(estimate.oversizedReducibleChars).toBeGreaterThan(0);
        expect(estimate.aggregateReducibleChars).toBeGreaterThan(0);
        expect(estimate.maxReducibleChars).toBe(
          estimate.oversizedReducibleChars + estimate.aggregateReducibleChars,
        );
      },
    },
    {
      kind: "explicit cap",
      texts: Array<string>(3).fill("alpha beta gamma delta epsilon ".repeat(600)),
      contextWindowTokens: 128_000,
      maxCharsOverride: 120,
      aggregateMaxCharsOverride: 120,
      check: (estimate: Estimate) => {
        expect(estimate.maxChars).toBe(120);
        expect(estimate.aggregateBudgetChars).toBe(120);
        expect(estimate.oversizedCount).toBe(3);
        expect(estimate.aggregateReducibleChars).toBeGreaterThan(0);
      },
    },
  ])("estimates $kind recovery savings", ({ texts, check, ...budgets }) => {
    check(
      estimateToolResultReductionPotential({
        ...budgets,
        messages: texts.map((text, index) => makeToolResult(text, `call_${index}`)),
      }),
    );
  });
});

describe("truncateOversizedToolResultsInMessages", () => {
  it("returns unchanged messages when nothing is oversized", () => {
    const messages = [
      makeUserMessage("hello"),
      makeAssistantMessage("using tool"),
      makeToolResult("small result"),
    ];
    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      200_000,
    );
    expect(truncatedCount).toBe(0);
    expect(result).toEqual(messages);
  });

  it("truncates multiple oversized tool results", () => {
    const messages: AgentMessage[] = [
      makeUserMessage("hello"),
      makeAssistantMessage("reading files"),
      makeToolResult("x".repeat(500_000), "call_1"),
      makeToolResult("y".repeat(500_000), "call_2"),
    ];
    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      128_000,
    );
    expect(truncatedCount).toBe(2);
    for (const msg of result.slice(2)) {
      expect(msg.role).toBe("toolResult");
      const text = getFirstToolResultText(msg);
      expect(text.length).toBeLessThan(500_000);
      expect(text).toContain("truncated");
    }
  });

  it("applies the aggregate cap to CJK-weighted prompt history", () => {
    const messages = Array.from({ length: 6 }, (_, index) =>
      makeToolResult("你".repeat(3_000), `call_${index}`),
    );

    const result = truncateOversizedToolResultsInMessages(messages, 20_000);
    const estimated = result.messages.reduce(
      (sum, message) =>
        sum +
        (message.role === "toolResult" ? estimateStringChars(getFirstToolResultText(message)) : 0),
      0,
    );

    expect(result.aggregateTruncatedCount).toBeGreaterThan(0);
    expect(estimated).toBeLessThanOrEqual(result.aggregateBudgetChars);
  });

  it("bounds aggregate tool-result text in prompt history without rewriting callers", () => {
    // Live replay truncates cloned tool-result messages; the source array keeps
    // full content for UI and transcript persistence.
    const medium = "alpha beta gamma delta epsilon ".repeat(800);
    const messages: AgentMessage[] = [
      makeUserMessage("hello"),
      makeAssistantMessage("calling tools"),
      makeToolResult(medium, "call_1"),
      makeToolResult(medium, "call_2"),
      makeToolResult(medium, "call_3"),
    ];

    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      128_000,
      12_000,
      12_000,
    );

    const totalChars = result.reduce(
      (sum, message) =>
        sum + (message.role === "toolResult" ? getToolResultTextLength(message) : 0),
      0,
    );
    expect(truncatedCount).toBeGreaterThan(0);
    expect(totalChars).toBeLessThanOrEqual(12_000);
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
    expect(messages.reduce((sum, message) => sum + getToolResultTextLength(message), 0)).toBe(
      medium.length * 3,
    );
  });

  it("keeps prompt projections stable while enforcing aggregate recovery as history grows", () => {
    const prefix = [
      makeToolResult("p".repeat(15_000), "prefix_1"),
      makeToolResult("q".repeat(15_000), "prefix_2"),
    ];
    const suffix = [
      makeToolResult("x".repeat(15_000), "current_1"),
      makeToolResult("y".repeat(15_000), "current_2"),
    ];
    const messages = [...prefix, ...suffix];
    const projectionState = createPromptProjectionStateForTest();

    const first = truncateOversizedToolResultsInMessages(
      messages,
      128_000,
      12_000,
      12_000,
      projectionState,
    );
    const second = truncateOversizedToolResultsInMessages(
      [...messages, makeToolResult("z".repeat(15_000), "current_3")],
      128_000,
      12_000,
      12_000,
      projectionState,
    );

    expect(first.truncatedCount).toBe(4);
    expect(second.truncatedCount).toBe(1);
    expect(second.messages.every((message) => getToolResultTextLength(message) <= 12_000)).toBe(
      true,
    );
    expect(messages).toEqual([...prefix, ...suffix]);

    const stableState = createPromptProjectionStateForTest();
    const stableHistory = [
      makeToolResult("a".repeat(4_000), "stable_1"),
      makeToolResult("b".repeat(4_000), "stable_2"),
    ];
    const stableFirst = truncateOversizedToolResultsInMessages(
      stableHistory,
      128_000,
      12_000,
      12_000,
      stableState,
    );
    const stableSecond = truncateOversizedToolResultsInMessages(
      [...stableHistory, makeToolResult("c".repeat(3_000), "stable_3")],
      128_000,
      12_000,
      12_000,
      stableState,
    );
    expect(stableFirst.truncatedCount).toBe(0);
    expect(stableSecond.messages.slice(0, stableHistory.length)).toEqual(stableFirst.messages);
    const stableThird = truncateOversizedToolResultsInMessages(
      [
        ...stableHistory,
        makeToolResult("c".repeat(3_000), "stable_3"),
        makeToolResult("d".repeat(15_000), "stable_4"),
      ],
      128_000,
      12_000,
      12_000,
      stableState,
    );
    expect(stableThird.messages).toHaveLength(4);
    const stableFourth = truncateOversizedToolResultsInMessages(
      [
        ...stableHistory,
        makeToolResult("c".repeat(3_000), "stable_3"),
        makeToolResult("d".repeat(15_000), "stable_4"),
        makeToolResult("e".repeat(15_000), "stable_5"),
      ],
      128_000,
      12_000,
      12_000,
      stableState,
    );
    const lastText = stableFourth.messages.at(-1);
    expect(lastText && getToolResultTextLength(lastText)).toBeLessThanOrEqual(12_000);
  });

  it("keeps #99495 historical bytes stable across attempts sharing session state", () => {
    const state = getEmbeddedSessionPromptState("session-99495").toolResults;
    const history = [
      makeToolResult("a".repeat(4_000), "history_1"),
      makeToolResult("b".repeat(4_000), "history_2"),
    ];
    const first = truncateOversizedToolResultsInMessages(history, 128_000, 5_000, 20_000, state);
    const secondAttemptState = getEmbeddedSessionPromptState("session-99495").toolResults;
    const second = truncateOversizedToolResultsInMessages(
      [...history, makeToolResult("c".repeat(12_000), "current")],
      128_000,
      5_000,
      20_000,
      secondAttemptState,
    );

    expect(secondAttemptState).toBe(state);
    expect(second.messages.slice(0, history.length)).toEqual(first.messages);
  });

  it("reclaims #99495 state from canonical compaction, not filtered projections", async () => {
    const sessionId = "session-99495-reclamation";
    const state = getEmbeddedSessionPromptState(sessionId).toolResults;
    const removed = makeToolResult("removed".repeat(100_000), "removed_after_compaction");
    const retained = makeToolResult("retained".repeat(100_000), "retained_after_compaction");
    const projected = truncateOversizedToolResultsInMessages(
      [removed, retained],
      128_000,
      5_000,
      20_000,
      state,
    );

    // Provider-specific filtering is not authoritative; the removed result can return on fallback.
    truncateOversizedToolResultsInMessages([retained], 128_000, 5_000, 20_000, state);
    expect(state.sourceHashByKey.size).toBe(2);

    await preparePromptProjectionStateForTest({ sessionId, messages: [], state, raw: true });
    expect(state.sourceHashByKey.size).toBe(2);

    await preparePromptProjectionStateForTest({ sessionId, messages: [retained], state });

    expect(state.sourceHashByKey.size).toBe(1);
    expect(state.frozen.size).toBe(1);
    expect(state.replacements.size).toBe(1);
    expect(
      truncateOversizedToolResultsInMessages([retained], 128_000, 5_000, 20_000, state).messages,
    ).toEqual(projected.messages.slice(1));
  });

  it("keeps frozen aggregate projections byte-identical when a later turn exceeds the budget", () => {
    const projectionState = createPromptProjectionStateForTest();
    const history = [
      makeToolResult("a".repeat(4_000), "history_1"),
      makeToolResult("b".repeat(4_000), "history_2"),
      makeUserMessage("continue"),
    ];
    const first = truncateOversizedToolResultsInMessages(
      history,
      128_000,
      8_000,
      12_000,
      projectionState,
    );
    const frozenBytes = first.messages.map((message) => JSON.stringify(message));
    const runtimeContextMessage = buildRuntimeContextCustomMessage("runtime context refresh");
    if (!runtimeContextMessage) {
      throw new Error("expected runtime context message");
    }

    const second = truncateOversizedToolResultsInMessages(
      [
        ...history,
        makeAssistantMessage("running exec"),
        makeToolResult("c".repeat(6_000), "current"),
        runtimeContextMessage,
      ],
      128_000,
      8_000,
      12_000,
      projectionState,
    );

    expect(first.aggregateTruncatedCount).toBe(0);
    expect(second.aggregateTruncatedCount).toBe(0);
    expect(
      second.messages.slice(0, history.length).map((message) => JSON.stringify(message)),
    ).toEqual(frozenBytes);
    const current = second.messages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === "current",
    );
    expect(current && getFirstToolResultText(current)).toBe("c".repeat(6_000));
  });

  it("shrinks #99495 frozen bytes monotonically only under a tighter hard cap", () => {
    const state = getEmbeddedSessionPromptState("session-99495-shrink").toolResults;
    const history = [
      makeToolResult("a".repeat(8_000), "history_1"),
      makeToolResult("b".repeat(8_000), "history_2"),
    ];
    const first = truncateOversizedToolResultsInMessages(history, 128_000, 6_000, 20_000, state);
    const shrunk = truncateOversizedToolResultsInMessages(history, 128_000, 3_000, 20_000, state);
    const relaxed = truncateOversizedToolResultsInMessages(history, 128_000, 7_000, 20_000, state);
    const lengths = (messages: AgentMessage[]) => messages.map(getToolResultTextLength);

    expect(
      lengths(shrunk.messages).every((length, index) => length <= lengths(first.messages)[index]!),
    ).toBe(true);
    expect(relaxed.messages).toEqual(shrunk.messages);
  });

  it.each([
    { kind: "tiny", outputs: ["ABC"], totalCap: 32_100 },
    {
      kind: "runtime carrier",
      outputs: ["OC99756_EXEC_MARKER_".padEnd(4_000, "x")],
      totalCap: 36_000,
    },
    {
      kind: "queued steering",
      outputs: [
        "OC99241_SHORT_SENTINEL_".padEnd(234, "s"),
        "OC99241_LONG_SENTINEL_".padEnd(4_000, "l"),
      ],
      totalCap: 36_234,
    },
    { kind: "oversized", outputs: ["z".repeat(20_000)], totalCap: 40_000 },
  ])(
    "preserves fresh $kind output without rewriting frozen history",
    ({ kind, outputs, totalCap }) => {
      const projectionState = createPromptProjectionStateForTest();
      const history: AgentMessage[] = [];
      for (let index = 0; index < 50; index++) {
        history.push(
          makeAssistantMessage(`call ${index}`),
          makeToolResult("x".repeat(4_000), `history_${index}`),
        );
      }
      history.push(makeUserMessage("run commands"));
      const first = truncateOversizedToolResultsInMessages(
        history,
        1_000_000,
        8_000,
        32_000,
        projectionState,
      );
      expect(first.truncatedCount).toBeGreaterThan(0);
      const carrier =
        kind === "queued steering"
          ? makeUserMessage("queued steering after tool execution")
          : buildRuntimeContextCustomMessage("runtime context refresh");
      if (!carrier) {
        throw new Error("expected runtime context message");
      }
      const messages: AgentMessage[] = [
        ...history,
        makeAssistantMessage("running tools"),
        ...outputs.map((text, index) => makeToolResult(text, `fresh_${index}`)),
        carrier,
      ];
      const providerMessages = kind === "runtime carrier" ? convertToLlm(messages) : messages;
      if (kind === "runtime carrier") {
        expect(providerMessages.at(-1)).toMatchObject({ role: "user", runtimeContext: {} });
      }
      const second = truncateOversizedToolResultsInMessages(
        providerMessages,
        1_000_000,
        8_000,
        32_000,
        projectionState,
      );
      const freshResults = second.messages.filter(
        (message): message is ToolResultMessage =>
          message.role === "toolResult" && message.toolCallId.startsWith("fresh_"),
      );
      if (kind === "runtime carrier") {
        const historicalResults = (entries: AgentMessage[]) =>
          entries.filter(
            (message) => message.role === "toolResult" && message.toolCallId.startsWith("history_"),
          );
        expect(historicalResults(second.messages)).toEqual(historicalResults(first.messages));
      } else {
        expect(second.messages.slice(0, history.length)).toEqual(first.messages);
      }
      if (kind === "tiny" || kind === "oversized") {
        expect(second.messages.at(-2)?.role).toBe("toolResult");
      }
      if (kind === "oversized") {
        const freshText = getFirstToolResultText(freshResults[0]!);
        expect(freshText).toContain("z".repeat(2_000));
        expect(freshText).toContain("truncated");
        expect(freshText.length).toBeLessThanOrEqual(8_000);
      } else {
        expect(freshResults.map(getFirstToolResultText)).toEqual(outputs);
      }
      if (kind === "runtime carrier" || kind === "queued steering") {
        expect(second.aggregateTruncatedCount).toBe(0);
        expect(second.aggregatePressureEngaged).toBe(true);
      }
      expect(
        second.messages.reduce((sum, message) => sum + getToolResultTextLength(message), 0),
      ).toBeLessThanOrEqual(totalCap);
    },
  );

  it("allows aggregate overflow rather than rewriting frozen history", () => {
    const projectionState = createPromptProjectionStateForTest();
    const history: AgentMessage[] = [
      makeToolResult("a".repeat(4_000), "history_a"),
      makeToolResult("b".repeat(4_000), "history_b"),
      makeUserMessage("establish a frozen projection baseline"),
    ];
    const first = truncateOversizedToolResultsInMessages(
      history,
      1_000_000,
      8_000,
      10_000,
      projectionState,
    );
    expect(first.aggregatePressureEngaged).toBe(false);

    const freshOutput = "OC99241_HARD_CAP_SENTINEL_".padEnd(4_000, "f");
    const runtimeContextMessage = buildRuntimeContextCustomMessage("hard-cap runtime context");
    if (!runtimeContextMessage) {
      throw new Error("expected runtime context message");
    }
    const providerMessages = convertToLlm([
      ...history,
      makeToolResult(freshOutput, "fresh_hard_cap"),
      runtimeContextMessage,
    ] as AgentMessage[]);
    expect(providerMessages.at(-1)).toMatchObject({ role: "user", runtimeContext: {} });
    const second = truncateOversizedToolResultsInMessages(
      providerMessages,
      1_000_000,
      8_000,
      100,
      projectionState,
    );
    const freshResult = second.messages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === "fresh_hard_cap",
    );
    const freshText = freshResult ? getFirstToolResultText(freshResult) : "";
    const totalChars = second.messages.reduce(
      (sum, message) =>
        sum + (message.role === "toolResult" ? getToolResultTextLength(message) : 0),
      0,
    );

    expect(
      second.messages.filter(
        (message) => message.role === "toolResult" && message.toolCallId.startsWith("history_"),
      ),
    ).toEqual(first.messages.filter((message) => message.role === "toolResult"));
    expect(freshText).toBe(freshOutput);
    expect(second.aggregateTruncatedCount).toBe(0);
    expect(second.aggregatePressureEngaged).toBe(true);
    expect(totalChars).toBeGreaterThan(100);
  });

  it("leaves fresh trailing batches intact when only they exceed the aggregate budget", () => {
    const projectionState = createPromptProjectionStateForTest();
    const messages: AgentMessage[] = [makeUserMessage("run several tools")];
    for (let index = 0; index < 5; index++) {
      messages.push(makeToolResult(String(index).repeat(8_000), `fresh_${index}`));
    }

    const result = truncateOversizedToolResultsInMessages(
      messages,
      1_000_000,
      8_000,
      32_000,
      projectionState,
    );
    const toolResults = result.messages.filter((message) => message.role === "toolResult");
    const totalChars = toolResults.reduce(
      (sum, message) => sum + getToolResultTextLength(message),
      0,
    );

    expect(result.truncatedCount).toBe(0);
    expect(result.aggregatePressureEngaged).toBe(true);
    expect(totalChars).toBeGreaterThan(32_000);
    expect(toolResults.every((message) => getFirstToolResultText(message).length > 0)).toBe(true);
  });

  it.each([
    { budget: 8, perResult: 100, kind: "tiny" },
    { budget: 100, perResult: 100, kind: "plain" },
    { budget: 94, perResult: 1_000, kind: "sliced" },
  ])("bounds pointerless aggregate elision for $kind budgets", ({ budget, perResult, kind }) => {
    const messages = ["a", "b", "c"].map((char, index) =>
      makeToolResult(char.repeat(100), `plain_${index}`),
    );
    const result = truncateOversizedToolResultsInMessages(messages, 128_000, perResult, budget);
    const texts = result.messages.map(getFirstToolResultText);
    if (kind === "tiny") {
      expect(result.truncatedCount).toBeGreaterThan(0);
      expect(
        result.messages.reduce((sum, message) => sum + getToolResultTextLength(message), 0),
      ).toBeLessThanOrEqual(8);
    } else if (kind === "plain") {
      expect(texts[0]).toContain("[tool result elided");
      expect(texts[0]).not.toContain("full output preserved at");
    } else {
      expect(
        texts.some((text) => text.startsWith("[tool result elided:") && !text.includes("rerun")),
      ).toBe(true);
    }
  });

  it.each([
    { kind: "live", name: "o", short: true, chars: 100, perResult: 500, budget: 100, count: 3 },
    { kind: "partial", name: "p", short: true, chars: 100, perResult: 300, budget: 100, count: 3 },
    {
      kind: "escaped",
      name: "C:\\s",
      short: true,
      chars: 100,
      perResult: 300,
      budget: 100,
      count: 3,
    },
    {
      kind: "deleted",
      name: "deleted-output.log",
      short: false,
      chars: 100,
      perResult: 100,
      budget: 100,
      count: 3,
    },
    {
      kind: "private",
      name: "private-output.log",
      short: false,
      chars: 100,
      perResult: 100,
      budget: 100,
      count: 3,
    },
    {
      kind: "compact",
      name: "realistic",
      short: false,
      chars: 2_000,
      perResult: 5_000,
      budget: 1,
      count: 3,
    },
    {
      kind: "suffix",
      name: "suffix",
      short: false,
      chars: 5_000,
      perResult: 8_000,
      budget: 9_000,
      count: 2,
    },
  ])(
    "preserves only recoverable, disclosed $kind spill pointers",
    async ({ kind, name, short, chars, perResult, budget, count }) => {
      const dir = await (short ? createShortTmpDir() : createTmpDir());
      const spillPath =
        kind === "compact" || kind === "suffix"
          ? realisticSpillPath(dir, name)
          : path.join(dir, name);
      await fs.writeFile(spillPath, "complete command output", { mode: 0o600 });
      if (kind === "deleted") {
        await fs.rm(spillPath);
      }
      const raw = "a".repeat(chars);
      const footer = textWithFullOutputFooter(raw, spillPath);
      const firstText =
        kind === "private"
          ? raw
          : kind === "escaped"
            ? JSON.stringify({ text: footer }, null, 2)
            : footer;
      const details =
        kind === "partial"
          ? { spill: { path: spillPath, chars: 2_000_000, truncated: true } }
          : { fullOutputPath: spillPath };
      const messages = [
        makeToolResult(firstText, "spill_0", details),
        ...Array.from({ length: count - 1 }, (_, index) =>
          makeToolResult((index === 0 ? "b" : "c").repeat(chars), `spill_${index + 1}`),
        ),
      ];
      const result = truncateOversizedToolResultsInMessages(messages, 128_000, perResult, budget);
      const text = getFirstToolResultText(result.messages[0] ?? makeToolResult(""));
      switch (kind) {
        case "live":
        case "escaped":
          expect(text).toContain("read");
          expect(text).toContain(spillPath);
          break;
        case "partial":
          expect(text).toContain("partial");
          expect(text).toContain(spillPath);
          expect(text).not.toContain("full output preserved");
          break;
        case "deleted":
        case "private":
          expect(text).toContain("[tool result elided");
          expect(text).not.toContain(spillPath);
          break;
        case "compact":
          expect(text).toBe(`[read ${spillPath}]`);
          break;
        case "suffix":
          expect(text).toContain(`full output at ${spillPath}`);
          expect(text).not.toContain("narrow args");
          break;
      }
    },
  );

  it("does not restore filtered image blocks when reusing a projection", () => {
    const projectionState = createPromptProjectionStateForTest();
    const source = makeToolResult("x".repeat(15_000), "image_call");
    source.content = [
      { type: "image", data: "filtered-after-conversion" },
      { type: "text", text: "x".repeat(15_000) },
    ] as never;
    truncateOversizedToolResultsInMessages([source], 128_000, 12_000, 12_000, projectionState);

    const providerMessage: ToolResultMessage = {
      ...source,
      content: [
        { type: "text" as const, text: "Image reading is disabled." },
        { type: "text" as const, text: "x".repeat(15_000) },
      ],
    };
    const result = truncateOversizedToolResultsInMessages(
      [providerMessage],
      128_000,
      12_000,
      12_000,
      projectionState,
    ).messages[0] as ToolResultMessage | undefined;

    expect(result?.content?.[0]).toEqual({
      type: "text",
      text: "Image reading is disabled.",
    });
    expect(
      result?.content?.[1] && "text" in result.content[1] ? result.content[1].text.length : 0,
    ).toBeLessThan(15_000);
  });

  it("retains bounded projection data while replaying current canonical metadata", () => {
    const state = createPromptProjectionStateForTest();
    const text = "x".repeat(100_000);
    const source = makeToolResult(text, "retained-read", { content: text });
    source.content.push({ type: "image", data: "a".repeat(100_000), mimeType: "image/png" });
    // SAFETY: exercise malformed plugin content that the projection owner preserves.
    source.content.push(null as never);
    const first = truncateOversizedToolResultsInMessages([source], 128_000, 5_000, 20_000, state);
    const retained = JSON.stringify(state, (_key, value) =>
      value instanceof Map || value instanceof Set ? [...value.values()] : value,
    );
    expect(retained.length).toBeLessThan(6_000);
    expect(first.messages[0]).toMatchObject({ details: source.details });

    const current = { ...source, details: { revision: "current" } };
    const replay = truncateOversizedToolResultsInMessages([current], 128_000, 5_000, 20_000, state)
      .messages[0] as ToolResultMessage;
    expect(replay.details).toBe(current.details);
    expect(replay.content).toEqual((first.messages[0] as ToolResultMessage).content);
    expect(source.content[0]).toEqual({ type: "text", text });
  });

  it.each([
    [
      ["ab", "c"],
      ["a", "bc"],
    ],
    [["\ud800"], ["\ud801"]],
  ])("invalidates rewritten canonical text with preserved framing: %j", async (before, after) => {
    const state = createPromptProjectionStateForTest();
    const source = makeToolResult("", "rewritten-source");
    const blocks = (parts: string[]) => parts.map((text) => ({ type: "text" as const, text }));
    source.content = blocks(["x".repeat(15_000), ...before]);
    truncateOversizedToolResultsInMessages([source], 128_000, 5_000, 20_000, state);
    const rewritten = { ...source, content: blocks(["x".repeat(15_000), ...after]) };
    await preparePromptProjectionStateForTest({
      sessionId: "rewritten-source",
      messages: [rewritten],
      state,
    });
    expect(state.replacements.size).toBe(0);
    expect(state.frozen.size).toBe(0);
  });

  it("freezes #99495 ambiguous-key projections across filtered history", async () => {
    const projectionState = createPromptProjectionStateForTest();
    const duplicate = (text: string) => ({
      role: "toolResult" as const,
      toolCallId: "duplicate-call",
      toolName: "duplicate",
      isError: false,
      timestamp: 1,
      content: [{ type: "text" as const, text }],
    });
    const first = truncateOversizedToolResultsInMessages(
      [duplicate("a".repeat(100)), duplicate("b".repeat(100))],
      128_000,
      100,
      100,
      projectionState,
    );
    const filtered = truncateOversizedToolResultsInMessages(
      [duplicate("b".repeat(100))],
      128_000,
      100,
      100,
      projectionState,
    );

    expect(first.messages[0]).not.toEqual(first.messages[1]);
    expect(filtered.messages[0]).toEqual(first.messages[1]);
    await preparePromptProjectionStateForTest({
      sessionId: "ambiguous-filtered-history",
      messages: [duplicate("b".repeat(100))],
      state: projectionState,
    });
    expect(projectionState.sourceHashByKey.size).toBe(1);
    expect(projectionState.frozen.size).toBe(1);
    expect(projectionState.replacements.size).toBe(0);
    expect(projectionState.ambiguousBaseKeys.size).toBe(1);
    expect(
      truncateOversizedToolResultsInMessages(
        [duplicate("b".repeat(100))],
        128_000,
        100,
        100,
        projectionState,
      ).messages[0],
    ).toEqual(first.messages[1]);
    await preparePromptProjectionStateForTest({
      sessionId: "ambiguous-removed-history",
      messages: [],
      state: projectionState,
    });
    expect(projectionState.ambiguousBaseKeys.size).toBe(0);
  });

  it("drops an unselected identical-occurrence key without changing projected bytes", async () => {
    const projectionState = createPromptProjectionStateForTest();
    const duplicate = (): ToolResultMessage => ({
      role: "toolResult",
      toolCallId: "identical-call",
      toolName: "duplicate",
      isError: false,
      content: [{ type: "text", text: "x".repeat(100) }],
      timestamp: 1_000,
    });
    const history = [duplicate(), makeAssistantMessage("separator"), duplicate()];
    const first = truncateOversizedToolResultsInMessages(
      history,
      128_000,
      100,
      100,
      projectionState,
    );
    const stateWithStaleOccurrence = createToolResultPromptProjectionState(projectionState);
    expect(stateWithStaleOccurrence.frozen.size).toBe(2);

    await preparePromptProjectionStateForTest({
      sessionId: "identical-occurrence-compaction",
      messages: [duplicate()],
      state: projectionState,
    });

    const retainedWithStale = truncateOversizedToolResultsInMessages(
      [duplicate()],
      128_000,
      100,
      100,
      stateWithStaleOccurrence,
    );
    const retainedAfterPrune = truncateOversizedToolResultsInMessages(
      [duplicate()],
      128_000,
      100,
      100,
      projectionState,
    );
    // After the first identical occurrence disappears, both states select :0;
    // retaining the unreachable :1 entry cannot preserve or change provider bytes.
    expect(retainedAfterPrune.messages).toEqual(retainedWithStale.messages);
    expect(retainedAfterPrune.messages[0]).toEqual(first.messages[0]);
    expect(projectionState.frozen.size).toBe(1);
    expect(projectionState.sourceHashByKey.size).toBe(1);
  });
});

describe("truncateOversizedToolResultsInSession", () => {
  it("truncates SQLite runtime transcripts without treating the marker as a file", async () => {
    const dir = sessionDirs.make();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "runtime-sqlite-tool-truncation";
    const sessionKey = "agent:main:test";
    const sessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionFile,
      sessionId,
      updatedAt: 10,
    } as SessionStoreEntry);
    await appendTranscriptMessage(scope, {
      message: makeUserMessage("run tools"),
    });
    const staleCheckpointReplay = {
      v: 1,
      type: "openai-responses-compaction",
      data: "stale-checkpoint",
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5.2",
      baseUrlHash: "ozhevd1smnk8s",
    } satisfies NonNullable<AssistantMessage["providerReplay"]>;
    const preBoundaryCheckpointOwner = makeAssistantMessage("pre-boundary checkpoint owner");
    preBoundaryCheckpointOwner.providerReplay = staleCheckpointReplay;
    await appendTranscriptMessage(scope, { message: preBoundaryCheckpointOwner });
    const medium = "alpha beta gamma delta epsilon ".repeat(600);
    const firstToolResult = await appendTranscriptMessage(scope, {
      message: makeToolResult(medium, "call_1"),
    });
    const secondToolResult = await appendTranscriptMessage(scope, {
      message: makeToolResult(medium, "call_2"),
    });
    const thirdToolResult = await appendTranscriptMessage(scope, {
      message: makeToolResult(medium, "call_3"),
    });
    const staleCheckpointOwner = makeAssistantMessage("stale checkpoint owner");
    staleCheckpointOwner.providerReplay = staleCheckpointReplay;
    await appendTranscriptMessage(scope, { message: staleCheckpointOwner });
    const staleAnthropicCheckpointReplay = {
      ...staleCheckpointReplay,
      type: "anthropic-compaction",
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-sonnet-4-6",
    } satisfies NonNullable<AssistantMessage["providerReplay"]>;
    const staleAnthropicCheckpointOwner = makeAssistantMessage("stale Anthropic checkpoint owner");
    staleAnthropicCheckpointOwner.providerReplay = staleAnthropicCheckpointReplay;
    await appendTranscriptMessage(scope, { message: staleAnthropicCheckpointOwner });
    const suppressionReplay = {
      ...staleCheckpointReplay,
      type: "openai-responses-compaction-suppression",
      data: "rejected",
    } satisfies NonNullable<AssistantMessage["providerReplay"]>;
    const suppressionOwner = makeAssistantMessage("suppression owner");
    suppressionOwner.providerReplay = suppressionReplay;
    await appendTranscriptMessage(scope, { message: suppressionOwner });

    const listener = vi.fn();
    const cleanup = onInternalSessionTranscriptUpdate(listener);
    const result = await truncateOversizedToolResultsInSessionManager({
      sessionManager: SessionManager.open(scope),
      ...scope,
      contextWindowTokens: 100,
    });
    cleanup();

    expect(result.truncated).toBe(true);
    expect(result.truncatedCount).toBeGreaterThan(0);
    expect(listener).toHaveBeenCalledWith({
      sessionKey,
      agentId: "main",
      sessionId,
      target: { agentId: "main", sessionId, sessionKey, storePath },
    });

    const storedEvents = await loadTranscriptEvents(scope);
    const originalToolResultIds = new Set([
      firstToolResult.messageId,
      secondToolResult.messageId,
      thirdToolResult.messageId,
    ]);
    const originalToolResultTexts = storedEvents
      .filter(
        (entry): entry is { id: string; message: AgentMessage; type: "message" } =>
          typeof entry === "object" &&
          entry !== null &&
          "id" in entry &&
          "message" in entry &&
          "type" in entry &&
          entry.type === "message" &&
          typeof entry.id === "string" &&
          originalToolResultIds.has(entry.id),
      )
      .map((entry) => entry.message)
      .filter((message): message is ToolResultMessage => message.role === "toolResult")
      .map(getFirstToolResultText);
    expect(originalToolResultTexts).toEqual([medium, medium, medium]);

    const activeMessages = SessionManager.open(scope)
      .getBranch()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    const toolResultTexts = activeMessages.flatMap((message) =>
      message.role === "toolResult" ? [getFirstToolResultText(message as ToolResultMessage)] : [],
    );
    const findAssistant = (text: string) =>
      activeMessages.find(
        (message): message is AssistantMessage =>
          message.role === "assistant" &&
          message.content.some((block) => block.type === "text" && block.text === text),
      );

    expect(toolResultTexts.some((text) => text.includes("truncated"))).toBe(true);
    expect(toolResultTexts.join("").length).toBeLessThan(medium.length * 3);
    expect(findAssistant("pre-boundary checkpoint owner")?.providerReplay).toEqual(
      staleCheckpointReplay,
    );
    expect(findAssistant("stale checkpoint owner")?.providerReplay).toBeUndefined();
    expect(findAssistant("stale Anthropic checkpoint owner")?.providerReplay).toBeUndefined();
    expect(findAssistant("suppression owner")?.providerReplay).toEqual(suppressionReplay);
  });

  it("reuses frozen provider projection bytes on the recovery branch", async () => {
    const dir = sessionDirs.make();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "runtime-sqlite-frozen-projection";
    const sessionKey = "agent:main:frozen-projection";
    const sessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionFile,
      sessionId,
      updatedAt: 10,
    } as SessionStoreEntry);
    await appendTranscriptMessage(scope, { message: makeUserMessage("run tool") });
    const original = makeToolResult("frozen output ".repeat(2_000), "frozen_call");
    const persisted = await appendTranscriptMessage(scope, { message: original });
    const projectionState = createPromptProjectionStateForTest();
    const projected = truncateOversizedToolResultsInMessages(
      [original],
      128_000,
      12_000,
      48_000,
      projectionState,
    ).messages[0];
    const staleProjectionState = createToolResultPromptProjectionState(projectionState);

    const result = await truncateOversizedToolResultsInSessionManager({
      sessionManager: SessionManager.open(scope),
      ...scope,
      contextWindowTokens: 128_000,
      maxCharsOverride: 12_000,
      aggregateMaxCharsOverride: 48_000,
      projectionState,
    });

    expect(result.truncated).toBe(true);
    expect(projectionState.sourceHashByKey.size).toBe(0);
    expect(projectionState.replacements.size).toBe(0);
    expect(projectionState.frozen.size).toBe(0);
    await preparePromptProjectionStateForTest({
      sessionId,
      messages: SessionManager.open(scope).buildSessionContext().messages,
      state: staleProjectionState,
    });
    expect(staleProjectionState.sourceHashByKey.size).toBe(0);
    expect(staleProjectionState.replacements.size).toBe(0);
    expect(staleProjectionState.frozen.size).toBe(0);
    const activeToolResult = SessionManager.open(scope)
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "toolResult");
    expect(activeToolResult?.type === "message" ? activeToolResult.message : undefined).toEqual(
      projected,
    );
    const originalEvent = (await loadTranscriptEvents(scope)).find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "id" in entry &&
        entry.id === persisted.messageId,
    ) as { message?: AgentMessage } | undefined;
    expect(originalEvent?.message).toEqual(original);
  });

  it("reduces aggregate-only frozen history on the recovery branch", async () => {
    const dir = sessionDirs.make();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "runtime-sqlite-frozen-aggregate-recovery";
    const sessionKey = "agent:main:frozen-aggregate-recovery";
    const sessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionFile,
      sessionId,
      updatedAt: 10,
    } as SessionStoreEntry);
    await appendTranscriptMessage(scope, { message: makeUserMessage("run tools") });
    // Each result stays under the per-result cap; only the aggregate is over.
    const frozenResults = [
      makeToolResult("a".repeat(6_000), "frozen_agg_1"),
      makeToolResult("b".repeat(6_000), "frozen_agg_2"),
      makeToolResult("c".repeat(6_000), "frozen_agg_3"),
    ];
    for (const message of frozenResults) {
      await appendTranscriptMessage(scope, { message });
    }
    const projectionState = createPromptProjectionStateForTest();
    // Dispatch under a loose budget freezes every result at full text.
    truncateOversizedToolResultsInMessages(frozenResults, 128_000, 8_000, 48_000, projectionState);
    expect(projectionState.frozen.size).toBe(3);

    // A provider context failure then demands recovery under a tighter budget:
    // frozen history is the only reducible mass and must still shrink.
    const result = await truncateOversizedToolResultsInSessionManager({
      sessionManager: SessionManager.open(scope),
      ...scope,
      contextWindowTokens: 128_000,
      maxCharsOverride: 8_000,
      aggregateMaxCharsOverride: 6_000,
      projectionState,
    });

    expect(result.truncated).toBe(true);
    const recovered = SessionManager.open(scope)
      .getBranch()
      .filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
      .map((entry) => (entry.type === "message" ? entry.message : undefined));
    const totalChars = recovered.reduce(
      (sum, message) => sum + (message ? getToolResultTextLength(message) : 0),
      0,
    );
    expect(totalChars).toBeLessThan(18_000);
  });

  it("honors SQLite leaf controls when truncating runtime transcripts", async () => {
    const dir = sessionDirs.make();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "runtime-sqlite-leaf-tool-truncation";
    const sessionKey = "agent:main:test";
    const sessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionFile,
      sessionId,
      updatedAt: 10,
    } as SessionStoreEntry);
    const activeLarge = "selected branch tool output ".repeat(700);
    const inactiveLarge = "inactive branch tool output ".repeat(700);
    await replaceTranscriptEvents(scope, [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: dir,
      },
      {
        type: "message",
        id: "root-user",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: makeUserMessage("run tools"),
      },
      {
        type: "message",
        id: "selected-tool",
        parentId: "root-user",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: makeToolResult(activeLarge, "call_selected"),
      },
      {
        type: "message",
        id: "inactive-tool",
        parentId: "root-user",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: makeToolResult(inactiveLarge, "call_inactive"),
      },
      {
        type: "leaf",
        id: "selected-leaf",
        parentId: "inactive-tool",
        timestamp: "2026-01-01T00:00:04.000Z",
        targetId: "selected-tool",
      },
    ]);

    const result = await truncateOversizedToolResultsInSessionManager({
      sessionManager: SessionManager.open(scope),
      ...scope,
      contextWindowTokens: 100,
    });

    expect(result.truncated).toBe(true);
    const storedMessages = (await loadTranscriptEvents(scope))
      .filter(
        (entry): entry is { message: AgentMessage; type: "message" } =>
          typeof entry === "object" &&
          entry !== null &&
          "message" in entry &&
          "type" in entry &&
          entry.type === "message",
      )
      .map((entry) => entry.message);
    const originalSelectedTool = storedMessages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === "call_selected",
    );
    const inactiveTool = storedMessages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === "call_inactive",
    );
    const selectedTool = SessionManager.open(scope)
      .getBranch()
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message)
      .find(
        (message): message is ToolResultMessage =>
          message.role === "toolResult" && message.toolCallId === "call_selected",
      );

    expect(selectedTool ? getFirstToolResultText(selectedTool) : "").toContain("truncated");
    expect(originalSelectedTool ? getFirstToolResultText(originalSelectedTool) : "").toBe(
      activeLarge,
    );
    expect(inactiveTool ? getFirstToolResultText(inactiveTool) : "").toBe(inactiveLarge);
  });
});

describe("truncateToolResultText head+tail strategy", () => {
  it.each([
    {
      kind: "error",
      text:
        "Line 1\n".repeat(500) +
        "data data data\n".repeat(500) +
        "\nError: something failed\nStack trace: at foo.ts:42\n",
    },
    { kind: "ordinary", text: "normal line\n".repeat(1000) },
    {
      kind: "newline",
      text: Array.from({ length: 100 }, (_, i) => `line ${i}: ${"x".repeat(50)}`).join("\n"),
    },
  ])("preserves the $kind tail appropriately", ({ kind, text }) => {
    const result = truncateToolResultText(text, kind === "newline" ? 3000 : 5000);
    if (kind === "error") {
      expect(result).toContain("Line 1");
      expect(result).toContain("Error: something failed");
      expect(result).toContain("middle content omitted");
    } else if (kind === "newline") {
      expect(result).toContain("truncated");
      expect(result.length).toBeLessThan(text.length);
      const suffixIndex = result.indexOf("\n\n⚠️");
      if (suffixIndex > 0) {
        const keptContent = result.slice(0, suffixIndex);
        expect(keptContent.lastIndexOf("\n")).toBeGreaterThan(keptContent.length - 100);
      }
    } else {
      expect(result).toContain("normal line");
      expect(result).not.toContain("middle content omitted");
      expect(result).toContain("truncated");
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
