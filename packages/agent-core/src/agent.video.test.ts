import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type ImagesModel,
  type MediaContent,
  type Model,
} from "@openclaw/llm-core";
import { Type } from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import { Agent } from "./agent.js";
import type { AgentTool } from "./types.js";

const videoModel: Model = {
  id: "video-model",
  name: "Video Model",
  api: "openai-completions",
  provider: "moonshot",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text", "image", "video"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

const video: MediaContent = {
  type: "video",
  data: "dmlkZW8=",
  mimeType: "video/mp4",
};

function completedAssistantStream(model: Model, content: AssistantMessage["content"]) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
    stream.push({
      type: "done",
      reason: stopReason,
      message: {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        timestamp: Date.now(),
      },
    });
    stream.end();
  });
  return stream;
}

describe("Agent multimodal content", () => {
  it("keeps video on chat models without widening image-generation inputs", () => {
    expectTypeOf<Model["input"][number]>().toEqualTypeOf<"text" | "image" | "video">();
    expectTypeOf<ImagesModel["input"][number]>().toEqualTypeOf<"text" | "image">();
  });

  it("preserves ordered image and video attachments in the provider-facing prompt", async () => {
    const contexts: Context[] = [];
    const image: MediaContent = {
      type: "image",
      data: "aW1hZ2U=",
      mimeType: "image/png",
    };
    const agent = new Agent({
      initialState: { model: videoModel },
      streamFn: (model, context) => {
        contexts.push(context);
        return completedAssistantStream(model, [{ type: "text", text: "compared" }]);
      },
    });

    await agent.prompt("compare these", [image, video]);

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "compare these" }, image, video],
    });
  });

  it("preserves a tool-produced video for the following model turn", async () => {
    const contexts: Context[] = [];
    const tool: AgentTool = {
      name: "record",
      label: "record",
      description: "Capture a video clip",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => ({ content: [video], details: {} }),
    };
    const agent = new Agent({
      initialState: { model: videoModel, tools: [tool] },
      streamFn: (model, context) => {
        contexts.push(context);
        return completedAssistantStream(
          model,
          contexts.length === 1
            ? [{ type: "toolCall", id: "call-video", name: "record", arguments: {} }]
            : [{ type: "text", text: "reviewed" }],
        );
      },
    });

    await agent.prompt("record a clip");

    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.messages).toContainEqual(
      expect.objectContaining({ role: "toolResult", toolName: "record", content: [video] }),
    );
  });
});
