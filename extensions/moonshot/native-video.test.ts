import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { attachModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderContext,
} from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";
import { wrapMoonshotStream } from "./native-video.js";
import { MOONSHOT_BASE_URL } from "./provider-catalog.js";

const MP4_A = "data:video/mp4;base64,YWFhYWFhYWFhYWFhYWFhYQ==";
const MP4_B = "data:video/mp4;base64,YmJiYmJiYmJiYmJiYmJiYg==";
const WEBM = "data:video/webm;base64,d2VibQ==";
const route = { provider: "moonshot", modelId: "kimi-k3" };

function model(): Model {
  return {
    id: "kimi-k3",
    name: "Kimi K3",
    provider: "moonshot",
    api: "openai-completions",
    baseUrl: MOONSHOT_BASE_URL,
    reasoning: true,
    input: ["text", "image", "video"] as never,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 1_048_576,
  } as Model;
}

function genericPayload(videoUrls = [MP4_A]) {
  const content = [
    { type: "text", text: "before" },
    { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
    ...videoUrls.map((url) => ({ type: "video_url", video_url: { url } })),
    { type: "text", text: "after" },
  ];
  return { model: "kimi-k3", messages: [{ role: "user", content }] };
}

async function dispatchPayload(
  payload: ReturnType<typeof genericPayload>,
  onPayload?: NonNullable<Parameters<StreamFn>[2]>["onPayload"],
  ceiling?: number,
) {
  let dispatched: unknown;
  const streamFn: StreamFn = async (payloadModel, _context, streamOptions) => {
    const replacement = await streamOptions?.onPayload?.(payload, payloadModel);
    dispatched = replacement === undefined ? payload : replacement;
    return createAssistantMessageEventStream();
  };
  const wrapped = wrapMoonshotStream({ ...route, streamFn } as never, false, ceiling);
  await wrapped(model(), { messages: [] } as Context, { onPayload });
  return dispatched;
}

it("allows valid hook clones and injections while omitting non-MP4 video", async () => {
  const payload = genericPayload([MP4_A, WEBM]);
  const dispatched = await dispatchPayload(payload, (value) => {
    const content = (value as typeof payload).messages[0]!.content;
    const valid = content[2]! as Record<string, unknown>;
    content.push(structuredClone(valid) as never);
    content.push({ type: "video_url", video_url: { url: MP4_B } } as never);
    content.push({ type: "image_url", image_url: { url: WEBM } } as never);
  });

  const body = JSON.stringify(dispatched);
  expect(body.split(MP4_A)).toHaveLength(3);
  expect(body).toContain("YmJiYmJi");
  expect(body).not.toContain("d2VibQ");
  expect(body.match(/video omitted/gu)).toHaveLength(2);
});

it("evicts later admitted videos in place to satisfy the exclusive final size", async () => {
  const payload = genericPayload([MP4_A, MP4_B]);
  const projectedWithSecondOmitted = genericPayload([MP4_A]);
  projectedWithSecondOmitted.messages[0]!.content.splice(3, 0, {
    type: "text",
    text: "(video omitted: Moonshot request size limit)",
  } as never);
  Object.assign(projectedWithSecondOmitted, { reasoning_effort: "max" });
  const ceiling = Buffer.byteLength(JSON.stringify(projectedWithSecondOmitted), "utf8") + 1;
  const dispatched = await dispatchPayload(payload, undefined, ceiling);

  const content = (dispatched as typeof payload).messages[0]!.content;
  expect(content[2]).toEqual({ type: "video_url", video_url: { url: MP4_A } });
  expect(content[3]).toMatchObject({ type: "text", text: expect.stringContaining("size limit") });
  expect(Buffer.byteLength(JSON.stringify(dispatched), "utf8")).toBeLessThan(ceiling);
});

it("measures caller replacements and rejects an oversized non-video body", async () => {
  await expect(
    dispatchPayload(
      genericPayload(),
      () => ({ model: "kimi-k3", messages: [], padding: "x".repeat(300) }),
      200,
    ),
  ).rejects.toThrow("Moonshot request body must be smaller than 200 bytes");
});

it("sends ordered video_url content through the real Chat Completions transport", async () => {
  let requestBody: unknown;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requestBody = JSON.parse(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: {"id":"chatcmpl-test","object":"chat.completion.chunk","model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing loopback address");
    }
    const provider = await registerSingleProviderPlugin(plugin);
    const normalized = provider.normalizeResolvedModel?.({ ...route, model: model() } as never) as
      | Model
      | undefined;
    expect(normalized?.input).toContain("video");
    const transport = createOpenAICompletionsTransportStreamFn();
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const streamFn: StreamFn = (runtimeModel, context, options) =>
      transport(
        attachModelProviderRequestTransport(
          { ...runtimeModel, provider: "custom", baseUrl },
          { allowPrivateNetwork: true },
        ),
        context,
        options,
      );
    const wrapped = provider.wrapStreamFn?.({ ...route, thinkingLevel: "off", streamFn } as never);
    if (!wrapped || !normalized) {
      throw new Error("Moonshot registered transport unavailable");
    }
    const message: ProviderContext["messages"][number] = {
      role: "user",
      content: [
        { type: "text", text: "before" },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        { type: "video", mimeType: "video/mp4", data: "dmlkZW8=" },
        { type: "text", text: "after" },
      ],
      timestamp: 1,
    };
    let callerPayload: unknown;
    const caller = vi.fn((payload: unknown) => (callerPayload = payload));
    const stream = await wrapped(normalized, { messages: [message] } as never, {
      apiKey: "test-key",
      onPayload: caller,
    });
    const streamResult = JSON.stringify(await stream.result());

    expect(caller, streamResult).toHaveBeenCalledOnce();
    const body = JSON.stringify(callerPayload);
    expect(body).not.toMatch(/__openclaw|\/private\//u);
    expect(body).toContain("data:video/mp4;base64,dmlkZW8=");
    expect(requestBody, streamResult).toBeDefined();
    expect(requestBody).toHaveProperty("messages.0.content", [
      { type: "text", text: "before" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,dmlkZW8=" } },
      { type: "text", text: "after" },
    ]);
  } finally {
    await promisify(server.close.bind(server))();
  }
});
