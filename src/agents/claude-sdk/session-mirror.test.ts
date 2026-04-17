import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { projectSdkMessage, resolveSessionMirrorPath } from "./session-mirror.js";

function asSdkMessage(obj: unknown): SDKMessage {
  return obj as SDKMessage;
}

describe("projectSdkMessage", () => {
  it("projects an assistant text message into a canonical message envelope", () => {
    const result = projectSdkMessage(
      asSdkMessage({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "hello world" }],
        },
      }),
      { model: "claude-sonnet-4-5" },
    );
    expect(result).toHaveLength(1);
    const record = result[0];
    if (!record) {
      throw new Error("expected at least one record");
    }
    expect(record.type).toBe("message");
    expect(record.claudeSdk).toBe(true);
    expect(record.message.role).toBe("assistant");
    expect(record.message).toMatchObject({
      role: "assistant",
      api: "claude-sdk",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    if (record.message.role === "assistant") {
      expect(record.message.content).toEqual([{ type: "text", text: "hello world" }]);
    }
  });

  it("includes tool_use blocks alongside text in the assistant content array", () => {
    const result = projectSdkMessage(
      asSdkMessage({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "running bash" },
            { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
    );
    expect(result).toHaveLength(1);
    const record = result[0];
    if (!record) {
      throw new Error("expected at least one record");
    }
    expect(record.message.role).toBe("assistant");
    if (record.message.role === "assistant") {
      expect(record.message.content).toEqual([
        { type: "text", text: "running bash" },
        { type: "toolCall", id: "tu_1", name: "Bash", input: { command: "ls" } },
      ]);
    }
  });

  it("projects a user tool_result block as a canonical tool-role message", () => {
    const result = projectSdkMessage(
      asSdkMessage({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: "total 0\n",
              is_error: false,
            },
          ],
        },
      }),
    );
    expect(result).toHaveLength(1);
    const record = result[0];
    if (!record) {
      throw new Error("expected at least one record");
    }
    expect(record.message.role).toBe("tool");
    if (record.message.role === "tool") {
      expect(record.message.content).toEqual([
        {
          type: "toolResult",
          toolCallId: "tu_1",
          output: "total 0\n",
          isError: false,
        },
      ]);
    }
  });

  it("projects a user text message into a canonical user-role message", () => {
    const result = projectSdkMessage(
      asSdkMessage({
        type: "user",
        message: { content: [{ type: "text", text: "hi there" }] },
      }),
    );
    expect(result).toHaveLength(1);
    const record = result[0];
    if (!record) {
      throw new Error("expected at least one record");
    }
    expect(record.message.role).toBe("user");
    if (record.message.role === "user") {
      expect(record.message.content).toEqual([{ type: "text", text: "hi there" }]);
    }
  });

  it("drops result messages and unknown message types — sidecar emits stop markers separately", () => {
    expect(
      projectSdkMessage(asSdkMessage({ type: "result", stop_reason: "end_turn" })),
    ).toEqual([]);
    expect(projectSdkMessage(asSdkMessage({ type: "system_unknown_variant" }))).toEqual([]);
  });

  it("concatenates multiple text blocks with newlines into one canonical text content entry", () => {
    const result = projectSdkMessage(
      asSdkMessage({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      }),
    );
    expect(result).toHaveLength(1);
    const record = result[0];
    if (!record) {
      throw new Error("expected at least one record");
    }
    if (record.message.role === "assistant") {
      expect(record.message.content).toEqual([{ type: "text", text: "first\nsecond" }]);
    }
  });

  it("falls back to an empty model id when no model context is provided", () => {
    const result = projectSdkMessage(
      asSdkMessage({
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }] },
      }),
    );
    expect(result).toHaveLength(1);
    const record = result[0];
    if (!record) {
      throw new Error("expected at least one record");
    }
    if (record.message.role === "assistant") {
      expect(record.message.model).toBe("");
    }
  });
});

describe("resolveSessionMirrorPath", () => {
  it("appends the .claude-sdk.jsonl suffix to the primary path", () => {
    expect(resolveSessionMirrorPath("/foo/bar/session-123.jsonl")).toBe(
      "/foo/bar/session-123.jsonl.claude-sdk.jsonl",
    );
  });
});
