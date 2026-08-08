import { describe, expect, it } from "vitest";
import { convertMessages } from "./openai-completions-messages.js";
import { resolveOpenAICompletionsCompat } from "./transports/openai-completions-compat.js";
import type { AssistantMessage, Context, Model } from "./types.js";

const model: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "custom-openai-compatible",
  baseUrl: "https://proxy.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("convertMessages assistant text replay", () => {
  it("keeps separate assistant text blocks apart", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [
        { type: "text", text: "Let me check the file." },
        { type: "text", text: "The file contains X." },
      ],
      usage: emptyUsage,
      stopReason: "stop",
      timestamp: 2,
    };
    const context: Context = {
      messages: [{ role: "user", content: "hello", timestamp: 1 }, assistant],
    };

    const converted = convertMessages(model, context, resolveOpenAICompletionsCompat(model));

    const replayed = converted.find((message) => message.role === "assistant");
    expect(replayed?.content).toBe("Let me check the file.\nThe file contains X.");
  });

  it("keeps paired OpenAI tool call ids UTF-16 safe when truncating", () => {
    const prefix = "a".repeat(39);
    const oversizedId = `${prefix}🐱`;
    const targetModel: Model<"openai-completions"> = {
      ...model,
      id: "target-model",
      provider: "openai",
    };
    const assistant: AssistantMessage = {
      role: "assistant",
      api: targetModel.api,
      provider: targetModel.provider,
      model: "source-model",
      content: [{ type: "toolCall", id: oversizedId, name: "lookup", arguments: {} }],
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 1,
    };
    const context: Context = {
      messages: [
        assistant,
        {
          role: "toolResult",
          toolCallId: oversizedId,
          toolName: "lookup",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 2,
        },
      ],
    };

    const converted = convertMessages(
      targetModel,
      context,
      resolveOpenAICompletionsCompat(targetModel),
    );
    const assistantParam = converted.find((message) => message.role === "assistant");
    const toolParam = converted.find((message) => message.role === "tool");
    const normalizedAssistantId =
      assistantParam?.role === "assistant" ? assistantParam.tool_calls?.[0]?.id : undefined;
    const normalizedToolResultId = toolParam?.role === "tool" ? toolParam.tool_call_id : undefined;

    expect(oversizedId.slice(0, 40).charCodeAt(39)).toBe(0xd83d);
    expect(normalizedAssistantId).toBe(prefix);
    expect(normalizedToolResultId).toBe(prefix);
  });
});

describe("convertMessages native video content", () => {
  const videoModel = {
    ...model,
    provider: "openrouter",
    input: ["text", "image", "video"],
  } satisfies Model<"openai-completions">;

  it("serializes video-capable user turns as vendor video_url content", () => {
    const converted = convertMessages(
      videoModel,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this clip" },
              { type: "video", mimeType: "video/mp4", data: "dmlkZW8=" },
            ],
            timestamp: 1,
          },
        ],
      } satisfies Context,
      resolveOpenAICompletionsCompat(videoModel),
    );

    expect(converted).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this clip" },
          { type: "video_url", video_url: { url: "data:video/mp4;base64,dmlkZW8=" } },
        ],
      },
    ]);
  });

  it("preserves video for an OpenAI provider configured with a third-party endpoint", () => {
    const customEndpointModel = {
      ...videoModel,
      provider: "openai",
      baseUrl: "https://compatible.example/v1",
    } satisfies Model<"openai-completions">;
    const converted = convertMessages(
      customEndpointModel,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "video", mimeType: "video/mp4", data: "dmlkZW8=" }],
            timestamp: 1,
          },
        ],
      } satisfies Context,
      resolveOpenAICompletionsCompat(customEndpointModel),
    );

    expect(converted).toEqual([
      {
        role: "user",
        content: [{ type: "video_url", video_url: { url: "data:video/mp4;base64,dmlkZW8=" } }],
      },
    ]);
  });

  it("downgrades historical video for an OpenAI model without video capability", () => {
    const openAIModel = {
      ...model,
      provider: "openai",
      input: ["text", "image"],
    } satisfies Model<"openai-completions">;
    const converted = convertMessages(
      openAIModel,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "video", mimeType: "video/mp4", data: "dmlkZW8=" }],
            timestamp: 1,
          },
        ],
      } satisfies Context,
      resolveOpenAICompletionsCompat(openAIModel),
    );

    expect(converted).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "(video omitted: model does not support videos)" }],
      },
    ]);
    expect(JSON.stringify(converted)).not.toContain("video_url");
    expect(JSON.stringify(converted)).not.toContain("dmlkZW8=");
  });

  it("replays video-bearing tool results in a compatible user media turn", () => {
    const converted = convertMessages(
      videoModel,
      {
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_video",
            toolName: "record_clip",
            content: [{ type: "video", mimeType: "video/webm", data: "dmlkZW8=" }],
            isError: false,
            timestamp: 1,
          },
        ],
      } satisfies Context,
      resolveOpenAICompletionsCompat(videoModel),
    );

    expect(converted).toEqual([
      {
        role: "tool",
        content: "(see attached video)",
        tool_call_id: "call_video",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Attached video(s) from tool result:" },
          { type: "video_url", video_url: { url: "data:video/webm;base64,dmlkZW8=" } },
        ],
      },
    ]);
  });

  it("downgrades replayed tool-result video for models without video capability", () => {
    const converted = convertMessages(
      model,
      {
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_video",
            toolName: "record_clip",
            content: [{ type: "video", mimeType: "video/mp4", data: "dmlkZW8=" }],
            isError: false,
            timestamp: 1,
          },
        ],
      } satisfies Context,
      resolveOpenAICompletionsCompat(model),
    );

    expect(converted).toEqual([
      {
        role: "tool",
        content: "(tool video omitted: model does not support videos)",
        tool_call_id: "call_video",
      },
    ]);
    expect(JSON.stringify(converted)).not.toContain("video_url");
  });
});
