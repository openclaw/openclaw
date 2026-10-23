import { expect, it, vi } from "vitest";
import type * as Cli from "./cli-output-contracts.js";
import {
  createClaudeParser,
  joinJsonlFrames,
  claudeStreamEvent,
  claudeTextDelta,
  localCliBackend,
} from "./cli-output.test-helpers.js";

type ParserOptions = Cli.CliJsonlStreamingParserOptions;
type ExpectedOutput = Pick<Cli.CliOutput, "text"> & Partial<Cli.CliOutput>;
function createParser(overrides: Partial<ParserOptions> = {}) {
  return createClaudeParser({
    backend: localCliBackend,
    providerId: "local-cli",
    ...overrides,
  });
}
function finishFrames(parser: ReturnType<typeof createParser>, ...frames: unknown[]) {
  const events = frames.map((frame) =>
    typeof frame === "string" ? claudeTextDelta(frame) : frame,
  );
  parser.push(joinJsonlFrames(...events, ""));
  parser.finish();
}
function result(text: string, fields: Record<string, unknown> = {}) {
  return { type: "result", result: text, ...fields };
}
function init(sessionId: string) {
  return { type: "init", session_id: sessionId };
}
const messageStart = claudeStreamEvent({ type: "message_start" });
const messageStop = claudeStreamEvent({ type: "message_stop" });
function message(text: string) {
  return [messageStart, claudeTextDelta(text)];
}
function reply(text: string) {
  return [claudeTextDelta(text), result(text)];
}
const draftMessage = [...message("Draft."), messageStop];
const toolProtocol = '<invoke name="Bash">\n<parameter name="command">echo 1';
function toolStart(id = "tool-1", index?: number) {
  return claudeStreamEvent({
    type: "content_block_start",
    ...(index === undefined ? {} : { index }),
    content_block: {
      type: "tool_use",
      id,
      name: "Read",
      ...(index === undefined ? {} : { input: {} }),
    },
  });
}
function itemMessage(text: string) {
  return { type: "item.completed", item: { type: "agent_message", text } };
}
function assistant(content: unknown[], model = "claude-sonnet-4-6") {
  return {
    type: "assistant",
    message: { model, role: "assistant", content },
  };
}
function syntheticNoResponse(text = "No response requested.", model = "<synthetic>") {
  return assistant([{ type: "text", text }], model);
}
function nativeInit(tools: string[], fields: Record<string, unknown> = {}) {
  return { type: "system", subtype: "init", tools, ...fields };
}
function expectOutput(
  parser: ReturnType<typeof createParser>,
  sessionId: string,
  expected: ExpectedOutput,
) {
  expect(parser.getOutput()).toEqual({ sessionId, usage: undefined, ...expected });
}
const stoppedFailure = {
  errorText:
    "Claude CLI ended the turn without a reply (terminal_reason: hook_stopped, stop_reason: tool_use).",
  terminalFailure: {
    reason: "turn_stopped",
    terminalReason: "hook_stopped",
    stopReason: "tool_use",
  },
} satisfies Partial<Cli.CliOutput>;

it.each<[name: string, frames: unknown[], expected: string[][]]>([
  [
    "fresh and warm parent initialization",
    [
      nativeInit(["Read", "Bash", "mcp__openclaw__automations"], {
        session_id: "reused-session",
      }),
      result("first turn complete"),
      nativeInit(["Read"], { session_id: "reused-session" }),
      result("warm turn complete"),
      nativeInit([], { session_id: "replacement-session" }),
    ],
    [["Read", "Bash", "mcp__openclaw__automations"], ["Read"], []],
  ],
  [
    "subagent and non-initialization exclusion",
    [
      nativeInit(["Read"], { parent_tool_use_id: null }),
      nativeInit(["Bash"], { parent_tool_use_id: "child-call" }),
      { type: "system", subtype: "status", tools: [] },
      { type: "assistant", tools: ["Write"] },
    ],
    [["Read"]],
  ],
])("observes native tools across chunked %s", (_name, frames, expected) => {
  const snapshots: unknown[] = [];
  const parser = createClaudeParser({ onNativeTools: (tools) => snapshots.push(tools) });
  const first = JSON.stringify(frames[0]);
  parser.push(first.slice(0, -2));
  expect(snapshots).toEqual([]);
  parser.push(first.slice(-2) + "\n" + joinJsonlFrames(...frames.slice(1)));
  parser.finish();
  expect(snapshots).toEqual(expected);
});

it.each<[name: string, frames: unknown[], expected: ExpectedOutput]>([
  [
    "exact synthetic empty terminal",
    [syntheticNoResponse()],
    {
      text: "",
      errorText: "Claude CLI returned a synthetic no-response result.",
      terminalFailure: { reason: "synthetic_no_response" },
    },
  ],
  ["ordinary lookalike", [syntheticNoResponse(undefined, "claude-sonnet-4-6")], { text: "" }],
  ["different synthetic text", [syntheticNoResponse("No reply needed.")], { text: "" }],
  ["real text", [syntheticNoResponse(), "real answer"], { text: "real answer" }],
  [
    "tool activity",
    [
      assistant([{ type: "tool_use", id: "tool-1", name: "Read", input: {} }]),
      syntheticNoResponse(),
    ],
    { text: "" },
  ],
])("classifies %s without confusing legitimate empty replies", (_name, frames, expected) => {
  const parser = createClaudeParser();
  finishFrames(
    parser,
    ...frames,
    result("", { subtype: "success", session_id: "synthetic-session" }),
  );
  expectOutput(parser, "synthetic-session", expected);
});

it.each<[name: string, frames: unknown[], terminalReason: string, expected: ExpectedOutput]>([
  ["empty hook-stopped turn", [], "hook_stopped", { text: "", ...stoppedFailure }],
  [
    "hook stop after streamed reply",
    ["streamed answer"],
    "hook_stopped",
    { text: "streamed answer" },
  ],
  ["backgrounded turn", [], "background_requested", { text: "" }],
  [
    "hook stop after an interim result",
    [
      result("Agent is running. I'll let you know when it finishes.", {
        subtype: "success",
        terminal_reason: "completed",
      }),
    ],
    "hook_stopped",
    { text: "", ...stoppedFailure },
  ],
])("judges delivery for the current %s", (_name, frames, terminalReason, expected) => {
  const parser = createClaudeParser();
  finishFrames(
    parser,
    ...frames,
    result("", {
      subtype: "success",
      is_error: false,
      session_id: "hook-stopped",
      stop_reason: "tool_use",
      terminal_reason: terminalReason,
    }),
  );
  expectOutput(parser, "hook-stopped", expected);
});

it.each([
  ["incomplete tool protocol", toolProtocol, true],
  ["plain prose", "partial answer", false],
  ["fenced example", "Example:\n```xml\n" + toolProtocol, false],
  ["first-line indented example", "    " + toolProtocol.replace("\n", "\n    "), false],
] as const)(
  "retains only usable interrupted %s without synthetic callbacks",
  (_name, text, rejected) => {
    const parseJsonlEvent = vi.fn(() => null);
    const parser = createClaudeParser({ parseJsonlEvent });
    const frame = claudeTextDelta(text);
    finishFrames(parser, frame);
    expect(parser.hasTerminalResult()).toBe(false);
    expect(parser.getOutput()).toMatchObject({ text: rejected ? "" : text.trim() });
    expect(parser.getOutput()?.errorText).toEqual(rejected ? expect.any(String) : undefined);
    expect(parseJsonlEvent).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(frame),
      expect.objectContaining({ backendId: "claude-cli" }),
    );
  },
);

it("keeps incomplete tool markup in a completed explanation", () => {
  const text = "Example:\n" + toolProtocol;
  const parser = createClaudeParser();
  finishFrames(parser, claudeTextDelta(text), result(text));
  expect(parser.getOutput()).toMatchObject({ text });
  expect(parser.getOutput()?.errorText).toBeUndefined();
});

it("rejects interrupted protocol projected by a custom Claude parser", () => {
  const parser = createClaudeParser({
    parseJsonlEvent: () => ({ kind: "text", text: toolProtocol }),
  });
  finishFrames(parser, { type: "custom-assistant", text: toolProtocol });
  expect(parser.getOutput()).toMatchObject({ text: "", errorText: expect.any(String) });
});

it.each<
  [
    name: string,
    frames: unknown[],
    expectedText: string,
    expectedRawFinalText?: string,
    checkDelta?: true | "reconstruct",
  ]
>([
  ["no result envelope", ["hello"], "hello", undefined, true],
  ["empty result envelope", ["hello", " world", result("")], "hello world"],
  [
    "tool split inside one message",
    [...message("Before."), toolStart(), ...reply("DONE")],
    "Before.\n\nDONE",
    "DONE",
  ],
  [
    "pre-tool text and reconstructible deltas without a commentary consumer",
    [...message("Before."), toolStart(), messageStop, messageStart, ...reply("DONE")],
    "Before.\n\nDONE",
    "DONE",
    "reconstruct",
  ],
  [
    "toolless closer after tool-using message",
    [...message("Before."), toolStart(), "After.", messageStop, messageStart, ...reply("DONE")],
    "Before.\n\nAfter.\n\nDONE",
    "DONE",
  ],
  [
    "existing newlines at message boundaries",
    [...message("Before.\n\n"), toolStart(), messageStart, ...reply("DONE")],
    "Before.\n\nDONE",
    "DONE",
  ],
  [
    "tool split after an ordinary boundary",
    [...draftMessage, ...message("Before."), toolStart(), ...reply("DONE")],
    "Before.\n\nDONE",
    "DONE",
  ],
  [
    "fresh message starting with a tool call",
    [...draftMessage, messageStart, toolStart(), ...reply("Fresh answer.")],
    "Fresh answer.",
  ],
  [
    "message boundary without a tool split",
    [...draftMessage, messageStart, ...reply("Final answer.")],
    "Final answer.",
  ],
  [
    "suffix match inside one message",
    [messageStart, "discarded draft authoritative result", result("authoritative result")],
    "authoritative result",
  ],
  [
    "divergent streamed text",
    ["draft wording", result("authoritative result")],
    "authoritative result",
  ],
])(
  "resolves streamed/result precedence for %s",
  (_name, frames, expectedText, expectedRawFinalText, checkDelta) => {
    const deltas: Parameters<ParserOptions["onAssistantDelta"]>[0][] = [];
    const sessionIds: string[] = [];
    const parser = createParser({
      onAssistantDelta: (delta) => deltas.push(delta),
      onSessionId: (id) => sessionIds.push(id),
    });
    finishFrames(parser, init("session-stream"), ...frames);
    expectOutput(parser, "session-stream", {
      text: expectedText,
      ...(expectedRawFinalText === undefined ? {} : { rawFinalText: expectedRawFinalText }),
    });
    if (checkDelta === true) {
      expect(deltas).toEqual([
        { text: "hello", delta: "hello", sessionId: "session-stream", usage: undefined },
      ]);
      expect(sessionIds).toEqual(["session-stream"]);
    }
    if (checkDelta === "reconstruct") {
      expect(deltas.map((entry) => entry.delta).join("")).toBe(expectedText);
      expect(deltas.at(-1)?.text).toBe(expectedText);
    }
  },
);

const checkingMessage = [...message("Checking now."), toolStart("toolu_1", 1), messageStop];
const finalMessage = [...message("Final answer"), messageStop];
it.each<[name: string, frames: unknown[], expected: string, commentary?: boolean]>([
  ["a tool call after stored item text", [itemMessage("Checking now."), toolStart()], ""],
  ["a new message after stored item text", [itemMessage("Checking now."), messageStart], ""],
  [
    "a tool item after stored item text",
    [itemMessage("Checking now."), { type: "item.completed", item: { type: "command_execution" } }],
    "",
  ],
  [
    "item text after an earlier boundary",
    [messageStart, toolStart(), itemMessage("All done.")],
    "All done.",
  ],
  ["a streamed final answer", finalMessage, "Final answer", true],
  [
    "a final answer after pre-tool commentary",
    [...checkingMessage, ...finalMessage],
    "Final answer",
    true,
  ],
  ["a tool-only ending after commentary", checkingMessage, "", true],
])("records the final message across %s", (_name, frames, expected, commentary) => {
  const parser = commentary
    ? createClaudeParser({ onCommentaryText: () => undefined })
    : createParser();
  finishFrames(
    parser,
    init(commentary ? "session-commentary-final" : "session-items"),
    ...frames,
    result(""),
  );
  const output = parser.getOutput();
  expect(output?.rawFinalText ?? output?.text.trim()).toBe(expected);
});

it("judges post-interim-result segments on their own stream state", () => {
  const deltas: Array<{ text: string; delta: string }> = [];
  const parser = createParser({ onAssistantDelta: (delta) => deltas.push(delta) });
  finishFrames(
    parser,
    init("session-interim"),
    messageStart,
    ...reply("Interim answer."),
    ...message("Pre-tool follow-up."),
    toolStart("tool-2"),
    ...reply("DONE"),
  );
  expect(parser.getOutput()?.text).toBe("Interim answer.\nPre-tool follow-up.\n\nDONE");
  expect(deltas.at(-1)?.text).toBe("Interim answer.\n\nPre-tool follow-up.\n\nDONE");
  expect(deltas.map((entry) => entry.delta).join("")).toBe(
    "Interim answer.\n\nPre-tool follow-up.\n\nDONE",
  );
});

it.each<[name: string, frames: unknown[], expected: string[]]>([
  ["no preceding text", [toolStart("toolu_1", 0)], []],
  [
    "consecutive tool blocks",
    ["First, checking files.", toolStart("toolu_1", 1), toolStart("toolu_2", 2)],
    ["First, checking files."],
  ],
  [
    "new text segments",
    ["Reading the file now.", toolStart("toolu_a", 1), " Now searching.", toolStart("toolu_b", 3)],
    ["Reading the file now.", "Now searching."],
  ],
])("emits commentary once for %s", (_name, frames, expected) => {
  const commentaryTexts: string[] = [];
  const parser = createClaudeParser({ onCommentaryText: (text) => commentaryTexts.push(text) });
  finishFrames(parser, init("session-commentary"), ...frames);
  expect(commentaryTexts).toEqual(expected);
});

it("delivers completed shared-prefix results before settlement and retains retry boundaries", () => {
  const results = ["Hi", "History matters.", "Final answer."];
  const completed: string[] = [];
  const indices: number[] = [];
  const parser = createClaudeParser({
    onCompletedReply: (text, index) => {
      completed.push(text);
      indices.push(index);
    },
  });
  for (const text of results.slice(0, 2)) {
    parser.push(
      joinJsonlFrames(result(text, { subtype: "success", openclaw_interim_result: true }), ""),
    );
  }
  expect(completed).toEqual(results.slice(0, 2));
  expect(indices).toEqual([0, 1]);
  finishFrames(parser, result("Final answer.", { subtype: "success" }));
  expect(completed).toEqual(results.slice(0, 2));
  expect(parser.getOutput()).toMatchObject({ text: results.join("\n"), textParts: results });
});

it("does not redeliver repeated or empty held result acknowledgments", () => {
  const completed: string[] = [];
  const parser = createClaudeParser({ onCompletedReply: (text) => completed.push(text) });
  for (const text of [
    "First answer.",
    "",
    "First answer.",
    "Second answer.",
    "Second answer.",
    "",
  ]) {
    parser.push(
      joinJsonlFrames(result(text, { subtype: "success", openclaw_interim_result: true }), ""),
    );
  }
  parser.finish();
  expect(completed).toEqual(["First answer.", "Second answer."]);
  expect(parser.getOutput()).toMatchObject({
    text: "First answer.\nSecond answer.",
    textParts: ["First answer.", "Second answer."],
  });
  expect(parser.hasTerminalResult()).toBe(false);
  parser.push(joinJsonlFrames(result("Second answer.", { subtype: "success" }), ""));
  expect(parser.hasTerminalResult()).toBe(true);
  expect(parser.getOutput()?.textParts).toEqual(["First answer.", "Second answer."]);
});

it.each([
  {
    subtype: "error_during_execution",
    is_error: true,
    result: "Failed answer",
    errors: ["synthetic failure"],
  },
  { subtype: "success", result: "", terminal_reason: "hook_stopped", stop_reason: "tool_use" },
])("does not dispatch failed held results: $subtype $terminal_reason", (fields) => {
  const completed: string[] = [];
  const parser = createClaudeParser({ onCompletedReply: (text) => completed.push(text) });
  finishFrames(parser, { type: "result", ...fields, openclaw_interim_result: true });
  expect(completed).toEqual([]);
  expect(parser.getOutput()?.errorText).toBeTruthy();
});
