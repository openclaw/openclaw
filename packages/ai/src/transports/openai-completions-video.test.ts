import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  PROVIDER_CONTEXT_HANDOFF,
  PROVIDER_MODEL_INPUT,
  type ProviderContext,
  type ProviderModel,
  type ProviderStreamOptions,
} from "../provider-types.js";
import {
  streamOpenAICompletions,
  streamSimpleOpenAICompletions,
} from "../providers/openai-completions.js";
import type { Context } from "../types.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsChunk, makeCompletionsModel } from "./openai-completions.test-support.js";

type EntryPoint = "direct" | "simple" | "managed";
const entryPoints: EntryPoint[] = ["direct", "simple", "managed"];
const videoData = "A".repeat(1_050_000);

async function captureVideoRequest(entryPoint: EntryPoint, input?: ProviderModel["input"]) {
  const previousHost = getAiTransportHost();
  let request: Request | undefined;
  configureAiTransportHost({
    ...previousHost,
    buildModelFetch: () => async (url, init) => {
      request = new Request(url, init);
      return new Response(
        `data: ${JSON.stringify(makeCompletionsChunk({ content: "clip received" }, "stop"))}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const model = makeCompletionsModel({
    provider: "custom-local",
    baseUrl: "http://127.0.0.1:1234/v1",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 64_000,
    maxTokens: 8_192,
  });
  const context: Context = {
    messages: [{ role: "user", content: "canonical turn", timestamp: 1 }],
  };
  const providerContext: ProviderContext = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect the clip." },
          { type: "video", data: videoData, mimeType: "video/mp4" },
        ],
        timestamp: 1,
      },
    ],
  };
  const handoff = vi.fn(async () => providerContext);
  const options = {
    apiKey: "test-key",
    maxTokens: 8_192,
    [PROVIDER_CONTEXT_HANDOFF]: handoff,
    [PROVIDER_MODEL_INPUT]: input,
  } satisfies ProviderStreamOptions;
  try {
    const stream =
      entryPoint === "direct"
        ? streamOpenAICompletions(model, context, options)
        : entryPoint === "simple"
          ? streamSimpleOpenAICompletions(model, context, options)
          : createOpenAICompletionsTransportStreamFn()(model, context, options);
    if (stream instanceof Promise) {
      throw new Error("Completions streams must be returned synchronously");
    }
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "clip received" }]);
    expect(handoff).toHaveBeenCalledOnce();
    expect(model.input).toEqual(["text", "image"]);
    expect(context.messages[0]?.content).toBe("canonical turn");
    if (!request) {
      throw new Error("Expected a completions request");
    }
    return await request.json();
  } finally {
    configureAiTransportHost(previousHost);
  }
}

describe("native video at the completions boundary", () => {
  it.each(entryPoints)("sends provider video through the %s entry point", async (entryPoint) => {
    const body = await captureVideoRequest(entryPoint, ["text", "image", "video"]);
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect the clip." },
          { type: "video_url", video_url: { url: `data:video/mp4;base64,${videoData}` } },
        ],
      },
    ]);
    expect(body.max_completion_tokens).toBe(8_192);
  });

  it("keeps the omission when the provider does not declare video input", async () => {
    const body = await captureVideoRequest("managed");
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect the clip." },
          { type: "text", text: "(video omitted: provider does not support video input)" },
        ],
      },
    ]);
  });
});
