import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { wrapXaiProviderStream } from "./stream.js";

export function xaiModel(
  overrides: Partial<Model<"openai-responses">> = {},
): Model<"openai-responses"> {
  return {
    api: "openai-responses",
    provider: "xai",
    id: "grok-4-fast",
    name: "Fixture",
    baseUrl: "https://proxy.example/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 64_000,
    ...overrides,
  };
}

export function captureXaiRequest(
  model: Parameters<StreamFn>[0],
  {
    extraParams = {},
    headers,
    payload = {
      reasoning: { effort: "high" },
      tools: [
        {
          type: "function",
          function: {
            name: "write",
            parameters: { type: "object", properties: {} },
            strict: true,
          },
        },
      ],
    },
    wrap = (ctx) => wrapXaiProviderStream(ctx, { clientVersion: "2026.7.2" }),
  }: {
    extraParams?: Record<string, unknown>;
    headers?: Record<string, string>;
    payload?: Record<string, unknown>;
    wrap?: (ctx: ProviderWrapStreamFnContext) => StreamFn | null | undefined;
  } = {},
) {
  let modelId: string | undefined;
  let capturedHeaders: Record<string, string> | undefined;
  const streamFn: StreamFn = (selected, _context, options) => {
    modelId = selected.id;
    capturedHeaders = options?.headers;
    options?.onPayload?.(payload, selected);
    return {} as ReturnType<StreamFn>;
  };
  const wrapped = wrap({ provider: "xai", modelId: model.id, extraParams, streamFn });
  if (!wrapped) {
    throw new Error("expected xAI stream wrapper");
  }
  void wrapped(model, { messages: [] }, { headers });
  return { modelId, headers: capturedHeaders, payload };
}
