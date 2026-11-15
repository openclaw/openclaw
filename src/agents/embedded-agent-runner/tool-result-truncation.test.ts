import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "openclaw/plugin-sdk/llm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
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
import { prepareEmbeddedAttemptPromptContext } from "./run/attempt-prompt-build.js";
import { buildRuntimeContextCustomMessage } from "./run/runtime-context-prompt.js";
import {
  clearEmbeddedSessionPromptStates,
  createToolResultPromptProjectionState,
  retainEmbeddedSessionPromptState,
  type ToolResultPromptProjectionState,
} from "./session-prompt-state.js";
import {
  toolResultWarningDedupe,
  truncateToolResultMessage,
  truncateOversizedToolResultsInMessages as truncate,
  truncateOversizedToolResultsInSessionManager,
  sessionLikelyHasOversizedToolResults,
  resolveLiveToolResultMaxChars,
  resolveLiveToolResultAggregateMaxChars as aggregateLimit,
} from "./tool-result-truncation.js";

let tmpDir: string | undefined;
const sessionDirs = useSessionStoreTempDirs(afterAll, "tool-result-truncation-test-");

let testTimestamp = 1;
const nextTimestamp = () => testTimestamp++;

beforeEach(() => {
  testTimestamp = 1;
});

afterEach(async () => {
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

function toolResult(text: string, toolCallId = "call_1", details?: unknown): ToolResultMessage {
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

async function prepareProjection(
  messages: AgentMessage[],
  state: ToolResultPromptProjectionState,
  raw = false,
  sessionId = "projection",
) {
  const prompt = raw ? "raw probe" : "continue";
  await prepareEmbeddedAttemptPromptContext({
    capabilityToolNames: new Set(),
    attempt: {
      config: {},
      contextTokenBudget: 128_000,
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      suppressNextUserMessagePersistence: false,
    },
    includeBoundaryTimestamp: false,
    isRawModelRun: raw,
    messages,
    prompt: {
      effectivePrompt: prompt,
      effectiveTranscriptPrompt: prompt,
    },
    replaceSessionMessages: () => {},
    sessionAgentId: "main",
    systemPromptText: raw ? "" : "system",
    toolResultPromptProjectionState: state,
  });
}

function toolResults(texts: string[], prefix = "call") {
  return texts.map((text, index) => toolResult(text, `${prefix}_${index}`));
}

function totalText(messages: AgentMessage[]) {
  return messages.reduce((sum, message) => sum + textLength(message), 0);
}

function findTool(messages: AgentMessage[], id: string) {
  return messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
}

function projection(maxChars = 5_000, aggregate = 20_000, context = 128_000) {
  const state = createToolResultPromptProjectionState();
  return {
    state,
    project: (messages: AgentMessage[], cap = maxChars, total = aggregate) =>
      truncate(messages, context, cap, total, state),
  };
}

function expectProjectionSize(
  state: ToolResultPromptProjectionState,
  size: number,
  replacements = size,
) {
  expect([state.sourceHashByKey.size, state.frozen.size, state.replacements.size]).toEqual([
    size,
    size,
    replacements,
  ]);
}

function byToolPrefix(messages: AgentMessage[], prefix: string) {
  return messages.filter(
    (message): message is ToolResultMessage =>
      message.role === "toolResult" && message.toolCallId.startsWith(prefix),
  );
}

function textWithFullOutputFooter(text: string, fullOutputPath: string): string {
  return `${text}\n\n[Showing truncated output. ${formatFullOutputFooter(fullOutputPath)}]`;
}

function realisticSpillPath(dir: string, name: string): string {
  return path.join(dir, `${name}-${"segment-".repeat(8)}output.log`);
}

function user(text: string): UserMessage {
  return makeUserMessage(text, nextTimestamp());
}

function assistant(text: string): AssistantMessage {
  return makeAgentAssistantMessage({
    content: [{ type: "text", text }],
    model: "gpt-5.2",
    stopReason: "stop",
    timestamp: nextTimestamp(),
  });
}

function toolText(message: AgentMessage | ToolResultMessage): string {
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
  return toolText(truncateToolResultMessage(toolResult(text), maxChars, options));
}

function perResultLimit(contextWindowTokens: number): number {
  return resolveLiveToolResultMaxChars({ contextWindowTokens });
}

function textLength(message: AgentMessage): number {
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
    ["aaa😀z", 5, () => "!", 0, "aaa!"],
    ["abcdef", 1, () => "😀", 0, ""],
    ["x".repeat(100), 4, (n: number) => `[${n}]`, 1, "[100"],
  ] as const)(
    "bounds suffix-only and code-point cuts for %s",
    (text, maxChars, suffix, minKeepChars, expected) => {
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
    const block = { type: "toolResult", toolUseId: "call_1", text: oversized, content: oversized };
    const msg = {
      ...toolResult(""),
      toolName: "exec",
      content: [block],
    } as unknown as ToolResultMessage;

    const result = truncateToolResultMessage(msg, 10_000, {
      suffix: () => "\n\n[persist-truncated]",
      minKeepChars: 2_000,
    });
    expect(result.role).toBe("toolResult");
    const firstBlock = result.content[0] as unknown as { text?: unknown; content?: unknown };
    expect(typeof firstBlock.text).toBe("string");
    expect(firstBlock.text).toContain("[persist-truncated]");
    expect(String(firstBlock.text).length).toBeLessThan(oversized.length);
    expect(firstBlock.content).toBe(firstBlock.text);
  });

  it.each([
    ["mixed CJK/ASCII", ["你".repeat(1_000), "a".repeat(4_000)], 4_000, undefined],
    [
      "small blocks",
      ["a".repeat(50), "b".repeat(50), "c".repeat(500)],
      100,
      { suffix: () => "!", minKeepChars: 99 },
    ],
    [
      "empty blocks",
      [...Array<string>(150).fill(""), "x".repeat(500)],
      100,
      { suffix: () => "!", minKeepChars: 0 },
    ],
  ] as const)("reserves the weighted notice budget for %s", (kind, texts, maxChars, options) => {
    const msg = {
      ...toolResult("unused"),
      content: texts.map((text) => ({ type: "text" as const, text })),
    };
    const result = truncateToolResultMessage(msg, maxChars, options);
    expect(result.role).toBe("toolResult");
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

describe("perResultLimit", () => {
  it.each([
    [8_000, 9_600, 38_400],
    [20_000, 16_000, 64_000],
    [128_000, 32_000, 256_000],
    [200_000, 64_000, 400_000],
  ])(
    "resolves aggregate live cap for %s token windows",
    (contextWindowTokens, perResultMaxChars, aggregateMaxChars) => {
      expect(perResultLimit(contextWindowTokens)).toBe(perResultMaxChars);
      expect(
        aggregateLimit({
          contextWindowTokens,
          perResultMaxChars,
        }),
      ).toBe(aggregateMaxChars);
    },
  );
});

describe("truncateOversizedToolResultsInMessages", () => {
  it("returns unchanged messages when nothing is oversized", () => {
    const messages = [user("hello"), assistant("using tool"), toolResult("small result")];
    expect(sessionLikelyHasOversizedToolResults({ messages, contextWindowTokens: 200_000 })).toBe(
      false,
    );
    const { messages: result, truncatedCount } = truncate(messages, 200_000);
    expect(truncatedCount).toBe(0);
    expect(result).toEqual(messages);
  });

  it("applies the aggregate cap to CJK-weighted prompt history", () => {
    const messages = toolResults(Array<string>(6).fill("你".repeat(3_000)));

    const result = truncate(messages, 20_000);
    expect(sessionLikelyHasOversizedToolResults({ messages, contextWindowTokens: 20_000 })).toBe(
      true,
    );
    const estimated = result.messages.reduce(
      (sum, message) =>
        sum + (message.role === "toolResult" ? estimateStringChars(toolText(message)) : 0),
      0,
    );

    expect(result.aggregateTruncatedCount).toBeGreaterThan(0);
    expect(estimated).toBeLessThanOrEqual(64_000);
  });

  it("bounds aggregate tool-result text in prompt history without rewriting callers", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(800);
    const messages: AgentMessage[] = [
      user("hello"),
      assistant("calling tools"),
      ...toolResults(Array<string>(3).fill(medium)),
    ];

    const { messages: result, truncatedCount } = truncate(messages, 128_000, 12_000, 12_000);
    expect(
      sessionLikelyHasOversizedToolResults({
        messages,
        contextWindowTokens: 128_000,
        maxCharsOverride: 12_000,
      }),
    ).toBe(true);

    expect(truncatedCount).toBeGreaterThan(0);
    expect(totalText(result)).toBeLessThanOrEqual(12_000);
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
    expect(totalText(messages)).toBe(medium.length * 3);
  });

  it("reclaims #99495 state from canonical compaction, not filtered projections", async () => {
    const sessionId = "session-99495-reclamation";
    using promptStateLease = retainEmbeddedSessionPromptState(sessionId);
    const state = promptStateLease.state.toolResults;
    const removed = toolResult("removed".repeat(100_000), "removed_after_compaction");
    const retained = toolResult("retained".repeat(100_000), "retained_after_compaction");
    const projected = truncate([removed, retained], 128_000, 5_000, 20_000, state);

    // Provider-specific filtering is not authoritative; the removed result can return on fallback.
    truncate([retained], 128_000, 5_000, 20_000, state);
    expect(state.sourceHashByKey.size).toBe(2);

    await prepareProjection([], state, true, sessionId);
    expect(state.sourceHashByKey.size).toBe(2);

    await prepareProjection([retained], state, false, sessionId);

    expectProjectionSize(state, 1);
    expect(truncate([retained], 128_000, 5_000, 20_000, state).messages).toEqual(
      projected.messages.slice(1),
    );
  });

  it("allows aggregate overflow without rewriting untruncated frozen history", () => {
    const { project } = projection(8_000, 10_000, 1_000_000);
    const history = [
      ...toolResults(["a".repeat(4_000), "b".repeat(4_000)], "history"),
      user("establish a frozen projection baseline"),
    ];
    const first = project(history);
    expect(first.aggregatePressureEngaged).toBe(false);
    const carrier = buildRuntimeContextCustomMessage("hard-cap runtime context");
    if (!carrier) {
      throw new Error("expected runtime context message");
    }
    const freshOutput = "OC99241_HARD_CAP_SENTINEL_".padEnd(4_000, "f");
    const messages = convertToLlm([...history, toolResult(freshOutput, "fresh"), carrier]);
    expect(messages.at(-1)).toMatchObject({ role: "user", runtimeContext: {} });
    const second = project(messages, 8_000, 100);
    expect(byToolPrefix(second.messages, "history_")).toEqual(
      byToolPrefix(first.messages, "history_"),
    );
    expect(toolText(findTool(second.messages, "fresh")!)).toBe(freshOutput);
    expect(second.aggregateTruncatedCount).toBe(0);
    expect(second.aggregatePressureEngaged).toBe(true);
    expect(totalText(second.messages)).toBeGreaterThan(100);
  });

  it("shrinks #99495 frozen bytes monotonically only under a tighter hard cap", () => {
    using promptStateLease = retainEmbeddedSessionPromptState("session-99495-shrink");
    const state = promptStateLease.state.toolResults;
    const history = toolResults(["a".repeat(8_000), "b".repeat(8_000)], "history");
    const first = truncate(history, 128_000, 6_000, 20_000, state);
    const shrunk = truncate(history, 128_000, 3_000, 20_000, state);
    const relaxed = truncate(history, 128_000, 7_000, 20_000, state);
    const lengths = (messages: AgentMessage[]) => messages.map(textLength);

    expect(
      lengths(shrunk.messages).every((length, index) => length <= lengths(first.messages)[index]!),
    ).toBe(true);
    expect(relaxed.messages).toEqual(shrunk.messages);
  });

  it.each([
    ["tiny", ["ABC"], 32_100],
    ["runtime carrier", ["OC99756_EXEC_MARKER_".padEnd(4_000, "x")], 36_000],
    [
      "queued steering",
      ["OC99241_SHORT_SENTINEL_".padEnd(234, "s"), "OC99241_LONG_SENTINEL_".padEnd(4_000, "l")],
      36_234,
    ],
    ["oversized", ["z".repeat(20_000)], 40_000],
  ] as const)(
    "preserves fresh %s output without rewriting frozen history",
    (kind, outputs, totalCap) => {
      const { project } = projection(8_000, 32_000, 1_000_000);
      const history: AgentMessage[] = [];
      for (let index = 0; index < 50; index++) {
        history.push(assistant(`call ${index}`), toolResult("x".repeat(4_000), `history_${index}`));
      }
      history.push(user("run commands"));
      const first = project(history);
      expect(first.truncatedCount).toBeGreaterThan(0);
      const carrier =
        kind === "queued steering"
          ? user("queued steering after tool execution")
          : buildRuntimeContextCustomMessage("runtime context refresh");
      if (!carrier) {
        throw new Error("expected runtime context message");
      }
      const messages: AgentMessage[] = [
        ...history,
        assistant("running tools"),
        ...outputs.map((text, index) => toolResult(text, `fresh_${index}`)),
        carrier,
      ];
      const providerMessages = kind === "runtime carrier" ? convertToLlm(messages) : messages;
      if (kind === "runtime carrier") {
        expect(providerMessages.at(-1)).toMatchObject({ role: "user", runtimeContext: {} });
      }
      const budget = kind === "tiny" ? 100 : 32_000;
      const second = project(providerMessages, 8_000, budget);
      const freshResults = byToolPrefix(second.messages, "fresh_");
      if (kind === "runtime carrier") {
        expect(byToolPrefix(second.messages, "history_")).toEqual(
          byToolPrefix(first.messages, "history_"),
        );
      } else {
        expect(second.messages.slice(0, history.length)).toEqual(first.messages);
      }
      if (kind === "tiny" || kind === "oversized") {
        expect(second.messages.at(-2)?.role).toBe("toolResult");
      }
      if (kind === "oversized") {
        const freshText = toolText(freshResults[0]!);
        expect(freshText).toContain("z".repeat(2_000));
        expect(freshText).toContain("truncated");
        expect(freshText.length).toBeLessThanOrEqual(8_000);
      } else {
        expect(freshResults.map(toolText)).toEqual(outputs);
      }
      if (kind === "runtime carrier" || kind === "queued steering") {
        expect(second.aggregateTruncatedCount).toBe(0);
        expect(second.aggregatePressureEngaged).toBe(true);
      }
      expect(totalText(second.messages)).toBeLessThanOrEqual(totalCap);
      expect(totalText(second.messages)).toBeGreaterThan(budget);
    },
  );

  it("leaves fresh trailing batches intact when only they exceed the aggregate budget", () => {
    const state = createToolResultPromptProjectionState();
    const messages: AgentMessage[] = [user("run several tools")];
    for (let index = 0; index < 5; index++) {
      messages.push(toolResult(String(index).repeat(8_000), `fresh_${index}`));
    }

    const result = truncate(messages, 1_000_000, 8_000, 32_000, state);
    const results = result.messages.filter((message) => message.role === "toolResult");

    expect(result.truncatedCount).toBe(0);
    expect(result.aggregatePressureEngaged).toBe(true);
    expect(totalText(results)).toBeGreaterThan(32_000);
    expect(results.every((message) => toolText(message).length > 0)).toBe(true);
  });

  it.each([
    { budget: 8, perResult: 100, kind: "tiny" },
    { budget: 100, perResult: 100, kind: "plain" },
    { budget: 94, perResult: 1_000, kind: "sliced" },
  ])("bounds pointerless aggregate elision for $kind budgets", ({ budget, perResult, kind }) => {
    const messages = ["a", "b", "c"].map((char, index) =>
      toolResult(char.repeat(100), `plain_${index}`),
    );
    const result = truncate(messages, 128_000, perResult, budget);
    const texts = result.messages.map(toolText);
    if (kind === "tiny") {
      expect(result.truncatedCount).toBeGreaterThan(0);
      expect(totalText(result.messages)).toBeLessThanOrEqual(8);
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
    ["live", "o", true, 100, 500, 100, 3],
    ["partial", "p", true, 100, 300, 100, 3],
    ["escaped", "C:\\s", true, 100, 300, 100, 3],
    ["deleted", "deleted-output.log", false, 100, 100, 100, 3],
    ["private", "private-output.log", false, 100, 100, 100, 3],
    ["compact", "realistic", false, 2_000, 5_000, 1, 3],
    ["suffix", "suffix", false, 5_000, 8_000, 9_000, 2],
  ] as const)(
    "preserves only recoverable, disclosed %s spill pointers",
    async (kind, name, short, chars, perResult, budget, count) => {
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
        toolResult(firstText, "spill_0", details),
        ...Array.from({ length: count - 1 }, (_, index) =>
          toolResult((index === 0 ? "b" : "c").repeat(chars), `spill_${index + 1}`),
        ),
      ];
      const result = truncate(messages, 128_000, perResult, budget);
      const text = toolText(result.messages[0] ?? toolResult(""));
      expect(text.includes(spillPath)).toBe(kind !== "deleted" && kind !== "private");
      if (kind === "live" || kind === "escaped") {
        expect(text).toContain("read");
      } else if (kind === "partial") {
        expect(text).toContain("partial");
        expect(text).not.toContain("full output preserved");
      } else if (kind === "deleted" || kind === "private") {
        expect(text).toContain("[tool result elided");
      } else if (kind === "compact") {
        expect(text).toBe(`[read ${spillPath}]`);
      } else {
        expect(text).toContain(`full output at ${spillPath}`);
        expect(text).not.toContain("narrow args");
      }
    },
  );

  it("does not restore filtered image blocks when reusing a projection", () => {
    const { project } = projection(12_000, 12_000);
    const source = toolResult("x".repeat(15_000), "image_call");
    source.content = [
      { type: "image", data: "filtered-after-conversion" },
      { type: "text", text: "x".repeat(15_000) },
    ] as never;
    project([source]);

    const providerMessage: ToolResultMessage = {
      ...source,
      content: [
        { type: "text" as const, text: "Image reading is disabled." },
        { type: "text" as const, text: "x".repeat(15_000) },
      ],
    };
    const result = project([providerMessage]).messages[0] as ToolResultMessage | undefined;

    expect(result?.content?.[0]).toEqual({
      type: "text",
      text: "Image reading is disabled.",
    });
    expect(
      result?.content?.[1] && "text" in result.content[1] ? result.content[1].text.length : 0,
    ).toBeLessThan(15_000);
  });

  it("retains bounded projection data while replaying current canonical metadata", () => {
    const { state, project } = projection();
    const text = "x".repeat(100_000);
    const source = toolResult(text, "retained-read", { content: text });
    source.content.push({ type: "image", data: "a".repeat(100_000), mimeType: "image/png" });
    // SAFETY: exercise malformed plugin content that the projection owner preserves.
    source.content.push(null as never);
    const first = project([source]);
    const retained = JSON.stringify(state, (_key, value) =>
      value instanceof Map || value instanceof Set ? [...value.values()] : value,
    );
    expect(retained.length).toBeLessThan(6_000);
    expect(first.messages[0]).toMatchObject({ details: source.details });

    const current = { ...source, details: { revision: "current" } };
    const replay = project([current]).messages[0] as ToolResultMessage;
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
    const { state, project } = projection();
    const source = toolResult("", "rewritten-source");
    const blocks = (parts: string[]) => parts.map((text) => ({ type: "text" as const, text }));
    source.content = blocks(["x".repeat(15_000), ...before]);
    project([source]);
    const rewritten = { ...source, content: blocks(["x".repeat(15_000), ...after]) };
    await prepareProjection([rewritten], state, false, "rewritten-source");
    expect(state.replacements.size).toBe(0);
    expect(state.frozen.size).toBe(0);
  });

  it("freezes #99495 ambiguous-key projections across filtered history", async () => {
    const { state, project } = projection(100, 100);
    const duplicate = (text: string) => ({ ...toolResult(text, "duplicate-call"), timestamp: 1 });
    const first = project([duplicate("a".repeat(100)), duplicate("b".repeat(100))]);
    const filtered = project([duplicate("b".repeat(100))]);

    expect(first.messages[0]).not.toEqual(first.messages[1]);
    expect(filtered.messages[0]).toEqual(first.messages[1]);
    await prepareProjection(
      [duplicate("b".repeat(100))],
      state,
      false,
      "ambiguous-filtered-history",
    );
    expectProjectionSize(state, 1, 0);
    expect(state.ambiguousBaseKeys.size).toBe(1);
    expect(project([duplicate("b".repeat(100))]).messages[0]).toEqual(first.messages[1]);
    await prepareProjection([], state, false, "ambiguous-removed-history");
    expect(state.ambiguousBaseKeys.size).toBe(0);
  });

  it("drops an unselected identical-occurrence key without changing projected bytes", async () => {
    const { state, project } = projection(100, 100);
    const duplicate = () => ({
      ...toolResult("x".repeat(100), "identical-call"),
      timestamp: 1_000,
    });
    const history = [duplicate(), assistant("separator"), duplicate()];
    const first = project(history);
    const stateWithStaleOccurrence = createToolResultPromptProjectionState(state);
    expect(stateWithStaleOccurrence.frozen.size).toBe(2);

    await prepareProjection([duplicate()], state, false, "identical-occurrence-compaction");

    const retainedWithStale = truncate([duplicate()], 128_000, 100, 100, stateWithStaleOccurrence);
    const retainedAfterPrune = project([duplicate()]);
    expect(retainedAfterPrune.messages).toEqual(retainedWithStale.messages);
    expect(retainedAfterPrune.messages[0]).toEqual(first.messages[0]);
    expect(state.frozen.size).toBe(1);
    expect(state.sourceHashByKey.size).toBe(1);
  });
});

async function createSession(sessionId: string, sessionKey = `agent:main:${sessionId}`) {
  const storePath = path.join(sessionDirs.make(), "sessions.json");
  const scope = { agentId: "main", sessionId, sessionKey, storePath };
  const sessionFile = formatSqliteSessionFileMarker(scope);
  await replaceSessionEntry({ sessionKey, storePath }, {
    sessionFile,
    sessionId,
    updatedAt: 10,
  } as SessionStoreEntry);
  return scope;
}

type SessionScope = Awaited<ReturnType<typeof createSession>>;

function recover(
  scope: SessionScope,
  overrides: Partial<Parameters<typeof truncateOversizedToolResultsInSessionManager>[0]> = {},
) {
  return truncateOversizedToolResultsInSessionManager({
    sessionManager: SessionManager.open(scope),
    ...scope,
    contextWindowTokens: 100,
    ...overrides,
  });
}

function append(scope: SessionScope, message: AgentMessage) {
  return appendTranscriptMessage(scope, { message });
}

function activeMessages(scope: Awaited<ReturnType<typeof createSession>>) {
  return SessionManager.open(scope)
    .getBranch()
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

async function storedMessages(scope: Awaited<ReturnType<typeof createSession>>) {
  return (await loadTranscriptEvents(scope)).filter(
    (entry): entry is { id: string; message: AgentMessage; type: "message" } =>
      typeof entry === "object" &&
      entry !== null &&
      "id" in entry &&
      typeof entry.id === "string" &&
      "message" in entry &&
      "type" in entry &&
      entry.type === "message",
  );
}

describe("truncateOversizedToolResultsInSession", () => {
  it("truncates SQLite runtime transcripts without treating the marker as a file", async () => {
    const scope = await createSession("runtime-sqlite-tool-truncation", "agent:main:test");
    await append(scope, user("run tools"));
    const staleCheckpointReplay = {
      v: 1,
      type: "openai-responses-compaction",
      data: "stale-checkpoint",
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5.2",
      baseUrlHash: "ozhevd1smnk8s",
    } satisfies NonNullable<AssistantMessage["providerReplay"]>;
    const checkpoint = (text: string, providerReplay: AssistantMessage["providerReplay"]) =>
      append(scope, { ...assistant(text), providerReplay });
    await checkpoint("pre-boundary checkpoint owner", staleCheckpointReplay);
    const medium = "alpha beta gamma delta epsilon ".repeat(600);
    const originalToolResultIds = new Set<string>();
    for (const message of toolResults(Array<string>(3).fill(medium))) {
      originalToolResultIds.add((await append(scope, message)).messageId);
    }
    await checkpoint("stale checkpoint owner", staleCheckpointReplay);
    const staleAnthropicCheckpointReplay = {
      ...staleCheckpointReplay,
      type: "anthropic-compaction",
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-sonnet-4-6",
    } satisfies NonNullable<AssistantMessage["providerReplay"]>;
    await checkpoint("stale Anthropic checkpoint owner", staleAnthropicCheckpointReplay);
    const suppressionReplay = {
      ...staleCheckpointReplay,
      type: "openai-responses-compaction-suppression",
      data: "rejected",
    } satisfies NonNullable<AssistantMessage["providerReplay"]>;
    await checkpoint("suppression owner", suppressionReplay);

    const listener = vi.fn();
    const cleanup = onInternalSessionTranscriptUpdate(listener);
    const result = await recover(scope);
    cleanup();

    expect(result.truncated).toBe(true);
    expect(result.truncatedCount).toBeGreaterThan(0);
    expect(listener).toHaveBeenCalledWith({
      sessionKey: scope.sessionKey,
      agentId: "main",
      sessionId: scope.sessionId,
      target: scope,
    });

    expect(
      (await storedMessages(scope))
        .filter((entry) => originalToolResultIds.has(entry.id))
        .map((entry) => entry.message)
        .filter((message) => message.role === "toolResult")
        .map(toolText),
    ).toEqual([medium, medium, medium]);

    const branchMessages = activeMessages(scope);
    const toolResultTexts = branchMessages
      .filter((message) => message.role === "toolResult")
      .map(toolText);
    const findAssistant = (text: string) =>
      branchMessages.find(
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

  it.each([
    ["per-result", 12_000, 48_000],
    ["aggregate-only", 8_000, 6_000],
  ] as const)(
    "recovers frozen %s history without rewriting original events",
    async (kind, cap, budget) => {
      const scope = await createSession(`runtime-sqlite-frozen-${kind}`);
      await append(scope, user("run tools"));
      const originals =
        kind === "per-result"
          ? [toolResult("frozen output ".repeat(2_000), "frozen_call")]
          : toolResults(
              ["a", "b", "c"].map((char) => char.repeat(6_000)),
              "frozen_agg",
            );
      const persisted: Array<Awaited<ReturnType<typeof append>>> = [];
      for (const message of originals) {
        persisted.push(await append(scope, message));
      }
      const { state, project } = projection(cap, 48_000);
      const projected = project(originals).messages;
      const stale = createToolResultPromptProjectionState(state);
      expect(state.frozen.size).toBe(originals.length);
      const result = await recover(scope, {
        contextWindowTokens: 128_000,
        maxCharsOverride: cap,
        aggregateMaxCharsOverride: budget,
        projectionState: state,
      });
      expect(result.truncated).toBe(true);
      const events = await storedMessages(scope);
      expect(
        persisted.map(({ messageId }) => events.find(({ id }) => id === messageId)?.message),
      ).toEqual(originals);
      if (kind === "aggregate-only") {
        expect(totalText(activeMessages(scope))).toBeLessThan(18_000);
      } else {
        expectProjectionSize(state, 0);
        await prepareProjection(
          SessionManager.open(scope).buildSessionContext().messages,
          stale,
          false,
          scope.sessionId,
        );
        expectProjectionSize(stale, 0);
        expect(activeMessages(scope).find((message) => message.role === "toolResult")).toEqual(
          projected[0],
        );
      }
    },
  );

  it("honors SQLite leaf controls when truncating runtime transcripts", async () => {
    const scope = await createSession("runtime-sqlite-leaf-tool-truncation", "agent:main:test");
    const activeLarge = "selected branch tool output ".repeat(700);
    const inactiveLarge = "inactive branch tool output ".repeat(700);
    const messageEntry = (
      id: string,
      parentId: string | null,
      message: AgentMessage,
      second: number,
    ) => ({
      type: "message" as const,
      id,
      parentId,
      message,
      timestamp: `2026-01-01T00:00:0${second}.000Z`,
    });
    await replaceTranscriptEvents(scope, [
      {
        type: "session",
        version: 3,
        id: scope.sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: path.dirname(scope.storePath),
      },
      messageEntry("root-user", null, user("run tools"), 1),
      messageEntry("selected-tool", "root-user", toolResult(activeLarge, "call_selected"), 2),
      messageEntry("inactive-tool", "root-user", toolResult(inactiveLarge, "call_inactive"), 3),
      {
        type: "leaf",
        id: "selected-leaf",
        parentId: "inactive-tool",
        timestamp: "2026-01-01T00:00:04.000Z",
        targetId: "selected-tool",
      },
    ]);

    const result = await recover(scope);

    expect(result.truncated).toBe(true);
    const stored = (await storedMessages(scope)).map((entry) => entry.message);
    const originalSelectedTool = findTool(stored, "call_selected");
    const inactiveTool = findTool(stored, "call_inactive");
    const selectedTool = findTool(activeMessages(scope), "call_selected");

    expect(selectedTool ? toolText(selectedTool) : "").toContain("truncated");
    expect(originalSelectedTool ? toolText(originalSelectedTool) : "").toBe(activeLarge);
    expect(inactiveTool ? toolText(inactiveTool) : "").toBe(inactiveLarge);
  });
});

describe("truncateToolResultText head+tail strategy", () => {
  it.each([
    "(Command exited with code 1)",
    "Command timed out after 5 seconds.",
    "Command timed out waiting for output.",
    "Command aborted by signal SIGTERM",
    "Process exited with signal SIGTERM.",
    "Process stopped by request (signal SIGTERM).",
    "Command not found",
    "Command not executable (permission denied)",
  ])("preserves the terminal diagnostic %s within the weighted cap", (diagnostic) => {
    const text = `${"progress output\n".repeat(800)}\n${diagnostic}`;
    const result = truncateToolResultText(text, 8_192, { minimumRawWeight: 4 });

    expect(result).toContain(diagnostic);
    expect(result).toContain("middle content omitted");
    expect(result.length * 4).toBeLessThanOrEqual(8_192);
  });

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
