import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { stripImageBlocksFromMessages } from "./pi-embedded-helpers/images.js";

describe("stripImageBlocksFromMessages", () => {
  it("strips image blocks from toolResult content", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "tc1",
        content: [
          { type: "text", text: "MEDIA:/tmp/screenshot.jpg" },
          { type: "image", data: "base64data", mimeType: "image/jpeg" },
        ],
      } as unknown as AgentMessage,
    ];
    const { messages: result, hadImages } = stripImageBlocksFromMessages(messages);
    expect(hadImages).toBe(true);
    const content = (result[0] as unknown as { content: { type: string; text?: string }[] })
      .content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "MEDIA:/tmp/screenshot.jpg" });
    expect(content[1]).toEqual({ type: "text", text: "[image omitted]" });
  });

  it("strips image blocks from user content", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this" },
          { type: "image", data: "abc", mimeType: "image/png" },
        ],
      } as unknown as AgentMessage,
    ];
    const { messages: result, hadImages } = stripImageBlocksFromMessages(messages);
    expect(hadImages).toBe(true);
    const content = (result[0] as unknown as { content: { type: string; text?: string }[] })
      .content;
    expect(content[1]).toEqual({ type: "text", text: "[image omitted]" });
  });

  it("strips image blocks from assistant content", () => {
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Here is the result" },
          { type: "image", data: "xyz", mimeType: "image/png" },
        ],
      } as unknown as AgentMessage,
    ];
    const { messages: result, hadImages } = stripImageBlocksFromMessages(messages);
    expect(hadImages).toBe(true);
    const content = (result[0] as unknown as { content: { type: string; text?: string }[] })
      .content;
    expect(content[1]).toEqual({ type: "text", text: "[image omitted]" });
  });

  it("returns hadImages=false when no image blocks present", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "Hello" } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      } as unknown as AgentMessage,
    ];
    const { messages: result, hadImages } = stripImageBlocksFromMessages(messages);
    expect(hadImages).toBe(false);
    expect(result).toHaveLength(2);
  });

  it("preserves non-image blocks unchanged", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "tc1",
        content: [
          { type: "text", text: "result text" },
          { type: "toolCall", id: "x", name: "foo", arguments: "{}" },
        ],
      } as unknown as AgentMessage,
    ];
    const { messages: result, hadImages } = stripImageBlocksFromMessages(messages);
    expect(hadImages).toBe(false);
    const content = (result[0] as unknown as { content: { type: string }[] }).content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "result text" });
    expect(content[1]).toEqual({ type: "toolCall", id: "x", name: "foo", arguments: "{}" });
  });

  it("recursively strips nested image blocks", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "tc1",
        content: [
          {
            type: "nested",
            content: [
              { type: "text", text: "inner text" },
              { type: "image", data: "nested-img", mimeType: "image/png" },
            ],
          },
        ],
      } as unknown as AgentMessage,
    ];
    const { messages: result, hadImages } = stripImageBlocksFromMessages(messages);
    expect(hadImages).toBe(true);
    const outer = (result[0] as unknown as { content: { type: string; content?: unknown[] }[] })
      .content;
    const inner = outer[0]?.content as { type: string; text?: string }[];
    expect(inner[0]).toEqual({ type: "text", text: "inner text" });
    expect(inner[1]).toEqual({ type: "text", text: "[image omitted]" });
  });

  it("handles empty messages array", () => {
    const { messages: result, hadImages } = stripImageBlocksFromMessages([]);
    expect(hadImages).toBe(false);
    expect(result).toHaveLength(0);
  });

  it("handles string content without mutation", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "plain text" } as AgentMessage];
    const { messages: result, hadImages } = stripImageBlocksFromMessages(messages);
    expect(hadImages).toBe(false);
    expect(result[0]?.content).toBe("plain text");
  });
});
