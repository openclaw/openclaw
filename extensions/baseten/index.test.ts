import { createApiRegistry, createNodeLlmRuntime } from "@openclaw/ai";
import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import { detectAndLoadAgentHarnessPromptImages } from "openclaw/plugin-sdk/agent-harness-runtime";
import { getApiProvider, type Context, type SimpleStreamOptions } from "openclaw/plugin-sdk/llm";
import {
  createRuntimeEnv,
  createTestWizardPrompter,
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { createSolidPngBuffer, makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, onTestFinished, vi } from "vitest";
import { createLiveValueTool } from "../test-support/live-value-tool.test-support.js";
import { applyBasetenConfig, buildStaticBasetenModels } from "./api.js";
import { registerModel, toolReplayMessages } from "./baseten.test-support.js";
import basetenPlugin from "./index.js";

const KEY = "resolved-marker";
const BASE_URL = "https://inference.baseten.co/v1";
const FLASH = "deepseek-ai/DeepSeek-V4.1-Flash";
const PRO = "deepseek-ai/DeepSeek-V4-Pro-0813";
const resolveProviderAuth = () => ({
  apiKey: KEY,
  discoveryApiKey: KEY,
  profileId: "baseten:fixture",
  mode: "api_key" as const,
  source: "profile" as const,
});
const toolContext: Context = {
  messages: [{ role: "user", content: "Call live_probe.", timestamp: 0 }],
  tools: [createLiveValueTool("live_probe")],
};
const forceTool: SimpleStreamOptions = {
  onPayload: (payload) => ({
    ...(payload as Record<string, unknown>),
    tool_choice: { type: "function", function: { name: "live_probe" } },
  }),
};
const preserveTemplate: SimpleStreamOptions = {
  onPayload: (payload) => ({
    ...(payload as Record<string, unknown>),
    chat_template_args: { preserve_me: true },
  }),
};

function mockCatalog(data: Record<string, unknown>[]) {
  clearLiveCatalogCacheForTests();
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect([request.method, request.url]).toEqual(["GET", `${BASE_URL}/models`]);
    return Response.json({ data });
  });
  onTestFinished(() => {
    fetchMock.mockRestore();
    clearLiveCatalogCacheForTests();
  });
}

async function liveModel(modelId = FLASH) {
  mockCatalog([
    {
      id: modelId,
      object: "model",
      supported_features: ["tools", "reasoning", "json_mode", "structured_outputs"],
      context_length: 900_000,
      max_completion_tokens: 120_000,
      pricing: { prompt: "0.00000037", completion: "0.00000141", input_cache_read: "0.000000011" },
    },
  ]);
  return registerModel(modelId, { resolveProviderAuth });
}

function capture(
  { provider, model }: Awaited<ReturnType<typeof registerModel>>,
  thinkingLevel?: "off" | "high" | "adaptive",
  simple = false,
) {
  let body: Record<string, unknown> = {};
  let headers: Headers | undefined;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    headers = request.headers;
    expect([request.method, request.url]).toEqual(["POST", `${BASE_URL}/chat/completions`]);
    body = (await request.json()) as Record<string, unknown>;
    return new Response(
      `data: ${JSON.stringify({ id: "chatcmpl-baseten-fixture", object: "chat.completion.chunk", model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  });
  onTestFinished(() => fetchMock.mockRestore());
  const registry = createApiRegistry();
  const completions = getApiProvider("openai-completions");
  if (!completions) {
    throw new Error("expected built-in Chat Completions adapter");
  }
  registry.registerApiProvider(completions);
  const runtime = createNodeLlmRuntime(registry, { buildModelFetch: () => fetchMock });
  const wrap = simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
  const wrapped = wrap?.({
    provider: provider.id,
    modelId: model.id,
    model,
    sourceApi: "openai-completions",
    thinkingLevel,
    streamFn: simple ? createOpenAICompletionsTransportStreamFn() : runtime.streamSimple,
  });
  if (!wrapped) {
    throw new Error("Registered Baseten stream wrapper is missing");
  }
  return async (options: SimpleStreamOptions = {}, context = toolContext) => {
    const result = await (
      await wrapped(model, context, { apiKey: KEY, maxTokens: 256, ...options })
    ).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    return { body, headers };
  };
}

it.each([undefined, "replace"] as const)(
  "keeps registered %s setup separate from the public catalog preset",
  async (mode) => {
    const provider = await registerSingleProviderPlugin(basetenPlugin);
    const method = resolveProviderPluginChoice({
      providers: [provider],
      choice: "baseten-api-key",
    })?.method;
    if (!method?.runNonInteractive) {
      throw new Error("expected Baseten noninteractive auth method");
    }
    const config: OpenClawConfig = { models: { mode } };
    const interactive = await method.run({
      config,
      env: {},
      opts: { basetenApiKey: KEY },
      runtime: createRuntimeEnv(),
      prompter: createTestWizardPrompter(),
      secretInputMode: "plaintext",
      isRemote: false,
      openUrl: vi.fn(),
      oauth: { createVpsAwareHandlers: vi.fn() },
    });
    const noninteractive = await method.runNonInteractive({
      authChoice: "baseten-api-key",
      opts: {},
      config,
      baseConfig: config,
      runtime: createRuntimeEnv(),
      resolveApiKey: async () => ({ key: KEY, source: "profile" }),
      toApiKeyCredential: () => null,
    });
    for (const output of [interactive.configPatch, noninteractive]) {
      expect(output?.models?.providers?.baseten).toMatchObject({
        baseUrl: BASE_URL,
        api: "openai-completions",
      });
      expect(output?.models?.providers?.baseten?.models).toHaveLength(mode === "replace" ? 6 : 0);
      expect(output?.agents?.defaults?.models).toEqual({
        [`baseten/${FLASH}`]: { alias: "DeepSeek V4.1 Flash" },
      });
    }
    expect(applyBasetenConfig(config).models?.providers?.baseten?.models).toHaveLength(6);
  },
);

it.each([undefined, "off", "high", "adaptive"] as const)(
  "preserves per-call thinking and the %s factory default",
  async (thinkingLevel) => {
    // Preserve managed-serializer defaults while exercising the real transport.
    const send = capture(await registerModel("zai-org/GLM-5.2"), thinkingLevel, true);
    const payloads = [];
    for (const reasoning of ["off", "max", undefined] as const) {
      payloads.push((await send({ ...preserveTemplate, reasoning }, { messages: [] })).body);
    }
    const defaultEffort =
      thinkingLevel === "adaptive" ? "max" : thinkingLevel === "high" ? "high" : "none";
    expect(payloads.map((p) => [p.chat_template_args, p.reasoning_effort])).toEqual([
      [{ preserve_me: true, enable_thinking: false }, "none"],
      [{ preserve_me: true, enable_thinking: true }, "max"],
      [{ preserve_me: true, enable_thinking: defaultEffort !== "none" }, defaultEffort],
    ]);
  },
);

it.each([false, true])(
  "normalizes DeepSeek replay per call (authored legacy=%s)",
  async (legacy) => {
    const current = buildStaticBasetenModels().find((model) => model.id === PRO);
    if (!current) {
      throw new Error("Current DeepSeek Pro metadata missing");
    }
    const modelId = legacy ? "deepseek-ai/DeepSeek-V4-Pro" : PRO;
    const send = capture(
      await registerModel(modelId, undefined, legacy ? { ...current, id: modelId } : undefined),
      undefined,
      true,
    );
    const context: Context = {
      tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
      messages: [
        ...toolReplayMessages("read"),
        makeAgentAssistantMessage({
          api: "openai-completions",
          provider: "baseten",
          model: modelId,
          timestamp: 3,
          content: [
            { type: "thinking", thinking: "preserve me", thinkingSignature: "reasoning_content" },
            { type: "text", text: "done" },
          ],
        }),
      ],
    };
    for (const [reasoning, effort] of [
      ["off", "none"],
      ["max", "max"],
      [undefined, "high"],
    ] as const) {
      const { body } = await send({ ...preserveTemplate, reasoning }, context);
      expect([body.model, body.reasoning_effort, body.chat_template_args]).toEqual([
        modelId,
        effort,
        { preserve_me: true },
      ]);
      expect(body.thinking).toEqual(
        legacy ? undefined : { type: reasoning === "off" ? "disabled" : "enabled" },
      );
      if (reasoning === "off") {
        expect(body.messages).not.toContainEqual(
          expect.objectContaining({ reasoning_content: expect.any(String) }),
        );
      } else {
        expect(body.messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "assistant",
              tool_calls: expect.any(Array),
              reasoning_content: "",
            }),
            expect.objectContaining({
              role: "assistant",
              content: "done",
              reasoning_content: "preserve me",
            }),
          ]),
        );
      }
    }
  },
);

it("exposes opt-in thinking without duplicate reasoning levels", async () => {
  const provider = await registerSingleProviderPlugin(basetenPlugin);
  const deepseekLevels = [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }];
  const glmProfile = { levels: ["off", "high", "max"].map((id) => ({ id })), defaultLevel: "off" };
  for (const [modelId, expected] of [
    [FLASH, { levels: deepseekLevels, defaultLevel: "high" }],
    [PRO, { levels: deepseekLevels }],
    [
      "moonshotai/Kimi-K2.6",
      { levels: [{ id: "off" }, { id: "low", label: "on" }], defaultLevel: "off" },
    ],
    ["zai-org/GLM-5.2", glmProfile],
    ["zai-org/GLM-5.2-Fast", glmProfile],
    ["thinkingmachines/inkling", undefined],
  ] as const) {
    expect(
      provider.resolveThinkingProfile?.({ provider: "baseten", modelId, reasoning: true } as never),
      modelId,
    ).toEqual(expected);
  }
});

it.each<[SimpleStreamOptions, string]>([
  [{ sessionId: "synthetic-session" }, "synthetic-session"],
  [
    { sessionId: "synthetic-session", headers: { "X-Session-Affinity": "caller-affinity" } },
    "caller-affinity",
  ],
])("sends Baseten cache affinity in the real request: %j", async (options, expected) => {
  const { headers } = await capture(await liveModel())(options);
  expect(headers?.get("x-session-affinity")).toBe(expected);
});

it("preserves sparse Pro capabilities and sends its thinking envelope", async () => {
  const registered = await liveModel(PRO);
  expect(registered.model.input).toEqual(["text"]);
  const { body } = await capture(registered)({ reasoning: "high" });
  expect(body).toMatchObject({
    model: PRO,
    reasoning_effort: "high",
    thinking: { type: "enabled" },
  });
});

it("forwards configured references through the registered live catalog", async () => {
  mockCatalog([{ id: "chat-local", object: "model" }]);
  const provider = await registerSingleProviderPlugin(basetenPlugin);
  if (!provider.catalog) {
    throw new Error("Registered Baseten catalog is missing");
  }
  const result = await provider.catalog.run({
    config: { agents: { defaults: { model: "baseten/chat-typo" } } },
    env: {},
    resolveProviderApiKey: () => ({ apiKey: KEY }),
    resolveProviderAuth,
  });
  expect(result?.outcomes).toEqual([
    {
      provider: "baseten",
      profileId: "baseten:fixture",
      status: "ready",
      modelIdCatalog: { baseUrl: expect.any(String), modelIds: ["chat-local"] },
    },
  ]);
});

it.each(["off", "low", "high", "max"] as const)(
  "sends documented %s effort through both registered hooks",
  async (reasoning) => {
    const registered = await liveModel();
    for (const simple of [false, true]) {
      const { body } = await capture(registered, undefined, simple)({ ...forceTool, reasoning });
      expect(body).toMatchObject({
        model: FLASH,
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
  const registered = await liveModel();
  const image = {
    type: "image" as const,
    mimeType: "image/png",
    data: createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 }).toString("base64"),
  };
  const prepared = await detectAndLoadAgentHarnessPromptImages({
    prompt: "Describe the color.",
    workspaceDir: process.cwd(),
    model: registered.model,
    existingImages: [image],
  });
  expect(prepared.images).toHaveLength(1);
  expect(registered.model).toMatchObject({
    id: FLASH,
    input: ["text", "image"],
    contextWindow: 900_000,
    maxTokens: 120_000,
    cost: { input: 0.37, output: 1.41, cacheRead: 0.011, cacheWrite: 0 },
  });
  const { body } = await capture(registered)(
    { ...forceTool, reasoning: "low" },
    {
      ...toolContext,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Call live_probe." }, ...prepared.images],
          timestamp: 0,
        },
      ],
    },
  );
  expect(body.messages).toContainEqual(
    expect.objectContaining({
      role: "user",
      content: expect.arrayContaining([
        { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } },
      ]),
    }),
  );
});
