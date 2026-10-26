import {
  configureAiTransportHost,
  createApiRegistry,
  createAssistantMessageEventStream,
  createLlmRuntime,
  getAiTransportHost,
  type Api,
  type AssistantMessageEventStreamContract,
} from "@openclaw/ai";
import { prepareModelForSimpleCompletion } from "@openclaw/ai/transports";
import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { getApiProvider, streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompatibleLiveModels } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMetaProvider } from "./api.js";
import plugin from "./index.js";
import { applyMetaConfig } from "./onboard.js";

const CATALOG_CAP_MODEL_ID = "muse-spark-1.3";
const initialAiTransportHost = getAiTransportHost();

function captureProvider() {
  return expectDefined(capturePluginRegistration(plugin).providers[0], "Meta provider");
}

function captureThinkingResolver() {
  return expectDefined(captureProvider().resolveThinkingProfile, "Meta thinking profile");
}

function captureCompletionWrapper() {
  return expectDefined(captureProvider().wrapSimpleCompletionStreamFn, "Meta completion hook");
}

function resolveCatalogModel(modelId: string): Model<"openai-responses"> {
  const provider = buildMetaProvider();
  const model = provider.models.find((entry) => entry.id === modelId);
  return {
    provider: "meta",
    baseUrl: provider.baseUrl,
    ...expectDefined(model, modelId),
    api: "openai-responses",
  } as Model<"openai-responses">;
}

function projectedModel(): Model {
  return {
    ...resolveCatalogModel(CATALOG_CAP_MODEL_ID),
    api: "openclaw-provider-stream:meta:muse-spark-1.3",
  } as Model;
}

function wrapCompletion(model: Model, streamFn: StreamFn, sourceApi?: Api) {
  const hook = captureCompletionWrapper();
  return expectDefined(
    hook({ provider: "meta", modelId: model.id, model, sourceApi, streamFn }),
    "Meta Responses stream wrapper",
  );
}

function captureHttp() {
  const completed = {
    type: "response.completed",
    response: {
      id: "resp_meta_catalog_cap",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
    },
  };
  let requestBody: unknown;
  let requestUrl: string | undefined;
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init);
    requestUrl = request.url;
    requestBody = await request.json();
    return new Response(`data: ${JSON.stringify(completed)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return () => {
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestUrl).toBe("https://api.meta.ai/v1/responses");
    expect(requestBody).toMatchObject({ store: false, include: ["reasoning.encrypted_content"] });
    return requestBody;
  };
}

function requireSynchronousStream(
  stream: ReturnType<StreamFn>,
): AssistantMessageEventStreamContract {
  expect(stream).not.toBeInstanceOf(Promise);
  return stream as AssistantMessageEventStreamContract;
}

describe("meta provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    configureAiTransportHost(initialAiTransportHost);
  });

  it.each([
    { primary: "meta/muse-spark-1.3", authored: false, wonder: { alias: "Muse Wonder" } },
    {
      primary: "meta/muse-spark-1.2",
      authored: true,
      wonder: { alias: "Wonder Work", params: { temperature: 0.7 } },
    },
  ])(
    "applies onboarding defaults without overwriting authored settings ($authored)",
    ({ primary, authored, wonder }) => {
      const config = applyMetaConfig(
        authored
          ? {
              agents: {
                defaults: { model: { primary }, models: { "meta/muse-wonder-1.0": wonder } },
              },
            }
          : {},
      );
      expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(primary);
      expect(config.agents?.defaults?.models?.["meta/muse-wonder-1.0"]).toEqual(wonder);
      expect(config.agents?.defaults?.models?.["meta/muse-spark-1.3"]).toEqual({
        alias: "Muse Spark 1.3",
      });
    },
  );

  it("publishes and projects Wonder Standard capabilities without API-only variants", () => {
    const provider = buildMetaProvider();
    const wonder = {
      id: "muse-wonder-1.0",
      name: "Muse Wonder",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      thinkingLevelMap: { off: "minimal", max: "max" },
      compat: {
        supportsTools: true,
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
      },
      cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
    };
    expect(provider.models[0]).toMatchObject(wonder);
    expect(provider.models.map((model) => model.id)).not.toContain("muse-wonder-full-1.0");
    expect(provider.models.map((model) => model.id)).not.toContain("muse-wonder-1.0-contributor");
    const models = buildOpenAICompatibleLiveModels(
      [
        { id: "muse-wonder-1.0", object: "model", created: 2 },
        { id: "muse-spark-1.3", object: "model", created: 1 },
      ],
      provider,
    );
    // Shared discovery sorts IDs; it does not preserve Meta's newest-first wire order.
    expect(models.map((model) => model.id)).toEqual(["muse-spark-1.3", "muse-wonder-1.0"]);
    expect(models[1]).toMatchObject(wonder);
  });

  it("does not wrap projected non-Responses Meta models for either stream hook", () => {
    const provider = captureProvider();
    const model = projectedModel();

    for (const hook of [provider.wrapStreamFn, provider.wrapSimpleCompletionStreamFn]) {
      const streamHook = expectDefined(hook, "Meta stream hook");
      const wrapped = streamHook({
        provider: "meta",
        modelId: model.id,
        model,
        sourceApi: "openai-completions",
        streamFn: () => createAssistantMessageEventStream(),
      });

      expect(wrapped).toBeUndefined();
    }
  });

  it.each([
    [CATALOG_CAP_MODEL_ID, undefined, undefined, undefined, undefined],
    [CATALOG_CAP_MODEL_ID, 0, 131072, undefined, undefined],
    ["muse-wonder-1.0", 4096, 4096, "off", "minimal"],
    ["muse-wonder-1.0", 4096, 4096, "max", "max"],
  ] as const)(
    "sends %s with cap %s (wire %s), reasoning %s (wire %s)",
    async (modelId, cap, expectedCap, level, effort) => {
      const readRequest = captureHttp();
      const model = cap === 0 ? projectedModel() : resolveCatalogModel(modelId);
      const sourceApi = cap === 0 ? "openai-responses" : undefined;
      const source: StreamFn = (wireModel, context, options) =>
        streamSimple({ ...wireModel, api: "openai-responses" }, context, options);
      const stream = await wrapCompletion(model, source, sourceApi)(
        model,
        { messages: [] },
        {
          apiKey: "unit-test-token",
          maxTokens: cap,
          reasoning: level,
        },
      );
      const result = await stream.result();
      expect(result.stopReason).toBe("stop");
      expect(result.errorMessage).toBeUndefined();
      const body = readRequest();
      expect(body).toMatchObject({ model: modelId });
      if (expectedCap === undefined) {
        expect(body).not.toHaveProperty("max_output_tokens");
      } else {
        expect(body).toHaveProperty("max_output_tokens", expectedCap);
      }
      if (effort) {
        expect(body).toHaveProperty("reasoning.effort", effort);
      }
    },
  );

  it("preserves Meta replay fields through canonical simple-completion aliases", async () => {
    const wrapStream = captureCompletionWrapper();
    const registry = createApiRegistry();
    const runtime = createLlmRuntime(registry);
    const base = resolveCatalogModel(CATALOG_CAP_MODEL_ID);
    const readRequest = captureHttp();
    registry.registerApiProvider(expectDefined(getApiProvider("openai-responses"), "Responses"));
    configureAiTransportHost({
      ...initialAiTransportHost,
      registerCustomApi: (apiRegistry, api, streamFn) => {
        const customStream = (...args: Parameters<StreamFn>) =>
          requireSynchronousStream(streamFn(...args));
        apiRegistry.registerApiProvider({
          api,
          stream: customStream,
          streamSimple: customStream,
        });
        return true;
      },
      plugin: {
        ...initialAiTransportHost.plugin,
        resolveProviderStream: () => undefined,
        wrapSimpleCompletionStream: ({ context: { provider, modelId, model, streamFn } }) =>
          wrapStream({ provider, modelId, model, streamFn }) ?? undefined,
      },
    });

    const preparedModel = prepareModelForSimpleCompletion({ apiRegistry: registry, model: base });
    expect(preparedModel.api).toMatch(/^openclaw-provider-simple:/);

    const result = await runtime.completeSimple(
      preparedModel,
      { messages: [] },
      { apiKey: "unit-test-token" },
    );

    expect(result.stopReason).toBe("stop");
    expect(readRequest()).not.toHaveProperty("max_output_tokens");
  });

  it("resolves max-capable and standard thinking profiles with catalog fallback", () => {
    const resolveProfile = captureThinkingResolver();
    for (const modelId of ["muse-wonder-1.0", "muse-spark-1.2"]) {
      const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
      if (modelId === "muse-wonder-1.0") {
        levels.push("max");
      }
      for (const reasoning of [true, undefined]) {
        const profile = resolveProfile({ provider: "meta", modelId, reasoning });
        expect(profile?.defaultLevel).toBe("high");
        expect(profile?.levels.map((level) => level.id)).toEqual(levels);
      }
    }
  });

  it("respects an authored max-effort restriction", () => {
    const resolveProfile = captureThinkingResolver();
    for (const overrides of [
      { thinkingLevelMap: { max: null } },
      { compat: { supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"] } },
    ]) {
      const profile = resolveProfile({
        provider: "meta",
        modelId: "muse-wonder-1.0",
        ...overrides,
      });
      expect(profile?.levels.map((level) => level.id)).not.toContain("max");
    }
  });

  it("respects an explicit non-reasoning catalog fact", () => {
    const resolveProfile = captureThinkingResolver();
    expect(
      resolveProfile({ provider: "meta", modelId: "muse-spark-1.2", reasoning: false }),
    ).toBeUndefined();
  });
});
