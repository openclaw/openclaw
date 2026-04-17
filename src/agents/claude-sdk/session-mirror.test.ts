import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { projectSdkMessage } from "./session-mirror.js";

function asSdkMessage(obj: unknown): SDKMessage {
  return obj as SDKMessage;
}

describe("projectSdkMessage", () => {
  it("projects an assistant text message to an assistant pi-ai frame", () => {
    const result = projectSdkMessage(
      asSdkMessage({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "hello world" }],
        },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "assistant",
      text: "hello world",
      source: "claude-sdk",
    });
  });

  it("projects a tool_use block as a synthetic assistant frame with toolCall", () => {
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
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: "assistant", text: "running bash" });
    expect(result[1]).toMatchObject({
      type: "assistant",
      toolCall: { id: "tu_1", name: "Bash", input: { command: "ls" } },
    });
  });

  it("projects a user tool_result block as a synthetic assistant frame with toolResult", () => {
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
    expect(result[0]).toMatchObject({
      type: "assistant",
      toolResult: { id: "tu_1", output: "total 0\n", isError: false },
    });
  });

  it("projects a result message to a stop frame with the SDK's stop_reason", () => {
    const result = projectSdkMessage(asSdkMessage({ type: "result", stop_reason: "end_turn" }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "stop", reason: "end_turn" });
  });

  it("drops unknown message types silently (SDK primary still has them)", () => {
    const result = projectSdkMessage(asSdkMessage({ type: "system_unknown_variant" }));
    expect(result).toEqual([]);
  });

  it("concatenates multiple text blocks with newlines", () => {
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
    expect(result[0]).toMatchObject({ text: "first\nsecond" });
  });
});
