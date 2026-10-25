import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import { detectAndLoadAgentHarnessPromptImages } from "openclaw/plugin-sdk/agent-harness-runtime";
import { streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createLiveValueTool } from "../test-support/live-value-tool.test-support.js";
import { registerModel, toolReplayMessages } from "./baseten.test-support.js";
import basetenPlugin from "./index.js";

const TEST_VALUE = "resolved-marker";
const DEEPSEEK_V41_FLASH_MODEL_ID = "deepseek-ai/DeepSeek-V4.1-Flash";
const probeTool = createLiveValueTool("live_probe");
const resolveProviderAuth = () => ({
  apiKey: TEST_VALUE,
  discoveryApiKey: TEST_VALUE,
  profileId: "baseten:fixture",
  mode: "api_key" as const,
  source: "profile" as const,
});

function mockCatalog(data: Record<string, unknown>[]) {
  clearLiveCatalogCacheForTests();
  const catalogFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe("https://inference.baseten.co/v1/models");
    expect(request.method).toBe("GET");
    return Response.json({ data });
  });
  onTestFinished(() => {
    catalogFetch.mockRestore();
    clearLiveCatalogCacheForTests();
  });
  return catalogFetch;
}

async function resolveSparseLiveModel(modelId = DEEPSEEK_V41_FLASH_MODEL_ID) {
  const catalogFetch = mockCatalog([
    {
      id: modelId,
      object: "model",
      name: modelId,
      supported_features: ["tools", "reasoning", "json_mode", "structured_outputs"],
      context_length: 900_000,
      max_completion_tokens: 120_000,
      pricing: { prompt: "0.00000037", completion: "0.00000141", input_cache_read: "0.000000011" },
    },
  ]);
  const registered = await registerModel(modelId, { resolveProviderAuth });
  expect(catalogFetch).toHaveBeenCalledOnce();
  return registered;
}

async function captureRegisteredRequest(params: {
  provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
  model: Model<"openai-completions">;
  reasoning: "off" | "low" | "high" | "max";
  simple?: boolean;
  maxTokens?: number;
  replay?: boolean;
  images?: Awaited<ReturnType<typeof detectAndLoadAgentHarnessPromptImages>>["images"];
}) {
  let body: Record<string, unknown> | undefined;
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockClear()
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://inference.baseten.co/v1/chat/completions");
      expect(request.method).toBe("POST");
      body = (await request.json()) as Record<string, unknown>;
      return new Response(
        `data: ${JSON.stringify({ id: "chatcmpl-baseten-fixture", object: "chat.completion.chunk", model: params.model.id, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
  const wrap = params.simple
    ? params.provider.wrapSimpleCompletionStreamFn
    : params.provider.wrapStreamFn;
  const wrapped = wrap?.({
    provider: params.provider.id,
    modelId: params.model.id,
    model: params.model,
    sourceApi: "openai-completions",
    thinkingLevel: params.reasoning,
    streamFn: params.simple ? createOpenAICompletionsTransportStreamFn() : streamSimple,
  });
  if (!wrapped) {
    throw new Error("Registered Baseten stream wrapper is missing");
  }
  const stream = await wrapped(
    params.model,
    {
      messages: params.replay
        ? [
            ...toolReplayMessages("live_probe"),
            { role: "user", content: "Reply with exactly ok.", timestamp: 3 },
          ]
        : [
            {
              role: "user",
              content: [{ type: "text", text: "Call live_probe." }, ...(params.images ?? [])],
              timestamp: 0,
            },
          ],
      tools: [probeTool],
    },
    {
      apiKey: TEST_VALUE,
      maxTokens: params.maxTokens ?? 256,
      reasoning: params.reasoning,
      onPayload: (payload) =>
        params.replay
          ? payload
          : {
              ...(payload as Record<string, unknown>),
              tool_choice: { type: "function", function: { name: "live_probe" } },
            },
    },
  );
  const result = await stream.result();
  expect(result.stopReason, result.errorMessage).toBe("stop");
  expect(fetchMock).toHaveBeenCalledOnce();
  return body;
}

describe("Baseten sparse live model transport", () => {
  it("forwards configured references through the registered live catalog", async () => {
    const fetchMock = mockCatalog([{ id: "chat-local", object: "model" }]);
    const provider = await registerSingleProviderPlugin(basetenPlugin);
    if (!provider.catalog) {
      throw new Error("Registered Baseten catalog is missing");
    }
    const result = await provider.catalog.run({
      config: { agents: { defaults: { model: "baseten/chat-typo" } } },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: TEST_VALUE }),
      resolveProviderAuth,
    });
    expect(result?.outcomes).toEqual([
      {
        provider: "baseten",
        profileId: "baseten:fixture",
        status: "ready",
        modelIdCatalog: {
          baseUrl: expect.any(String),
          modelIds: ["chat-local"],
        },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["off", "low", "high", "max"] as const)(
    "sends documented %s effort through both registered hooks",
    async (reasoning) => {
      const { provider, model } = await resolveSparseLiveModel();
      for (const simple of [false, true]) {
        const body = await captureRegisteredRequest({ provider, model, reasoning, simple });
        expect(body).toMatchObject({
          model: DEEPSEEK_V41_FLASH_MODEL_ID,
          max_tokens: 256,
          reasoning_effort: reasoning === "off" ? "none" : reasoning,
          tool_choice: { type: "function", function: { name: "live_probe" } },
          tools: [{ type: "function", function: { name: "live_probe" } }],
        });
        expect(body).not.toHaveProperty("thinking");
        expect(body).not.toHaveProperty("chat_template_args");
      }
    },
  );

  it("prepares image input from the authenticated catalog and preserves live limits and prices", async () => {
    const { provider, model } = await resolveSparseLiveModel();
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 }).toString("base64"),
    };
    const prepared = await detectAndLoadAgentHarnessPromptImages({
      prompt: "Describe the color.",
      workspaceDir: process.cwd(),
      model,
      existingImages: [image],
    });
    expect(prepared.images).toHaveLength(1);
    expect(model).toMatchObject({
      id: DEEPSEEK_V41_FLASH_MODEL_ID,
      input: ["text", "image"],
      contextWindow: 900_000,
      maxTokens: 120_000,
      cost: { input: 0.37, output: 1.41, cacheRead: 0.011, cacheWrite: 0 },
    });
    const body = await captureRegisteredRequest({
      provider,
      model,
      reasoning: "low",
      images: prepared.images,
    });
    expect(body?.messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: expect.arrayContaining([
          { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } },
        ]),
      }),
    );
  });

  it("sends the current Pro replay through its registered transport", async () => {
    const { provider, model } = await resolveSparseLiveModel("deepseek-ai/DeepSeek-V4-Pro-0813");
    const body = await captureRegisteredRequest({
      provider,
      model,
      reasoning: "high",
      maxTokens: 512,
      replay: true,
    });
    expect(body).toMatchObject({
      model: "deepseek-ai/DeepSeek-V4-Pro-0813",
      max_tokens: 512,
      reasoning_effort: "high",
      thinking: { type: "enabled" },
    });
    expect(body).not.toHaveProperty("tool_choice");
    expect(body?.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        reasoning_content: "",
        tool_calls: expect.any(Array),
      }),
    );
  });
});
