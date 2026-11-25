import { expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { registerParityHostLifecycle } from "../provider-transport-parity.test-support.js";
import {
  PROVIDER_CONTEXT_HANDOFF,
  PROVIDER_MODEL_INPUT,
  type ProviderContext,
  type ProviderStreamOptions,
} from "../provider-types.js";
import {
  streamOpenAICompletions,
  streamSimpleOpenAICompletions,
} from "../providers/openai-completions.js";
import type { Context } from "../types.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { makeCompletionsChunk, makeCompletionsModel } from "./openai-completions.test-support.js";
registerParityHostLifecycle();

type EntryPoint = "direct" | "simple" | "managed";
const entryPoints = {
  direct: streamOpenAICompletions,
  simple: streamSimpleOpenAICompletions,
  managed: createOpenAICompletionsTransportStreamFn(),
};
const videoData = "A".repeat(1_050_000);
const prompt = { type: "text" as const, text: "Inspect the clip." };
const video = { type: "video" as const, data: videoData, mimeType: "video/mp4" };
const videoUrl = { type: "video_url", video_url: { url: `data:video/mp4;base64,${videoData}` } };
const omittedVideo = {
  type: "text",
  text: "(video omitted: provider does not support video input)",
};

it.each([
  ["direct", true],
  ["simple", true],
  ["managed", true],
  ["managed", false],
] satisfies [EntryPoint, boolean][])(
  "sends %s video (supported=%s)",
  async (entryPoint, supported) => {
    let request: Request | undefined;
    configureAiTransportHost({
      ...getAiTransportHost(),
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
    });
    const context: Context = {
      messages: [{ role: "user", content: "canonical turn", timestamp: 1 }],
    };
    const providerContext: ProviderContext = {
      messages: [{ role: "user", content: [{ ...prompt }, { ...video }], timestamp: 1 }],
    };
    const handoff = vi.fn(async () => providerContext);
    const options = {
      apiKey: "test-key",
      maxTokens: 8_192,
      [PROVIDER_CONTEXT_HANDOFF]: handoff,
      [PROVIDER_MODEL_INPUT]: supported ? ["text", "image", "video"] : undefined,
    } satisfies ProviderStreamOptions;
    const stream = entryPoints[entryPoint](model, context, options);
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
    const body = await request.json();
    expect(body.messages).toEqual([
      { role: "user", content: [prompt, supported ? videoUrl : omittedVideo] },
    ]);
    expect(body.max_completion_tokens).toBe(8_192);
  },
);
