import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { CodexHistoryRejection } from "./history-rejection.js";
import { projectSettledCodexMessages } from "./settled-turn-projection.js";
import { attachUpstreamUserText } from "./upstream-prompt-provenance.js";

function message(value: unknown): AgentMessage {
  return value as AgentMessage;
}

function toolCall(id = "call-1"): AgentMessage {
  return message({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "toolCall", id, name: "message", arguments: { action: "send" } },
    ],
  });
}

function toolResult(
  id = "call-1",
  content: unknown = [{ type: "text", text: "Message sent." }],
  overrides: Record<string, unknown> = {},
): AgentMessage {
  return message({
    role: "toolResult",
    toolCallId: id,
    toolName: "message",
    content,
    ...overrides,
  });
}

function projectResult(content: unknown, overrides: Record<string, unknown> = {}) {
  return projectSettledCodexMessages([toolCall(), toolResult("call-1", content, overrides)]).at(-1);
}

function projectWithUser(user: AgentMessage) {
  return projectSettledCodexMessages([user, toolCall(), toolResult()]);
}

function output(text: string) {
  return { type: "function_call_output", call_id: "call-1", output: text };
}

describe("projectSettledCodexMessages", () => {
  it("projects a canonical completed tool exchange without exposing reasoning", () => {
    expect(
      projectSettledCodexMessages([
        message({ role: "user", content: "Send the update." }),
        message({
          role: "assistant",
          content: [{ type: "text", text: "I’ll send it now." }],
        }),
        toolCall(),
        toolResult(),
      ]),
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Send the update." }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I’ll send it now." }],
      },
      {
        type: "function_call",
        call_id: "call-1",
        name: "message",
        arguments: '{"action":"send"}',
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "Message sent.",
      },
    ]);
  });

  it("accepts Codex's enriched mirrored tool-result block", () => {
    expect(
      projectSettledCodexMessages([
        toolCall(),
        toolResult("call-1", [
          { type: "toolResult", toolCallId: "call-1", content: "Telegram delivery complete." },
        ]),
      ]),
    ).toEqual([
      expect.objectContaining({ type: "function_call", call_id: "call-1" }),
      output("Telegram delivery complete."),
    ]);
  });

  it("projects dotted namespaced tool names recorded from Codex MCP calls", () => {
    const name = "codex_apps.slack.slack_send";
    expect(
      projectSettledCodexMessages([
        message({
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name, arguments: { channel: "C1" } }],
        }),
        message({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: name,
          content: [{ type: "text", text: "Sent." }],
        }),
      ]),
    ).toEqual([
      { type: "function_call", call_id: "call-1", name, arguments: '{"channel":"C1"}' },
      { type: "function_call_output", call_id: "call-1", output: "Sent." },
    ]);
  });

  it("rejects invalid tool names without including transcript text", () => {
    expect(() =>
      projectSettledCodexMessages([
        message({
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "bad tool", arguments: {} }],
        }),
        toolResult("call-1", [{ type: "text", text: "failed" }], { toolName: "bad tool" }),
      ]),
    ).toThrowError(new CodexHistoryRejection("invalid_content"));
  });

  it("preserves an empty failed tool result as failure evidence", () => {
    expect(projectResult([], { isError: true })).toEqual(
      output("[Tool result status: error]\nTool failed without textual output."),
    );
  });

  it("does not charge the synthetic failure marker against the source text limit", () => {
    const resultText = "x".repeat(64 * 1024);
    expect(projectResult([{ type: "text", text: resultText }], { isError: true })).toEqual(
      output(`[Tool result status: error]\n${resultText}`),
    );
  });

  it("preserves exact whitespace in projected transcript text", () => {
    expect(
      projectSettledCodexMessages([
        message({ role: "user", content: "  user input\n" }),
        message({ role: "assistant", content: [{ type: "text", text: "\tassistant output\n" }] }),
        toolCall(),
        toolResult("call-1", [{ type: "text", text: "  tool output\n" }]),
      ]),
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "  user input\n" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "\tassistant output\n" }],
      },
      expect.objectContaining({ type: "function_call", call_id: "call-1" }),
      output("  tool output\n"),
    ]);
  });

  it.each([
    { count: 205, text: "old", error: "item_limit" },
    { count: 9, text: "x".repeat(60 * 1024), error: "byte_limit" },
  ])("stops acquiring later payloads after $error", ({ count, text, error }) => {
    let laterReads = 0;
    const later = message({
      role: "user",
      get content() {
        laterReads += 1;
        return "must not acquire this later payload";
      },
    });
    const oldMessages = Array.from({ length: count }, () =>
      message({ role: "user", content: text }),
    );
    expect(() =>
      projectSettledCodexMessages([...oldMessages, later, toolCall(), toolResult()]),
    ).toThrow(error);
    expect(laterReads).toBe(0);
  });

  it("preserves upstream user text above the ordinary message limit", () => {
    const upstreamUserText = "x".repeat(64 * 1024 + 1);

    expect(
      projectSettledCodexMessages([
        attachUpstreamUserText(
          message({ role: "user", content: "[Telegram metadata] decorated prompt" }),
          upstreamUserText,
        ),
        toolCall(),
        toolResult(),
      ])[0],
    ).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: upstreamUserText }],
    });
  });

  it("rejects upstream user text above the projection limit", () => {
    expect(() =>
      projectWithUser(
        attachUpstreamUserText(
          message({ role: "user", content: "[Telegram metadata] decorated prompt" }),
          "x".repeat(512 * 1024 + 1),
        ),
      ),
    ).toThrow("field_limit");
  });

  it("charges upstream user text against the aggregate byte limit", () => {
    expect(() =>
      projectSettledCodexMessages([
        attachUpstreamUserText(
          message({ role: "user", content: "decorated" }),
          "x".repeat(400 * 1024),
        ),
        message({ role: "user", content: "x".repeat(60 * 1024) }),
        message({ role: "user", content: "x".repeat(60 * 1024) }),
        toolCall(),
        toolResult(),
      ]),
    ).toThrow("byte_limit");
  });

  it("does not let provenance hide non-text user content", () => {
    expect(() =>
      projectWithUser(
        message({
          role: "user",
          content: [
            { type: "text", text: "Send the notice." },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
          __openclaw: { upstreamUserText: "Send the notice." },
        }),
      ),
    ).toThrow("unsupported_user_image");
  });

  it.each([
    { name: "orphan result", messages: [toolResult()] },
    { name: "missing result", messages: [toolCall()] },
    { name: "duplicate call id", messages: [toolCall(), toolCall(), toolResult()] },
    {
      name: "tool-name mismatch",
      messages: [
        toolCall(),
        toolResult("call-1", [{ type: "text", text: "done" }], { toolName: "different" }),
      ],
    },
  ])("fails closed for $name", ({ messages }) => {
    expect(() => projectSettledCodexMessages(messages)).toThrowError(CodexHistoryRejection);
  });

  it.each([
    {
      name: "unknown role",
      value: { role: "future-role", content: "unknown" },
    },
    {
      name: "custom image evidence",
      value: {
        role: "custom",
        customType: "plugin.note",
        display: false,
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        __openclaw: { upstreamUserText: "Cannot replace image evidence." },
      },
      reason: "unsupported_user_image",
    },
    {
      name: "unknown custom block",
      value: {
        role: "custom",
        customType: "plugin.note",
        display: false,
        content: [{ type: "future-block" }],
      },
    },
  ])("rejects $name instead of dropping it during context conversion", ({ value }) => {
    expect(() => projectWithUser(message(value))).toThrow(
      expect.objectContaining({ reason: "unsupported_content" }),
    );
  });

  it("preserves valid image tool results as bounded non-vision evidence", () => {
    expect(
      projectResult([
        { type: "text", text: "Generated the requested asset." },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ]),
    ).toEqual(output("Generated the requested asset.\n[Image tool result: image/png]"));
  });

  it("rejects oversized text instead of truncating it", () => {
    expect(() =>
      projectWithUser(message({ role: "user", content: "x".repeat(64 * 1024 + 1) })),
    ).toThrow("field_limit");
  });
});
