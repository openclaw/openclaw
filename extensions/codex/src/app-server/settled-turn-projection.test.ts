import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { projectSettledCodexMessages } from "./settled-turn-projection.js";

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
): AgentMessage {
  return message({
    role: "toolResult",
    toolCallId: id,
    toolName: "message",
    content,
  });
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
          {
            type: "toolResult",
            toolCallId: "call-1",
            content: "Telegram delivery complete.",
          },
        ]),
      ]),
    ).toEqual([
      expect.objectContaining({ type: "function_call", call_id: "call-1" }),
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "Telegram delivery complete.",
      },
    ]);
  });

  it("bounds history by dropping whole earlier groups while preserving the tool pair", () => {
    const oldMessages = Array.from({ length: 205 }, (_, index) =>
      message({ role: "user", content: `old-${index}` }),
    );
    const projected = projectSettledCodexMessages([...oldMessages, toolCall(), toolResult()]);

    expect(projected.length).toBeLessThanOrEqual(200);
    expect(projected.at(-2)).toMatchObject({ type: "function_call", call_id: "call-1" });
    expect(projected.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call-1" });
  });

  it.each([
    { name: "orphan result", messages: [toolResult()] },
    { name: "missing result", messages: [toolCall()] },
    { name: "duplicate call id", messages: [toolCall(), toolCall(), toolResult()] },
  ])("fails closed for $name", ({ messages }) => {
    expect(() => projectSettledCodexMessages(messages)).toThrow(/Codex settled-turn projection/u);
  });

  it("preserves valid image tool results as bounded non-vision evidence", () => {
    expect(
      projectSettledCodexMessages([
        toolCall(),
        toolResult("call-1", [
          { type: "text", text: "Generated the requested asset." },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ]),
      ]).at(-1),
    ).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "Generated the requested asset.\n[Image tool result: image/png]",
    });
  });
});
