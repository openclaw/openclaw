import { describe, expect, it, vi } from "vitest";
import type { CliBackendParsedJsonlEvent } from "../plugins/cli-backend.types.js";
import type {
  CliCompactionDelta,
  CliToolInputDelta,
  CliToolResultDelta,
  CliToolUseStartDelta,
} from "./cli-output-contracts.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";
import {
  createGeminiBackend,
  createClaudeParser,
  createClaudeBackend,
  claudeBlockStart,
  claudeBlockStop,
  claudeInputJsonDelta,
  claudeStreamEvent,
  claudeTextDelta,
  joinJsonlFrames,
  finishCliFrames,
  localCliBackend,
  createPluginParser,
  claudeMessageStop,
} from "./cli-output.test-helpers.js";

function assistantTool(id: string, name: string, input: Record<string, unknown>) {
  return { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } };
}

const toolStart = (toolCallId: string, name: string, args: unknown) => ({
  toolCallId,
  name,
  kind: "tool_use",
  args,
});
const assistantDelta = (text: string, delta: string, sessionId: string) => ({
  text,
  delta,
  sessionId,
  usage: undefined,
});
function toolProgressHarness() {
  const progress: CliToolInputDelta[] = [];
  const starts: CliToolUseStartDelta[] = [];
  const parser = createClaudeParser({
    onAssistantDelta: vi.fn(),
    onToolInputDelta: (delta) => progress.push(delta),
    onToolUseStart: (delta) => starts.push(delta),
  });
  return { parser, progress, starts };
}

function createToolEventParser() {
  const starts: CliToolUseStartDelta[] = [];
  const results: Array<{ toolCallId: string; name: string; isError: boolean; result?: unknown }> =
    [];
  const parser = createClaudeParser({
    backend: createClaudeBackend(),
    onToolUseStart: (delta) => starts.push(delta),
    onToolResult: (delta) => results.push(delta),
  });
  return { starts, results, parser };
}

describe("createCliJsonlStreamingParser events", () => {
  it("does not start interrupted tool input when a later message reuses its index for text", () => {
    const starts: CliToolUseStartDelta[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { command: "fixture", output: "jsonl", jsonlDialect: "claude-stream-json" },
      providerId: "fixture-cli",
      onAssistantDelta: () => {},
      onToolUseStart: (delta) => starts.push(delta),
    });
    finishCliFrames(
      parser,
      claudeStreamEvent({ type: "message_start", message: { id: "interrupted" } }),
      claudeBlockStart({ type: "tool_use", id: "abandoned", name: "Write", input: {} }, 0),
      claudeInputJsonDelta('{"content":"unfinished\\n', 0),
      claudeStreamEvent({ type: "message_start", message: { id: "recovered" } }),
      claudeBlockStart({ type: "text", text: "" }, 0),
      claudeTextDelta("Recovered.", 0),
      claudeBlockStop(0),
      claudeMessageStop(),
      { type: "result", subtype: "success", result: "Recovered." },
      "",
    );
    expect(starts).toEqual([]);
    expect(parser.getOutput()?.text).toBe("Recovered.");
  });

  it.each([
    {
      name: "Write",
      args: { file_path: "fixture.txt", content: "one\ntwo\n" },
      diff: { added: 2, removed: 0 },
    },
    {
      name: "Edit",
      args: { file_path: "fixture.txt", old_string: "old\n", new_string: "new\nnext\n" },
      diff: { added: 2, removed: 1 },
    },
  ])(
    "streams bounded $name input progress before complete-argument execution starts",
    ({ name, args, diff }) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      try {
        const { parser, progress, starts } = toolProgressHarness();
        const push = (event: Record<string, unknown>, parentToolUseId?: string) =>
          parser.push(
            JSON.stringify({ type: "stream_event", event, parent_tool_use_id: parentToolUseId }) +
              "\n",
          );
        push(claudeBlockStart({ type: "tool_use", id: "call-1", name, input: {} }, 0).event);
        // Subagent blocks share numeric indexes with their parent but own no parent progress.
        push(
          claudeBlockStart({ type: "tool_use", id: "child", name: "Write", input: {} }, 0).event,
          "parent",
        );
        push(claudeInputJsonDelta('{"content":"child\\n', 0).event, "parent");
        const json = JSON.stringify(args);
        for (let offset = 0; offset < json.length; offset += 7) {
          vi.setSystemTime(Date.now() + 250);
          push(claudeInputJsonDelta(json.slice(offset, offset + 7), 0).event);
        }
        expect(starts).toEqual([]);
        expect(progress.length).toBeGreaterThan(0);
        expect(progress.at(-1)).toEqual({
          toolCallId: "call-1",
          name: name.toLowerCase(),
          inputChars: json.length,
          diff,
        });
        expect(
          progress.every(
            (delta) =>
              Object.keys(delta).toSorted().join(",") === "diff,inputChars,name,toolCallId",
          ),
        ).toBe(true);
        push({ type: "content_block_stop", index: 0 });
        finishCliFrames(parser, assistantTool("call-1", name, args), "");
        expect(starts).toEqual([toolStart("call-1", name, args)]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("throttles fragmented input and retires counters across stops, snapshots, and reused indexes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const { parser, progress, starts } = toolProgressHarness();
      const push = (frame: unknown) => parser.push(joinJsonlFrames(frame, ""));
      const start = (id: string, index = 0) =>
        push(claudeBlockStart({ type: "tool_use", id, name: "Write", input: {} }, index));
      const delta = (partial_json: string, index = 0) =>
        push(claudeInputJsonDelta(partial_json, index));
      const snapshot = (id: string, input: Record<string, unknown>) =>
        push(assistantTool(id, "Write", input));
      start("fragmented");
      delta('{"content":"one\\n');
      delta("two\\n");
      vi.setSystemTime(1_249);
      delta("three\\n");
      expect(progress).toEqual([
        {
          toolCallId: "fragmented",
          name: "write",
          inputChars: '{"content":"one\\n'.length,
          diff: { added: 1, removed: 0 },
        },
      ]);
      expect(starts).toEqual([]);
      vi.setSystemTime(1_250);
      delta('four\\n"}');
      expect(progress.at(-1)?.diff).toEqual({ added: 4, removed: 0 });
      // A repeated begin for the same call cannot move its visible counts backwards.
      start("fragmented");
      vi.setSystemTime(1_500);
      delta('{"content":"one\\n');
      expect(progress).toHaveLength(2);
      delta('two\\nthree\\nfour\\n"}');
      push(claudeBlockStop(0));
      const args = { content: "one\ntwo\nthree\nfour\n" };
      snapshot("fragmented", args);
      expect(starts).toEqual([toolStart("fragmented", "Write", args)]);
      start("fragmented");
      delta('{"content":"replay\\n"}');
      push(claudeBlockStop(0));
      expect(progress).toHaveLength(2);
      expect(starts).toHaveLength(1);
      start("fresh");
      delta('{"content":"fresh\\n"}');
      expect(progress.at(-1)).toEqual({
        toolCallId: "fresh",
        name: "write",
        inputChars: '{"content":"fresh\\n"}'.length,
        diff: { added: 1, removed: 0 },
      });
      push(claudeBlockStop(0));
      // Both completion shapes must release the shared 64-call progress budget.
      for (let index = 1; index <= 65; index++) {
        const id = `completed-${index}`;
        start(id, index);
        delta('{"content":"line\\n"}', index);
        if (index % 2 === 0) {
          push(claudeBlockStop(index));
        } else {
          snapshot(id, { content: "line\n" });
        }
      }
      expect(progress).toHaveLength(68);
      expect(starts).toHaveLength(67);
      parser.finish();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops counting oversized streamed input without truncating complete execution arguments", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { parser, progress, starts } = toolProgressHarness();
    const args = { content: `${"x".repeat(1024 * 1024)}\n` };
    const input = JSON.stringify(args);
    const events = [
      claudeBlockStart({ type: "tool_use", id: "large", name: "Write", input: {} }, 0),
      ...[input.slice(0, 512 * 1024), input.slice(512 * 1024)].map((partial_json) =>
        claudeInputJsonDelta(partial_json, 0),
      ),
      claudeBlockStop(0),
    ];
    try {
      parser.push(joinJsonlFrames(...events) + "\n");
      parser.finish();
    } finally {
      vi.useRealTimers();
    }
    // Only the first chunk lands outside the throttle window: it reports length, no lines yet.
    expect(progress).toEqual([
      {
        toolCallId: "large",
        name: "write",
        inputChars: 512 * 1024,
        diff: { added: 0, removed: 0 },
      },
    ]);
    expect(starts).toEqual([toolStart("large", "Write", args)]);
  });

  it("streams Gemini message deltas and tool events", () => {
    const name = "mcp_openclaw_create_goal";
    const deltas: Array<{ text: string; delta: string; sessionId?: string }> = [];
    const starts: CliToolUseStartDelta[] = [];
    const results: CliToolResultDelta[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: { ...createGeminiBackend(), sessionIdFields: ["session_id"] },
      providerId: "google-gemini-cli",
      onAssistantDelta: (delta) => deltas.push(delta),
      onToolUseStart: (delta) => starts.push(delta),
      onToolResult: (delta) => results.push(delta),
    });

    finishCliFrames(
      parser,
      { type: "init", session_id: "gemini-session-stream" },
      { type: "message", role: "assistant", content: "Checking tools. ", delta: true },
      {
        type: "tool_use",
        tool_name: name,
        tool_id: "tool-1",
        parameters: { objective: "Update files" },
      },
      {
        type: "tool_result",
        tool_id: "tool-1",
        status: "success",
        output: "created",
      },
      { type: "message", role: "assistant", content: "Done.", delta: true },
      {
        type: "result",
        status: "success",
        stats: { total_tokens: 9, input_tokens: 4, output_tokens: 5 },
      },
      "",
    );

    expect(deltas).toEqual([
      assistantDelta("Checking tools. ", "Checking tools. ", "gemini-session-stream"),
      assistantDelta("Checking tools. Done.", "Done.", "gemini-session-stream"),
    ]);
    expect(starts).toEqual([toolStart("tool-1", name, { objective: "Update files" })]);
    expect(results).toEqual([{ toolCallId: "tool-1", name, isError: false, result: "created" }]);
    expect(parser.getOutput()).toEqual({
      text: "Checking tools. Done.",
      // Diagnostics record only the post-tool message as the final answer.
      rawFinalText: "Done.",
      sessionId: "gemini-session-stream",
      usage: {
        input: 4,
        output: 5,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: 9,
      },
    });
  });

  it("streams plugin-owned JSONL events through normalized core projections", () => {
    const assistantDeltas: Array<{ text: string; delta: string; sessionId?: string }> = [];
    const thinkingDeltas: Array<{ text: string; delta: string }> = [];
    const displayStarts: CliToolUseStartDelta[] = [];
    const displayResults: CliToolResultDelta[] = [];
    const parsedStarts: CliToolUseStartDelta[] = [];
    const sessionIds: string[] = [];
    const usageEvents: Array<{ usage: unknown; isTerminal: boolean }> = [];
    const frames = [
      { kind: "sessionId", sessionId: "custom-session" },
      { kind: "thinking", text: "Checking " },
      { kind: "thinking", text: "facts." },
      { kind: "text", text: "Hello " },
      { kind: "text", text: "world" },
      { kind: "toolStart", toolCallId: "call-1", name: "search", args: { query: "weather" } },
      { kind: "toolResult", toolCallId: "call-1", name: "search", result: "sunny" },
      {
        kind: "result",
        text: "Hello world",
        sessionId: "custom-successor",
        usage: { input: 3, output: 2, total: 5 },
      },
    ] satisfies CliBackendParsedJsonlEvent[];
    const parser = createPluginParser({
      parseJsonlEvent: (line) => frames.find((frame) => JSON.stringify(frame) === line) ?? null,
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
      onToolUseStart: (delta) => parsedStarts.push(delta),
      onDisplayToolUseStart: (delta) => displayStarts.push(delta),
      onDisplayToolResult: (delta) => displayResults.push(delta),
      onSessionId: (sessionId) => sessionIds.push(sessionId),
      onUsage: (usage, isTerminal) => usageEvents.push({ usage, isTerminal }),
    });

    finishCliFrames(parser, ...frames, "");

    expect(assistantDeltas).toEqual([
      assistantDelta("Hello ", "Hello ", "custom-session"),
      assistantDelta("Hello world", "world", "custom-session"),
    ]);
    expect(thinkingDeltas).toEqual([
      { text: "Checking ", delta: "Checking ", isReasoningSnapshot: true },
      { text: "Checking facts.", delta: "facts.", isReasoningSnapshot: true },
    ]);
    expect(displayStarts).toEqual([toolStart("call-1", "search", { query: "weather" })]);
    expect(displayResults).toEqual([
      { toolCallId: "call-1", name: "search", isError: false, result: "sunny" },
    ]);
    expect(parsedStarts).toEqual([]);
    expect(sessionIds).toEqual(["custom-session", "custom-successor"]);
    expect(usageEvents).toEqual([{ usage: { input: 3, output: 2, total: 5 }, isTerminal: true }]);
    expect(parser.getOutput()).toEqual({
      text: "Hello world",
      sessionId: "custom-successor",
      usage: { input: 3, output: 2, total: 5 },
    });
  });

  it("replaces an earlier final message when a later custom result supplies the answer", () => {
    const parser = createPluginParser({
      parseJsonlEvent: (line) => {
        const event = JSON.parse(line) as { type: string; text?: string };
        if (event.type === "text") {
          return { kind: "text", text: event.text ?? "" };
        }
        if (event.type === "tool-start") {
          return { kind: "toolStart", toolCallId: "call-1", name: "search", args: {} };
        }
        return { kind: "result", text: event.text };
      },
    });

    parser.push(
      `${joinJsonlFrames(
        { type: "text", text: "Checking. " },
        { type: "tool-start" },
        { type: "text", text: "Done." },
        { type: "result" },
      )}\n`,
    );
    expect(parser.getOutput()?.rawFinalText).toBe("Done.");

    parser.push(`${joinJsonlFrames({ type: "result", text: "Replacement answer" })}\n`);
    parser.finish();

    const output = parser.getOutput();
    expect(output?.text).toBe("Replacement answer");
    expect(output?.rawFinalText).toBeUndefined();
  });

  it("lets plugin parsers own their frames before lazily parsing fallback JSON", () => {
    using parseSpy = vi.spyOn(JSON, "parse");
    const parseCountsAtPluginEntry: number[] = [];
    const parser = createPluginParser({
      parseJsonlEvent: (line) => {
        parseCountsAtPluginEntry.push(parseSpy.mock.calls.length);
        if (line === "plain provider frame") {
          return { kind: "text", text: "plain" };
        }
        if (line.includes('"item.completed"')) {
          return null;
        }
        const event = JSON.parse(line) as { text: string };
        return { kind: "text", text: event.text };
      },
    });

    parser.push("plain provider frame\n");
    expect(parseSpy).not.toHaveBeenCalled();

    parser.push(`${JSON.stringify({ text: " provider JSON" })}\n`);
    expect(parseSpy).toHaveBeenCalledTimes(1);

    parser.push(
      `${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "fallback" },
      })}\n`,
    );
    expect(parseCountsAtPluginEntry).toEqual([0, 0, 1]);
    expect(parseSpy).toHaveBeenCalledTimes(2);
  });

  it("projects lifecycle events without dropping fork-successor session metadata", () => {
    const compactionEvents: CliCompactionDelta[] = [];
    const sessionIds: string[] = [];
    const parseJsonlEvent = vi.fn(() => ({ kind: "result" as const, text: "done" }));
    const parser = createPluginParser({
      backend: { command: "acme", output: "jsonl", sessionIdFields: ["session_id"] },
      parseJsonlLifecycleEvent: (line) => {
        const event = JSON.parse(line) as { type?: string; completed?: boolean };
        return event.type === "compaction"
          ? event.completed === undefined
            ? { kind: "compaction", phase: "start" }
            : { kind: "compaction", phase: "end", completed: event.completed }
          : null;
      },
      parseJsonlEvent,
      onCompaction: (event) => compactionEvents.push(event),
      onSessionId: (sessionId) => sessionIds.push(sessionId),
    });

    finishCliFrames(
      parser,
      { type: "compaction", session_id: "fork-successor" },
      { type: "compaction", completed: true },
      { type: "result" },
      "",
    );

    expect(compactionEvents).toEqual([{ phase: "start" }, { phase: "end", completed: true }]);
    expect(sessionIds).toEqual(["fork-successor"]);
    expect(parseJsonlEvent).toHaveBeenCalledOnce();
    expect(parser.getOutput()).toEqual({
      text: "done",
      sessionId: "fork-successor",
      usage: undefined,
    });
  });

  it("streams detailed Gemini error events over generic result errors", () => {
    const parser = createCliJsonlStreamingParser({
      backend: createGeminiBackend(),
      providerId: "google-gemini-cli",
      onAssistantDelta: () => {},
    });

    parser.push(
      joinJsonlFrames(
        {
          type: "error",
          timestamp: "2026-06-16T19:36:48.000Z",
          severity: "error",
          message: "Invalid stream payload",
        },
        {
          type: "result",
          timestamp: "2026-06-16T19:36:49.000Z",
          status: "error",
          stats: { total_tokens: 1 },
        },
      ) + "\n",
    );
    parser.finish();

    expect(parser.getOutput()).toEqual({
      text: "",
      sessionId: undefined,
      usage: {
        input: undefined,
        output: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: 1,
      },
      errorText: "Invalid stream payload",
    });
  });

  it("surfaces Claude tool_use start and result events", () => {
    const { starts, results, parser } = createToolEventParser();

    parser.push(
      joinJsonlFrames(
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: "total 0\n",
                is_error: false,
              },
            ],
          },
        },
      ) + "\n",
    );
    parser.finish();

    expect(starts).toEqual([
      { toolCallId: "toolu_1", name: "Bash", kind: "tool_use", args: { command: "ls -la" } },
    ]);
    expect(results).toEqual([
      { toolCallId: "toolu_1", name: "Bash", isError: false, result: "total 0\n" },
    ]);
  });

  it.each(["server_tool_use", "mcp_tool_use"])("recognizes %s blocks", (type) => {
    const starts: CliToolUseStartDelta[] = [];
    const parser = createClaudeParser({
      backend: createClaudeBackend(),
      onToolUseStart: (delta) => starts.push(delta),
    });

    parser.push(
      joinJsonlFrames(
        claudeBlockStart({ type, id: "toolu_hosted", name: "web_search", input: {} }, 0),
        claudeInputJsonDelta('{"query":"openclaw"}', 0),
        claudeBlockStop(0),
        "",
      ),
    );
    parser.finish();

    expect(starts).toEqual([
      {
        toolCallId: "toolu_hosted",
        name: "web_search",
        kind: type,
        args: { query: "openclaw" },
      },
    ]);
  });

  it.each([
    {
      useType: "server_tool_use",
      resultType: "web_search_tool_result",
      toolCallId: "srvtoolu_1",
      name: "web_search",
      input: { query: "openclaw" },
      result: [{ type: "web_search_result", title: "OpenClaw", url: "https://example.com" }],
      isError: false,
    },
    {
      useType: "mcp_tool_use",
      resultType: "mcp_tool_result",
      toolCallId: "mcptoolu_1",
      name: "echo",
      input: { value: "hello" },
      result: [{ type: "text", text: "hello" }],
      isError: false,
    },
  ])("emits hosted result events for $useType", (fixture) => {
    const { starts, results, parser } = createToolEventParser();

    parser.push(
      joinJsonlFrames({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: fixture.useType,
              id: fixture.toolCallId,
              name: fixture.name,
              input: fixture.input,
            },
            {
              type: fixture.resultType,
              tool_use_id: fixture.toolCallId,
              content: fixture.result,
              is_error: fixture.isError,
            },
          ],
        },
      }) + "\n",
    );
    parser.finish();

    expect(starts).toEqual([
      {
        toolCallId: fixture.toolCallId,
        name: fixture.name,
        kind: fixture.useType,
        args: fixture.input,
      },
    ]);
    expect(results).toEqual([
      {
        toolCallId: fixture.toolCallId,
        name: fixture.name,
        isError: fixture.isError,
        result: fixture.result,
      },
    ]);
  });

  it("emits streamed server tool result blocks", () => {
    const results: CliToolResultDelta[] = [];
    const parser = createClaudeParser({
      backend: { ...localCliBackend },
      onToolUseStart: () => undefined,
      onToolResult: (delta) => results.push(delta),
    });

    finishCliFrames(
      parser,
      claudeBlockStart({ type: "server_tool_use", id: "srvtoolu_stream", name: "web_search" }, 0),
      claudeBlockStop(0),
      claudeBlockStart(
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_stream",
          content: { type: "web_search_tool_result_error", error_code: "unavailable" },
        },
        1,
      ),
      "",
    );

    expect(results).toEqual([
      {
        toolCallId: "srvtoolu_stream",
        name: "web_search",
        isError: true,
        result: { type: "web_search_tool_result_error", error_code: "unavailable" },
      },
    ]);
  });

  it.each([
    {
      name: "fires onCommentaryText with accumulated text before a tool_use block",
      frames: [
        { type: "init", session_id: "session-commentary" },
        claudeTextDelta("Let me check "),
        claudeTextDelta("that for you."),
        claudeBlockStart({ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }, 1),
      ],
      expectedCommentary: ["Let me check that for you."],
      expectedDeltas: [],
    },
    {
      name: "flushes Claude text as an assistant delta when no tool follows",
      frames: [
        { type: "init", session_id: "session-answer" },
        claudeTextDelta("Final "),
        claudeTextDelta("answer."),
        claudeMessageStop(),
      ],
      expectedCommentary: [],
      expectedDeltas: [{ text: "Final answer.", delta: "Final answer." }],
    },
  ])("$name", ({ frames, expectedCommentary, expectedDeltas }) => {
    const commentaryTexts: string[] = [];
    const deltas: Array<{ text: string; delta: string }> = [];
    const parser = createClaudeParser({
      backend: { ...localCliBackend, command: "claude" },
      onAssistantDelta: (delta) => deltas.push({ text: delta.text, delta: delta.delta }),
      onCommentaryText: (text) => commentaryTexts.push(text),
    });

    finishCliFrames(parser, ...frames, "");

    expect(commentaryTexts).toEqual(expectedCommentary);
    expect(deltas).toEqual(expectedDeltas);
  });
});
