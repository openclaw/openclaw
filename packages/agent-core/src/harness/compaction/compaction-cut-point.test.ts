import { describe, expect, it } from "vitest";
import { projectSessionModelContextNavigation } from "../../../../../src/config/sessions/session-model-context-navigation.js";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import { findCutPointFromSource } from "./compaction-cut-point.js";
import { estimateTokens, findCutPoint as findArrayCutPoint } from "./compaction.js";
import { createMessageEntry as messageEntry } from "./compaction.test-support.js";
import { assistant, text, toolCall, toolResult, user } from "./shard-fixtures.test-support.js";

const cutPointImplementations = [
  ["array", findArrayCutPoint],
  [
    "indexed",
    (entries, start, end, keep, constraints) => {
      const navigation = entries.map(projectSessionModelContextNavigation);
      let release = () => {};
      return findCutPointFromSource(
        {
          length: entries.length,
          metadata: (index: number) => navigation[index],
          get: (index) => {
            // A planner must consume payloads before advancing its hydration window.
            release();
            const entry = entries[index];
            if (entry?.type !== "message") {
              return entry;
            }
            const { proxy, revoke } = Proxy.revocable(structuredClone(entry.message), {});
            release = revoke;
            return { ...entry, message: proxy };
          },
        },
        start,
        end,
        keep,
        constraints,
      );
    },
  ],
] satisfies Array<[string, typeof findArrayCutPoint]>;

const KEEP_RECENT_TOKENS = 20000;
const LARGE_TOOL_OUTPUT = "x".repeat(120000);

const userText = (content: string, timestamp: number) => user([text(content)], timestamp);

const assistantText = (content: string, timestamp: number) =>
  assistant(content, {
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-fable-5",
    timestamp,
  });

const toolResultText = (content: string, timestamp: number) =>
  toolResult(content, { toolName: "bash", timestamp });
const callingAssistant = (name: string, id: string): AgentMessage => ({
  ...assistantText("", 2),
  content: [{ ...toolCall(name, {}, id), async: true }],
  stopReason: "toolUse",
});

function nestedToolResult(
  block: { type: string; content?: unknown; text?: string },
  timestamp: number,
): AgentMessage {
  return {
    ...toolResult([], { toolName: "codex_progress", timestamp }),
    content: [{ id: "call-1", toolUseId: "call-1", ...block }],
  } as unknown as AgentMessage;
}

function buildTranscriptWithToolResult(
  result: AgentMessage = toolResultText(LARGE_TOOL_OUTPUT, 5),
): SessionTreeEntry[] {
  return [
    userText("start of the conversation", 1),
    assistantText("first reply", 2),
    userText("please run the command", 3),
    assistantText("running it now", 4),
    result,
  ].map(messageEntry);
}

describe.each(cutPointImplementations)("findCutPoint (%s)", (_implementation, findCutPoint) => {
  function foregroundBudget(entries: SessionTreeEntry[]) {
    const maxTokens = entries
      .slice(2)
      .reduce(
        (total, entry) => total + (entry.type === "message" ? estimateTokens(entry.message) : 0),
        0,
      );
    return { budget: { maxTokens, reserveTokens: 0, estimateTokens } };
  }

  function asynchronousMessages(resultBeforeText = false): AgentMessage[] {
    const progress = assistantText("Independent explanation. ".repeat(50), 3);
    const result = toolResultText("The actual lookup result is 7319.", 4);
    return [
      userText("Run the lookup and explain the approach.", 1),
      callingAssistant("bash", "call-1"),
      ...(resultBeforeText ? [result, progress] : [progress, result]),
      assistantText("Done.", 5),
    ];
  }
  const asynchronousExchange = (resultBeforeText = false) =>
    asynchronousMessages(resultBeforeText).map(messageEntry);

  it.each([
    ["retains an async call whose result follows another assistant fragment", false, 1],
    ["can summarize a completed tool exchange before the retained explanation", true, 3],
  ] as const)("%s", (_name, resultBeforeText, firstKeptEntryIndex) => {
    const entries = asynchronousExchange(resultBeforeText);
    const result = findCutPoint(entries, 0, entries.length, 100);

    expect(result).toMatchObject({ firstKeptEntryIndex, isSplitTurn: true });
  });

  it.each([
    ["summarizes the complete exchange when its call cannot fit the foreground budget", true],
    ["refuses a foreground tail that can only fit an incomplete tool exchange", false],
  ] as const)("%s", (_name, complete) => {
    const entries = complete ? asynchronousExchange() : asynchronousExchange().slice(0, -1);
    expect(
      findCutPoint(entries, 0, entries.length, 100, foregroundBudget(entries)).firstKeptEntryIndex,
    ).toBe(complete ? 4 : entries.length);
  });

  it("keeps an older call when a pending user message arrives before its result", () => {
    const messages = asynchronousMessages();
    messages.splice(3, 0, userText("Please preserve this pending request.", 3));
    const entries = messages.map(messageEntry);

    expect(
      findCutPoint(entries, 0, entries.length, 1, {
        requestBoundary: { entryId: "entry-3", preserve: true },
      }).firstKeptEntryIndex,
    ).toBe(1);
  });

  it("does not pull a previous completed occurrence with a reused provider id into the tail", () => {
    const messages = asynchronousMessages();
    messages.splice(
      1,
      0,
      callingAssistant("bash", "call-1"),
      toolResultText("Earlier completed result.", 2),
    );
    const entries = messages.map(messageEntry);

    expect(findCutPoint(entries, 0, entries.length, 100).firstKeptEntryIndex).toBe(3);
  });

  it("keeps the real late result with the call whose synthetic result it replaces", () => {
    const messages = asynchronousMessages();
    messages.splice(2, 0, {
      ...toolResultText("Missing result.", 2),
      isError: true,
      details: { openclawSyntheticMissingToolResult: true },
    });
    const entries = messages.map(messageEntry);

    expect(findCutPoint(entries, 0, entries.length, 100).firstKeptEntryIndex).toBe(1);
  });

  it("keeps overlapping asynchronous calls and out-of-order results in one retained group", () => {
    const messages = asynchronousMessages();
    messages.splice(2, 0, callingAssistant("read", "call-2"));
    messages.splice(4, 0, {
      ...toolResultText("Second call finished first.", 4),
      toolCallId: "call-2",
      toolName: "read",
    });
    const entries = messages.map(messageEntry);

    expect(findCutPoint(entries, 0, entries.length, 100).firstKeptEntryIndex).toBe(1);
  });

  it("preserves the pending suffix before a foreground budget exists", () => {
    const pending = messageEntry(userText("first admitted input", 3), 2);
    const entries = [
      messageEntry(userText("processed request", 1), 0),
      messageEntry(assistantText("processed answer", 2), 1),
      pending,
      messageEntry(userText("later admitted input", 4), 3),
    ];
    expect(findCutPoint(entries, 0, entries.length, 1).firstKeptEntryIndex).toBe(3);
    expect(
      findCutPoint(entries, 0, entries.length, 1, {
        requestBoundary: { entryId: pending.id, preserve: true },
      }),
    ).toEqual({ firstKeptEntryIndex: 2, turnStartIndex: -1, isSplitTurn: false });
  });

  it.each([true, false])("preserves custom carrier turn classification (%s)", (carrier) => {
    const entries = [
      messageEntry(userText("Start", 1), 0),
      messageEntry(
        {
          role: "custom",
          customType: "openclaw.runtime-context",
          content: "Runtime note",
          display: false,
          details: { source: "openclaw-runtime-context", runtimeContextCarrier: carrier },
          timestamp: 2,
        },
        1,
      ),
      messageEntry(assistantText("Latest answer", 3), 2),
    ];
    expect(findCutPoint(entries, 0, entries.length, 1)).toEqual({
      firstKeptEntryIndex: 2,
      turnStartIndex: carrier ? 0 : 1,
      isSplitTurn: true,
    });
  });

  it("trims the prefix instead of keeping the whole transcript", () => {
    const entries = buildTranscriptWithToolResult();

    const result = findCutPoint(entries, 0, entries.length, KEEP_RECENT_TOKENS);

    expect(result.firstKeptEntryIndex).toBe(3);
  });

  it.each([
    {
      name: "Codex toolResult text",
      block: { type: "toolResult", content: "duplicate", text: LARGE_TOOL_OUTPUT },
    },
    {
      name: "snake-case tool_result content",
      block: { type: "tool_result", content: LARGE_TOOL_OUTPUT },
    },
  ])("counts and trims the prefix for $name", ({ block }) => {
    const trailing = nestedToolResult(block, 5);
    const entries = buildTranscriptWithToolResult(trailing);

    expect(estimateTokens(trailing)).toBeGreaterThanOrEqual(KEEP_RECENT_TOKENS);
    const result = findCutPoint(entries, 0, entries.length, KEEP_RECENT_TOKENS);

    expect(result.firstKeptEntryIndex).toBe(3);
  });
});

describe.each(cutPointImplementations)(
  "findCutPoint with metadata (%s)",
  (_implementation, findCutPoint) => {
    // Gateway runs write these entries: a model snapshot inside a turn, and the bootstrap
    // marker after each completed run, right before the next user message.
    const metadata = (index: number, customType: string): SessionTreeEntry => ({
      type: "custom",
      customType,
      data: { timestamp: index },
      id: `entry-${index}`,
      parentId: `entry-${index - 1}`,
      timestamp: new Date(index).toISOString(),
    });
    const long = (label: string) => `${label} ${"checklist line. ".repeat(250)}`;
    const transcript = (turn2User: string, turn2Reply: string) => [
      messageEntry(userText(long("turn 1"), 1), 0),
      messageEntry(assistantText("reply 1", 2), 1),
      metadata(2, "openclaw:bootstrap-context:full"),
      messageEntry(userText(turn2User, 4), 3),
      metadata(4, "model-snapshot"),
      messageEntry(assistantText(turn2Reply, 6), 5),
      metadata(6, "openclaw:bootstrap-context:full"),
    ];

    it("keeps the marker without splitting the previous complete turn", () => {
      const entries = transcript(long("turn 2"), "reply 2");
      expect(findCutPoint(entries, 0, entries.length, 500)).toEqual({
        firstKeptEntryIndex: 2,
        turnStartIndex: -1,
        isSplitTurn: false,
      });
    });

    it("still splits a turn when metadata precedes a cut inside it", () => {
      const entries = transcript("turn 2", long("reply 2"));
      expect(findCutPoint(entries, 0, entries.length, 500)).toEqual({
        firstKeptEntryIndex: 4,
        turnStartIndex: 3,
        isSplitTurn: true,
      });
    });
  },
);

it("plans ownership without hydrating historical payloads outside the retained tail", () => {
  const entries = Array.from({ length: 100 }, (_, index) =>
    messageEntry(userText("Older conversation text", index), index),
  );
  entries.push(messageEntry(assistantText("Latest answer", 101), 100));
  const navigation = entries.map(projectSessionModelContextNavigation);
  let payloadReads = 0;
  const result = findCutPointFromSource(
    {
      length: entries.length,
      metadata: (index) => navigation[index],
      get(index) {
        payloadReads++;
        return entries[index];
      },
    },
    0,
    entries.length,
    1,
  );
  expect(result).toEqual({ firstKeptEntryIndex: 100, turnStartIndex: 99, isSplitTurn: true });
  expect(payloadReads).toBeLessThan(10);
});
