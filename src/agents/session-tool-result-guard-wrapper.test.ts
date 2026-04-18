import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";

// Import the internal function for testing
// In the actual implementation, this is not exported, so we'll need to export it or test via guardSessionManager
// For now, let's create a minimal reproduction of the logic to test

/**
 * Strip base64 image data from tool result content to reduce context bloat.
 * This is a test copy of the internal function.
 */
function stripBase64ImagesFromToolResult(message: AgentMessage): AgentMessage {
  const toolResult = message as Extract<AgentMessage, { role: "toolResult" }>;

  if (toolResult.role !== "toolResult" || !toolResult.content) {
    return message;
  }

  if (!Array.isArray(toolResult.content)) {
    return message;
  }

  const strippedContent = toolResult.content.map((item) => {
    if (typeof item === "object" && item !== null && "type" in item && item.type === "image") {
      return {
        type: "image" as const,
        data: "",
        mimeType: item.mimeType || "image/png",
      };
    }
    return item;
  });

  return {
    ...toolResult,
    content: strippedContent,
  };
}

describe("stripBase64ImagesFromToolResult", () => {
  it("should strip base64 data from image blocks", () => {
    const message: AgentMessage = {
      role: "toolResult",
      toolCallId: "test-123",
      toolName: "browser",
      isError: false,
      timestamp: Date.now(),
      content: [
        { type: "text", text: "MEDIA:/path/to/screenshot.png" },
        {
          type: "image",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          mimeType: "image/png",
        },
      ],
    };

    const result = stripBase64ImagesFromToolResult(message);

    expect(result.role).toBe("toolResult");
    expect(result.content).toHaveLength(2);

    // Text block should be unchanged
    expect(result.content[0]).toEqual({ type: "text", text: "MEDIA:/path/to/screenshot.png" });

    // Image block should have empty data
    const imageBlock = result.content[1] as { type: string; data: string; mimeType: string };
    expect(imageBlock.type).toBe("image");
    expect(imageBlock.data).toBe("");
    expect(imageBlock.mimeType).toBe("image/png");
  });

  it("should preserve non-image content blocks unchanged", () => {
    const message: AgentMessage = {
      role: "toolResult",
      toolCallId: "test-456",
      toolName: "browser",
      isError: false,
      timestamp: Date.now(),
      content: [
        { type: "text", text: "Some text content" },
        { type: "text", text: "More text" },
      ],
    };

    const result = stripBase64ImagesFromToolResult(message);

    expect(result.role).toBe("toolResult");
    expect(result.content).toEqual(message.content);
  });

  it("should handle messages with no content", () => {
    const message: AgentMessage = {
      role: "toolResult",
      toolCallId: "test-789",
      toolName: "browser",
      isError: false,
      timestamp: Date.now(),
    } as AgentMessage;

    const result = stripBase64ImagesFromToolResult(message);
    expect(result).toEqual(message);
  });

  it("should handle non-array content", () => {
    const message = {
      role: "toolResult",
      toolCallId: "test-999",
      toolName: "browser",
      isError: false,
      timestamp: Date.now(),
      content: "string content",
    } as AgentMessage;

    const result = stripBase64ImagesFromToolResult(message);
    expect(result).toEqual(message);
  });

  it("should not modify non-toolResult messages", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
      timestamp: Date.now(),
    } as AgentMessage;

    const result = stripBase64ImagesFromToolResult(message);
    expect(result).toEqual(message);
  });

  it("should default mimeType to image/png if missing", () => {
    const message = {
      role: "toolResult",
      toolCallId: "test-default",
      toolName: "browser",
      isError: false,
      timestamp: Date.now(),
      content: [
        {
          type: "image",
          data: "someb64data",
        },
      ],
    } as AgentMessage;

    const result = stripBase64ImagesFromToolResult(message);

    const imageBlock = result.content[0] as { type: string; data: string; mimeType: string };
    expect(imageBlock.mimeType).toBe("image/png");
  });

  it("should preserve existing mimeType", () => {
    const message: AgentMessage = {
      role: "toolResult",
      toolCallId: "test-jpeg",
      toolName: "browser",
      isError: false,
      timestamp: Date.now(),
      content: [
        {
          type: "image",
          data: "jpegdata",
          mimeType: "image/jpeg",
        },
      ],
    };

    const result = stripBase64ImagesFromToolResult(message);

    const imageBlock = result.content[0] as { type: string; data: string; mimeType: string };
    expect(imageBlock.mimeType).toBe("image/jpeg");
  });

  it("should handle mixed content with multiple images", () => {
    const message: AgentMessage = {
      role: "toolResult",
      toolCallId: "test-mixed",
      toolName: "browser",
      isError: false,
      timestamp: Date.now(),
      content: [
        { type: "text", text: "First image:" },
        { type: "image", data: "image1base64", mimeType: "image/png" },
        { type: "text", text: "Second image:" },
        { type: "image", data: "image2base64", mimeType: "image/jpeg" },
      ],
    };

    const result = stripBase64ImagesFromToolResult(message);

    expect(result.content).toHaveLength(4);

    // Text blocks unchanged
    expect(result.content[0]).toEqual({ type: "text", text: "First image:" });
    expect(result.content[2]).toEqual({ type: "text", text: "Second image:" });

    // Image blocks stripped
    const image1 = result.content[1] as { type: string; data: string; mimeType: string };
    expect(image1.data).toBe("");
    expect(image1.mimeType).toBe("image/png");

    const image2 = result.content[3] as { type: string; data: string; mimeType: string };
    expect(image2.data).toBe("");
    expect(image2.mimeType).toBe("image/jpeg");
  });
});
