import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { XAI_BASE_URL } from "./model-definitions.js";
import { wrapXaiProviderStream } from "./stream.js";
import { xaiModel } from "./test-helpers.js";

const ONE_PIXEL_GIF = "R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=";

function gifInput() {
  return [
    {
      type: "function_call_output",
      call_id: "call_gif",
      output: [
        {
          type: "input_image",
          image_url: `data:image/gif;base64,${ONE_PIXEL_GIF}`,
        },
      ],
    },
  ];
}

async function requestMime(provider: string): Promise<string> {
  const input = gifInput();
  const before = JSON.stringify(input);
  let mime = "missing";
  const streamFn: StreamFn = (model, _context, options) => {
    const payload = { input };
    const pending = options?.onPayload?.(payload, model);
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const resolved = (await pending) ?? payload;
      const wire = JSON.stringify(resolved);
      mime = wire.includes("data:image/jpeg;base64,/9j/")
        ? "image/jpeg"
        : wire.includes("image/gif")
          ? "image/gif"
          : "missing";
      if (JSON.stringify(input) !== before) {
        mime = "history-mutated";
      }
      stream.end({
        role: "assistant",
        content: [],
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
        stopReason: "stop",
        timestamp: 0,
      });
    })();
    return stream;
  };
  const wrapped = wrapXaiProviderStream({
    provider,
    modelId: "grok-4.6",
    streamFn,
    extraParams: { tool_stream: false },
  });
  if (!wrapped) {
    throw new Error("missing xAI stream wrapper");
  }
  const model = xaiModel({
    provider,
    id: "grok-4.6",
    baseUrl: provider === "openai" ? "https://api.openai.com/v1" : XAI_BASE_URL,
  });
  const started = wrapped(model, { messages: [] }, { apiKey: "synthetic-test-key" });
  await (await started).result();
  return mime;
}

export async function xaiGifRequestMimes(): Promise<{ xai: string; other: string }> {
  const xai = await requestMime("xai");
  if ((await requestMime("x-ai")) !== xai) {
    throw new Error("x-ai request did not match xai");
  }
  return { xai, other: await requestMime("openai") };
}
