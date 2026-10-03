import { describe, expect, it, vi } from "vitest";
import { extractAssistantVisibleText } from "../../../../src/agents/embedded-agent-utils.js";
import { parseReplyDirectives } from "../../../../src/auto-reply/reply/reply-directives.js";
import type { AssistantMessage, Model } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import {
  processResponsesStream,
  type OpenAIResponsesStreamEvent,
} from "./openai-responses-stream-internal.js";

const model = {
  id: "image-capable-responses-model",
  name: "Image-capable Responses Model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

function output(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsage(),
    stopReason: "stop",
    timestamp: 0,
  };
}

async function* events(values: Record<string, unknown>[]) {
  for (const value of values) {
    yield value as OpenAIResponsesStreamEvent;
  }
}

describe("native Responses image generation", () => {
  it("delivers one media reference when done and terminal both carry the image", async () => {
    const item = {
      id: "ig_1",
      type: "image_generation_call",
      status: "completed",
      result: "aW1hZ2U=",
    };
    const message = output();
    const onGeneratedImage = vi.fn(async () => "/tmp/generated.png");
    const push = vi.fn();
    await processResponsesStream(
      events([
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: { id: "resp_1", status: "completed", output: [item] },
        },
      ]),
      message,
      { push },
      model,
      { onGeneratedImage },
    );
    expect(onGeneratedImage).toHaveBeenCalledExactlyOnceWith("aW1hZ2U=");
    expect(extractAssistantVisibleText(message)).toBe("MEDIA:/tmp/generated.png");
    expect(parseReplyDirectives(extractAssistantVisibleText(message)).mediaUrls).toEqual([
      "/tmp/generated.png",
    ]);
    expect(push.mock.calls.map(([event]) => event.type)).toContain("text_end");
  });

  it("recovers an image present only in the terminal snapshot", async () => {
    const message = output();
    await processResponsesStream(
      events([
        {
          type: "response.completed",
          response: {
            id: "resp_2",
            status: "completed",
            output: [
              {
                id: "ig_2",
                type: "image_generation_call",
                status: "completed",
                result: "aW1hZ2U=",
              },
            ],
          },
        },
      ]),
      message,
      { push: () => undefined },
      model,
      { onGeneratedImage: () => "/tmp/recovered.png" },
    );
    expect(extractAssistantVisibleText(message)).toBe("MEDIA:/tmp/recovered.png");
  });

  it("keeps streamed text when an earlier terminal image has no handler", async () => {
    const image = {
      id: "ig_unhandled",
      type: "image_generation_call",
      status: "completed",
      result: "aW1hZ2U=",
    };
    const text = {
      id: "msg_after_image",
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Still here", annotations: [] }],
    };
    const message = output();
    await processResponsesStream(
      events([
        { type: "response.output_item.done", output_index: 1, item: text },
        {
          type: "response.completed",
          response: { id: "resp_unhandled", status: "completed", output: [image, text] },
        },
      ]),
      message,
      { push: () => undefined },
      model,
    );
    expect(extractAssistantVisibleText(message)).toBe("Still here");
  });

  it("materializes deferred text before an image completed without an added event", async () => {
    const first = {
      id: "msg_before_deferred",
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Hello", annotations: [] }],
    };
    const second = {
      id: "msg_deferred",
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Hello again", annotations: [] }],
    };
    const image = {
      id: "ig_after_deferred",
      type: "image_generation_call",
      status: "completed",
      result: "aW1hZ2U=",
    };
    const message = output();
    await processResponsesStream(
      events([
        { type: "response.output_item.done", output_index: 0, item: first },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { ...second, status: "in_progress", content: [] },
        },
        {
          type: "response.output_text.delta",
          output_index: 1,
          item_id: second.id,
          delta: "Hello again",
        },
        { type: "response.output_item.done", output_index: 2, item: image },
        { type: "response.output_item.done", output_index: 1, item: second },
        {
          type: "response.completed",
          response: {
            id: "resp_deferred_image",
            status: "completed",
            output: [first, second, image],
          },
        },
      ]),
      message,
      { push: () => undefined },
      model,
      { onGeneratedImage: () => "/tmp/deferred.png" },
    );
    expect(message.content.map((block) => block.type === "text" && block.text)).toEqual([
      "Hello",
      "Hello again",
      "MEDIA:/tmp/deferred.png",
    ]);
  });

  it("keeps an image alongside phased final text in provider order", async () => {
    const message = output();
    await processResponsesStream(
      events([
        {
          type: "response.completed",
          response: {
            id: "resp_3",
            status: "completed",
            output: [
              {
                id: "msg_1",
                type: "message",
                role: "assistant",
                status: "completed",
                phase: "final_answer",
                content: [{ type: "output_text", text: "Here it is.", annotations: [] }],
              },
              {
                id: "ig_3",
                type: "image_generation_call",
                status: "completed",
                result: "aW1hZ2U=",
              },
            ],
          },
        },
      ]),
      message,
      { push: () => undefined },
      model,
      { onGeneratedImage: () => "/tmp/ordered.png" },
    );
    expect(message.content.map((block) => block.type === "text" && block.text)).toEqual([
      "Here it is.",
      "MEDIA:/tmp/ordered.png",
    ]);
    expect(extractAssistantVisibleText(message)).toBe("Here it is.\nMEDIA:/tmp/ordered.png");
  });

  it("rejects a missing earlier text item after a later image was streamed", async () => {
    const image = {
      id: "ig_late",
      type: "image_generation_call",
      status: "completed",
      result: "aW1hZ2U=",
    };
    const text = {
      id: "msg_earlier",
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Earlier", annotations: [] }],
    };
    await expect(
      processResponsesStream(
        events([
          { type: "response.output_item.done", output_index: 1, item: image },
          {
            type: "response.completed",
            response: { id: "resp_4", status: "completed", output: [text, image] },
          },
        ]),
        output(),
        { push: () => undefined },
        model,
        { onGeneratedImage: () => "/tmp/later.png" },
      ),
    ).rejects.toThrow("omitted an output item before completed output");
  });

  it("keeps terminal text on either side of an image distinct", async () => {
    const message = output();
    await processResponsesStream(
      events([
        {
          type: "response.completed",
          response: {
            id: "resp_5",
            status: "completed",
            output: [
              {
                id: "msg_a",
                type: "message",
                role: "assistant",
                status: "completed",
                phase: "final_answer",
                content: [{ type: "output_text", text: "A", annotations: [] }],
              },
              {
                id: "ig_middle",
                type: "image_generation_call",
                status: "completed",
                result: "aW1hZ2U=",
              },
              {
                id: "msg_b",
                type: "message",
                role: "assistant",
                status: "completed",
                phase: "final_answer",
                content: [{ type: "output_text", text: "AB", annotations: [] }],
              },
            ],
          },
        },
      ]),
      message,
      { push: () => undefined },
      model,
      { onGeneratedImage: () => "/tmp/middle.png" },
    );
    expect(message.content.map((block) => block.type === "text" && block.text)).toEqual([
      "A",
      "MEDIA:/tmp/middle.png",
      "AB",
    ]);
  });
});
