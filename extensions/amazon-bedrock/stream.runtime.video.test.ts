// Amazon Bedrock tests cover documented Nova video input and Converse limits.
import { ConversationRole } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import "./stream.runtime.js";
import { streamTesting as testing } from "./test-support.js";

function bedrockVideoModel(overrides: Record<string, unknown> = {}) {
  return {
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    id: "amazon.nova-pro-v1:0",
    name: "Nova Pro",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text", "image", "video"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 300_000,
    maxTokens: 4096,
    ...overrides,
  };
}

function video(overrides: Record<string, unknown> = {}) {
  return { type: "video", mimeType: "video/mp4", data: "dmlkZW8=", ...overrides };
}

function userVideo(overrides: Record<string, unknown> = {}) {
  return {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Describe the video" }, video(overrides)],
      },
    ],
  };
}

describe("Bedrock native video input", () => {
  it.each([
    ["video/mp4", "mp4"],
    ["video/quicktime", "mov"],
    ["video/x-matroska", "mkv"],
    ["video/webm", "webm"],
    ["video/x-flv", "flv"],
    ["video/mpeg", "mpeg"],
    ["video/mpg", "mpg"],
    ["video/wmv", "wmv"],
    ["video/x-ms-wmv", "wmv"],
    ["video/3gpp", "three_gp"],
    ["VIDEO/MP4; codecs=avc1", "mp4"],
  ])("maps %s to the Converse %s video format", (mimeType, format) => {
    const messages = testing.convertMessages(userVideo({ mimeType }), bedrockVideoModel(), "none");

    expect(messages[0]).toMatchObject({
      role: ConversationRole.USER,
      content: [
        { text: "Describe the video" },
        { video: { format, source: { bytes: new Uint8Array([118, 105, 100, 101, 111]) } } },
      ],
    });
  });

  it("downgrades video to visible text on unsupported Nova Micro routes", () => {
    const messages = testing.convertMessages(
      userVideo(),
      bedrockVideoModel({ id: "amazon.nova-micro-v1:0", input: ["text"] }),
      "none",
    );

    expect(messages[0]).toMatchObject({
      role: ConversationRole.USER,
      content: [
        { text: "Describe the video" },
        { text: "(video omitted: model does not support videos)" },
      ],
    });
    expect(JSON.stringify(messages)).not.toContain('"video"');
  });

  it("rejects malformed video base64 and unsupported MIME types", () => {
    expect(() =>
      testing.convertMessages(userVideo({ data: "!!!not-base64!!!" }), bedrockVideoModel(), "none"),
    ).toThrow("Amazon Bedrock video content has malformed base64");
    expect(() =>
      testing.convertMessages(userVideo({ mimeType: "video/avi" }), bedrockVideoModel(), "none"),
    ).toThrow("Unsupported Amazon Bedrock video type: video/avi");
  });

  it("rejects inline videos that reach the encoded 25 MB request limit", () => {
    expect(() =>
      testing.convertMessages(
        userVideo({ data: "A".repeat(25 * 1024 * 1024) }),
        bedrockVideoModel(),
        "none",
      ),
    ).toThrow("Amazon Bedrock inline video must be smaller than 25 MB after base64 encoding.");
  });

  it("retains only the latest video when a later user turn replays an older video", () => {
    const context = {
      messages: [
        { role: "user", content: [{ type: "text", text: "First clip" }, video()] },
        {
          role: "assistant",
          content: [{ type: "text", text: "I saw the first clip." }],
          api: "bedrock-converse-stream",
          provider: "amazon-bedrock",
          model: "amazon.nova-pro-v1:0",
          stopReason: "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: 0,
        },
        { role: "user", content: [{ type: "text", text: "Latest clip" }, video()] },
      ],
    };

    const messages = testing.convertMessages(context, bedrockVideoModel(), "none");

    expect(messages[0]).toMatchObject({
      role: ConversationRole.USER,
      content: [
        { text: "First clip" },
        { text: "(video omitted: Amazon Bedrock accepts one video per request)" },
      ],
    });
    expect(messages[1]).toMatchObject({
      role: ConversationRole.ASSISTANT,
      content: [{ text: "I saw the first clip." }],
    });
    expect(messages[2]).toMatchObject({
      role: ConversationRole.USER,
      content: [
        { text: "Latest clip" },
        { video: { format: "mp4", source: { bytes: expect.any(Uint8Array) } } },
      ],
    });
  });

  it("replays native video blocks returned by tools", () => {
    const messages = testing.convertMessages(
      {
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_video",
            toolName: "record",
            content: [{ type: "text", text: "Captured footage" }, video()],
            isError: false,
          },
        ],
      },
      bedrockVideoModel(),
      "none",
    );

    expect(messages[0]).toMatchObject({
      role: ConversationRole.USER,
      content: [
        {
          toolResult: {
            toolUseId: "call_video",
            content: [
              { text: "Captured footage" },
              { video: { format: "mp4", source: { bytes: expect.any(Uint8Array) } } },
            ],
          },
        },
      ],
    });
  });

  it("retains the latest video across user turns and tool results", () => {
    const context = {
      messages: [
        { role: "user", content: [video()] },
        {
          role: "toolResult",
          toolCallId: "call_video",
          toolName: "record",
          content: [video()],
          isError: false,
        },
      ],
    };

    const messages = testing.convertMessages(context, bedrockVideoModel(), "none");

    expect(messages[0]).toMatchObject({
      role: ConversationRole.USER,
      content: [{ text: "(video omitted: Amazon Bedrock accepts one video per request)" }],
    });
    expect(messages[1]).toMatchObject({
      role: ConversationRole.USER,
      content: [
        {
          toolResult: {
            toolUseId: "call_video",
            content: [{ video: { format: "mp4", source: { bytes: expect.any(Uint8Array) } } }],
          },
        },
      ],
    });
  });

  it("makes older tool video omissions visible and ignores payload-less video metadata", () => {
    const messages = testing.convertMessages(
      {
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_old_video",
            toolName: "record",
            content: [video(), video({ data: "" })],
            isError: false,
          },
          { role: "user", content: [video()] },
        ],
      },
      bedrockVideoModel(),
      "none",
    );

    expect(messages[0]).toMatchObject({
      role: ConversationRole.USER,
      content: [
        {
          toolResult: {
            toolUseId: "call_old_video",
            content: [
              { text: "(tool video omitted: Amazon Bedrock accepts one video per request)" },
            ],
          },
        },
      ],
    });
    expect(messages[1]).toMatchObject({
      role: ConversationRole.USER,
      content: [{ video: { format: "mp4", source: { bytes: expect.any(Uint8Array) } } }],
    });
  });

  it("drops payload-less tool video metadata instead of treating it as malformed content", () => {
    const messages = testing.convertMessages(
      {
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_empty_video",
            toolName: "record",
            content: [video({ data: "" })],
            isError: false,
          },
        ],
      },
      bedrockVideoModel(),
      "none",
    );

    expect(messages[0]).toMatchObject({
      role: ConversationRole.USER,
      content: [
        {
          toolResult: {
            toolUseId: "call_empty_video",
            content: [{ text: "(no output)" }],
          },
        },
      ],
    });
  });
});
