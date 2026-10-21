import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import type { Api, StreamFn } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { createApiRegistry, type ApiRegistry } from "./api-registry.js";
import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiTransformTransportMessages,
} from "./host.js";
import {
  anthropicModel,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";

const CUSTOM_API = "openclaw-openai-chatgpt-responses-transport";

function registerCustomApi(registry: ApiRegistry, api: Api, _streamFn: StreamFn): boolean {
  const stream = () => createAssistantMessageEventStream();
  registry.registerApiProvider({ api, stream, streamSimple: stream });
  return true;
}

describe("AI transport host configuration", () => {
  registerParityHostLifecycle();

  it("replays custom API registration when transports load before the concrete host", async () => {
    const { prepareModelForSimpleCompletion } = await import("./transports.js");
    configureAiTransportHost({});

    const registry = createApiRegistry();
    const sourceModel = {
      ...anthropicModel,
      api: "openai-chatgpt-responses" as const,
      provider: "openai",
      baseUrl: "https://chatgpt.com/backend-api",
    };
    const prepare = () =>
      prepareModelForSimpleCompletion({ apiRegistry: registry, model: sourceModel });

    expect(prepare()).toBe(sourceModel);
    expect(registry.getApiProvider(CUSTOM_API)).toBeUndefined();

    const registrar = vi.fn(registerCustomApi);
    configureAiTransportHost({ registerCustomApi: registrar });
    configureAiTransportHost({ registerCustomApi: registrar });

    const provider = registry.getApiProvider(CUSTOM_API);
    expect(registrar).toHaveBeenCalledOnce();
    expect(provider).toMatchObject({
      api: CUSTOM_API,
      stream: expect.any(Function),
      streamSimple: expect.any(Function),
    });
    const configuredModel = prepare();
    expect(configuredModel.api).toBe(CUSTOM_API);
    expect(provider?.streamSimple(configuredModel, { messages: [] })).toHaveProperty("result");
  });

  it("uses package transcript normalization until the embedding host overrides it", () => {
    configureAiTransportHost({});
    const model = { ...anthropicModel, reasoning: false };
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "image" as const, data: "aW1n", mimeType: "image/png" }],
        timestamp: 1,
      },
    ];

    expect(getAiTransportHost().transformTransportMessages(messages, model)).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "(image omitted: model does not support images)" }],
        timestamp: 1,
      },
    ]);

    const override = vi.fn<AiTransformTransportMessages>((nextMessages) => nextMessages);
    configureAiTransportHost({ transformTransportMessages: override });
    expect(getAiTransportHost().transformTransportMessages(messages, model)).toBe(messages);
    expect(override).toHaveBeenCalledOnce();
  });
});
