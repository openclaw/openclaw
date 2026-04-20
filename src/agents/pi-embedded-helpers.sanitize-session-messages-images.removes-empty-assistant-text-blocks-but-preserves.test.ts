import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  sanitizeGoogleTurnOrdering,
  sanitizeSessionMessagesImages,
} from "./pi-embedded-helpers.js";
import {
  castAgentMessages,
  makeAgentAssistantMessage,
} from "./test-helpers/agent-message-fixtures.js";

let testTimestamp = 1;
const nextTimestamp = () => testTimestamp++;

function createIsoBmffImage(
  majorBrand: string,
  compatibleBrands: string[] = [],
  minorVersion = "\0\0\0\0",
): Buffer {
  const brands = [majorBrand, minorVersion, ...compatibleBrands];
  const payload = Buffer.concat(brands.map((brand) => Buffer.from(brand, "ascii")));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length + 8, 0);
  return Buffer.concat([size, Buffer.from("ftyp", "ascii"), payload]);
}

function makeToolCallResultPairInput(): Array<AssistantMessage | ToolResultMessage> {
  return [
    makeAgentAssistantMessage({
      content: [
        {
          type: "toolCall",
          id: "call_123|fc_456",
          name: "read",
          arguments: { path: "package.json" },
        },
      ],
      model: "gpt-5.4",
      stopReason: "toolUse",
      timestamp: nextTimestamp(),
    }),
    {
      role: "toolResult",
      toolCallId: "call_123|fc_456",
      toolName: "read",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: nextTimestamp(),
    },
  ];
}

function makeEmptyAssistantErrorMessage(): AssistantMessage {
  return makeAgentAssistantMessage({
    stopReason: "error",
    content: [],
    model: "gpt-5.4",
    timestamp: nextTimestamp(),
  }) satisfies AssistantMessage;
}

function makeOpenAiResponsesAssistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
  return makeAgentAssistantMessage({
    content,
    model: "gpt-5.4",
    stopReason,
    timestamp: nextTimestamp(),
  });
}

function expectToolCallAndResultIds(out: AgentMessage[], expectedId: string) {
  const assistant = out[0];
  expect(assistant.role).toBe("assistant");
  const assistantContent = assistant.role === "assistant" ? assistant.content : [];
  const toolCall = assistantContent.find((block) => block.type === "toolCall");
  expect(toolCall?.id).toBe(expectedId);

  const toolResult = out[1];
  expect(toolResult.role).toBe("toolResult");
  if (toolResult.role === "toolResult") {
    expect(toolResult.toolCallId).toBe(expectedId);
  }
}

function expectSingleAssistantContentEntry(
  out: AgentMessage[],
  expectEntry: (entry: { type?: string; text?: string }) => void,
) {
  expect(out).toHaveLength(1);
  expect(out[0]?.role).toBe("assistant");
  const content = out[0]?.role === "assistant" ? out[0].content : [];
  expect(content).toHaveLength(1);
  expectEntry((content as Array<{ type?: string; text?: string }>)[0] ?? {});
}

describe("sanitizeSessionMessagesImages", () => {
  it("keeps tool call + tool result IDs unchanged by default", async () => {
    const input = makeToolCallResultPairInput();

    const out = await sanitizeSessionMessagesImages(input, "test");

    expectToolCallAndResultIds(out, "call_123|fc_456");
  });

  it("sanitizes tool call + tool result IDs in strict mode (alphanumeric only)", async () => {
    const input = makeToolCallResultPairInput();

    const out = await sanitizeSessionMessagesImages(input, "test", {
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
    });

    // Strict mode strips all non-alphanumeric characters
    expectToolCallAndResultIds(out, "call123fc456");
  });

  it("does not synthesize tool call input when missing", async () => {
    const input = castAgentMessages([
      makeOpenAiResponsesAssistantMessage([
        { type: "toolCall", id: "call_1", name: "read", arguments: {} },
      ]),
    ]);

    const out = await sanitizeSessionMessagesImages(input, "test");
    const assistant = out[0] as { content?: Array<Record<string, unknown>> };
    const toolCall = assistant.content?.find((b) => b.type === "toolCall");
    expect(toolCall).toBeTruthy();
    expect("input" in (toolCall ?? {})).toBe(false);
  });

  it("removes empty assistant text blocks but preserves tool calls", async () => {
    const input = castAgentMessages([
      makeOpenAiResponsesAssistantMessage([
        { type: "text", text: "" },
        { type: "toolCall", id: "call_1", name: "read", arguments: {} },
      ]),
    ]);

    const out = await sanitizeSessionMessagesImages(input, "test");

    expectSingleAssistantContentEntry(out, (entry) => {
      expect(entry.type).toBe("toolCall");
    });
  });

  it("sanitizes tool ids in strict mode (alphanumeric only)", async () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "call_abc|item:123", name: "test", input: {} },
          {
            type: "toolCall",
            id: "call_abc|item:456",
            name: "exec",
            arguments: {},
          },
        ],
      },
      {
        role: "toolResult",
        toolUseId: "call_abc|item:123",
        content: [{ type: "text", text: "ok" }],
      },
    ]);

    const out = await sanitizeSessionMessagesImages(input, "test", {
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
    });

    // Strict mode strips all non-alphanumeric characters
    const assistant = out[0] as { content?: Array<{ id?: string }> };
    expect(assistant.content?.[0]?.id).toBe("callabcitem123");
    expect(assistant.content?.[1]?.id).toBe("callabcitem456");

    const toolResult = out[1] as { toolUseId?: string };
    expect(toolResult.toolUseId).toBe("callabcitem123");
  });

  it("sanitizes tool IDs in images-only mode when explicitly enabled", async () => {
    const input = makeToolCallResultPairInput();

    const out = await sanitizeSessionMessagesImages(input, "test", {
      sanitizeMode: "images-only",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
    });

    const assistant = out[0];
    const toolCall =
      assistant?.role === "assistant"
        ? assistant.content.find((b) => b.type === "toolCall")
        : undefined;
    expect(toolCall?.id).toBe("call123fc456");

    const toolResult = out[1];
    expect(toolResult?.role).toBe("toolResult");
    if (toolResult?.role === "toolResult") {
      expect(toolResult.toolCallId).toBe("call123fc456");
    }
  });
  it("filters whitespace-only assistant text blocks", async () => {
    const input = castAgentMessages([
      makeOpenAiResponsesAssistantMessage(
        [
          { type: "text", text: "   " },
          { type: "text", text: "ok" },
        ],
        "stop",
      ),
    ]);

    const out = await sanitizeSessionMessagesImages(input, "test");

    expectSingleAssistantContentEntry(out, (entry) => {
      expect(entry.text).toBe("ok");
    });
  });
  it("drops assistant messages that only contain empty text", async () => {
    const input = castAgentMessages([
      { role: "user", content: "hello", timestamp: nextTimestamp() } satisfies UserMessage,
      makeOpenAiResponsesAssistantMessage([{ type: "text", text: "" }], "stop"),
    ]);

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("user");
  });
  it("keeps empty assistant error messages", async () => {
    const input = castAgentMessages([
      { role: "user", content: "hello", timestamp: nextTimestamp() } satisfies UserMessage,
      {
        ...makeEmptyAssistantErrorMessage(),
      },
      {
        ...makeEmptyAssistantErrorMessage(),
      },
    ]);

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(3);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("assistant");
    expect(out[2]?.role).toBe("assistant");
  });
  it("leaves non-assistant messages unchanged", async () => {
    const input = [
      { role: "user", content: "hello", timestamp: nextTimestamp() } satisfies UserMessage,
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "result" }],
        timestamp: nextTimestamp(),
      } satisfies ToolResultMessage,
    ];

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("toolResult");
  });

  it("rejects HEIF-family images inside toolResult transcript messages", async () => {
    const heif = createIsoBmffImage("avif", ["mif1"]);
    const input = castAgentMessages([
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "mcp_image",
        isError: false,
        content: [{ type: "image", data: heif.toString("base64"), mimeType: "image/jpeg" }],
        timestamp: nextTimestamp(),
      } satisfies ToolResultMessage,
    ]);

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("toolResult");
    if (out[0]?.role === "toolResult") {
      expect(out[0].content).toEqual([
        {
          type: "text",
          text: "[test] omitted image payload: Error: unsupported image format",
        },
      ]);
    }
  });

  it("preserves legacy read-tool HEIF content during transcript replay when metadata is missing", async () => {
    const heif = createIsoBmffImage("heic", ["mif1"]);
    const input = castAgentMessages([
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        isError: false,
        content: [{ type: "image", data: heif.toString("base64"), mimeType: "image/heic" }],
        timestamp: nextTimestamp(),
      } satisfies ToolResultMessage,
    ]);

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("toolResult");
    if (out[0]?.role === "toolResult") {
      expect(out[0].content).not.toEqual([
        {
          type: "text",
          text: "[test] omitted image payload: Error: unsupported image format",
        },
      ]);
    }
  });

  it("does not let stored sanitization metadata wipe configured replay limits", async () => {
    const maxBytes = 64 * 1024;
    const width = 900;
    const height = 900;
    const raw = Buffer.alloc(width * height * 3, 0xff);
    const bigPng = await sharp(raw, {
      raw: { width, height, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(bigPng.byteLength).toBeGreaterThan(maxBytes);

    const input = castAgentMessages([
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        isError: false,
        content: [{ type: "image", data: bigPng.toString("base64"), mimeType: "image/png" }],
        details: {
          imageSanitization: {
            rejectHeifFamily: false,
          },
        },
        timestamp: nextTimestamp(),
      } satisfies ToolResultMessage,
    ]);

    const out = await sanitizeSessionMessagesImages(input, "test", { maxBytes });

    expect(out).toHaveLength(1);
    const tool = out[0];
    expect(tool?.role).toBe("toolResult");
    if (tool?.role !== "toolResult") {
      return;
    }
    const image = tool.content?.find((block) => (block as { type?: string }).type === "image") as
      | { type: "image"; data: string; mimeType?: string }
      | undefined;
    expect(image).toBeDefined();
    expect(Buffer.from(image?.data ?? "", "base64").byteLength).toBeLessThanOrEqual(maxBytes);
  }, 20_000);

  it("preserves read-tool HEIF opt-outs during transcript replay sanitization", async () => {
    const heif = createIsoBmffImage("heic", ["mif1"]);
    const input = castAgentMessages([
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        isError: false,
        content: [{ type: "image", data: heif.toString("base64"), mimeType: "image/heic" }],
        details: {
          imageSanitization: {
            rejectHeifFamily: false,
          },
        },
        timestamp: nextTimestamp(),
      } satisfies ToolResultMessage,
    ]);

    const out = await sanitizeSessionMessagesImages(input, "test");

    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("toolResult");
    if (out[0]?.role === "toolResult") {
      expect(out[0].content).not.toEqual([
        {
          type: "text",
          text: "[test] omitted image payload: Error: unsupported image format",
        },
      ]);
      expect(out[0].details).toMatchObject({
        imageSanitization: {
          rejectHeifFamily: false,
        },
      });
    }
  });

  describe("thought_signature stripping", () => {
    it("strips msg_-prefixed thought_signature from assistant message content blocks", async () => {
      const input = castAgentMessages([
        {
          role: "assistant",
          content: [
            { type: "text", text: "hello", thought_signature: "msg_abc123" },
            {
              type: "thinking",
              thinking: "reasoning",
              thought_signature: "AQID",
            },
          ],
        },
      ]);

      const out = await sanitizeSessionMessagesImages(input, "test");

      expect(out).toHaveLength(1);
      const content = (out[0] as { content?: unknown[] }).content;
      expect(content).toHaveLength(2);
      expect("thought_signature" in ((content?.[0] ?? {}) as object)).toBe(false);
      expect((content?.[1] as { thought_signature?: unknown })?.thought_signature).toBe("AQID");
    });

    it("still strips signatures in images-only mode when replay policy requests it", async () => {
      const input = castAgentMessages([
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal", thought_signature: "msg_abc123" },
            { type: "text", text: "visible" },
          ],
        },
      ]);

      const out = await sanitizeSessionMessagesImages(input, "test", {
        sanitizeMode: "images-only",
        sanitizeThoughtSignatures: {
          allowBase64Only: true,
          includeCamelCase: true,
        },
      });

      const content = (out[0] as { content?: Array<{ thought_signature?: unknown }> }).content;
      expect(content).toHaveLength(2);
      expect(content?.[0]?.thought_signature).toBeUndefined();
    });

    it("preserves interleaved thinking block order when signatures are preserved", async () => {
      const input = castAgentMessages([
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "first",
              thought_signature: "sig-1",
            },
            { type: "text", text: "" },
            { type: "text", text: "visible" },
            {
              type: "redacted_thinking",
              data: "opaque",
              thought_signature: "sig-2",
            },
            { type: "text", text: "tail" },
          ],
        },
      ]);

      const out = await sanitizeSessionMessagesImages(input, "test", {
        preserveSignatures: true,
      });

      expect(out).toHaveLength(1);
      const content = (out[0] as { content?: Array<{ type?: string; text?: string }> }).content;
      expect(content?.map((block) => block.type)).toEqual([
        "thinking",
        "text",
        "text",
        "redacted_thinking",
        "text",
      ]);
      expect(content?.[0]).toMatchObject({
        type: "thinking",
        thinking: "first",
        thought_signature: "sig-1",
      });
      expect(content?.[1]).toMatchObject({ type: "text", text: "" });
      expect(content?.[3]).toMatchObject({
        type: "redacted_thinking",
        thought_signature: "sig-2",
      });
    });
  });
});

describe("sanitizeGoogleTurnOrdering", () => {
  it("prepends a synthetic user turn when history starts with assistant", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      },
    ]);

    const out = sanitizeGoogleTurnOrdering(input);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("assistant");
  });
  it("is a no-op when history starts with user", () => {
    const input = castAgentMessages([{ role: "user", content: "hi" }]);
    const out = sanitizeGoogleTurnOrdering(input);
    expect(out).toBe(input);
  });
});
