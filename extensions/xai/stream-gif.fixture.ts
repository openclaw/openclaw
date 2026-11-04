import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
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
    return {
      result: async () => {
        const resolved = ((await pending) ?? payload) as { input?: unknown };
        const wire = JSON.stringify(resolved);
        mime = wire.includes("data:image/jpeg;base64,/9j/")
          ? "image/jpeg"
          : wire.includes("image/gif")
            ? "image/gif"
            : "missing";
        if (JSON.stringify(input) !== before) {
          mime = "history-mutated";
        }
        return undefined as never;
      },
    } as ReturnType<StreamFn>;
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
  await wrapped(model, { messages: [] }, { apiKey: "synthetic-test-key" }).result();
  return mime;
}

export async function xaiGifRequestMimes(): Promise<{ xai: string; other: string }> {
  const xai = await requestMime("xai");
  if ((await requestMime("x-ai")) !== xai) {
    throw new Error("x-ai request did not match xai");
  }
  return { xai, other: await requestMime("openai") };
}
