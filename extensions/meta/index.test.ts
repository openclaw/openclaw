import {
  configureAiTransportHost,
  createApiRegistry,
  createAssistantMessageEventStream,
  createLlmRuntime,
  getAiTransportHost,
  type Api,
  type AssistantMessageEventStreamContract,
  type SimpleStreamOptions,
  type StreamFunction,
} from "@openclaw/ai";
import { prepareModelForSimpleCompletion } from "@openclaw/ai/transports";
import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompatibleLiveModels } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMetaProvider } from "./api.js";
import plugin from "./index.js";
import { applyMetaConfig } from "./onboard.js";
import { wrapMetaProviderStream } from "./stream.js";

const CATALOG_CAP_MODEL_ID = "muse-spark-1.3";
const initialAiTransportHost = getAiTransportHost();

function captureProvider() {
  return expectDefined(capturePluginRegistration(plugin).providers[0], "Meta provider");
}

function captureCompletionWrapper() {
  return expectDefined(captureProvider().wrapSimpleCompletionStreamFn, "Meta completion hook");
}

function resolveCatalogModel(modelId: string): Model<"openai-responses"> {
  const provider = buildMetaProvider();
  const catalogModel = provider.models.find((model) => model.id === modelId);
  if (!catalogModel) {
    throw new Error(`Expected ${modelId} in Meta catalog`);
  }
  return {
    provider: "meta",
    baseUrl: provider.baseUrl,
    ...catalogModel,
    api: "openai-responses",
  } as Model<"openai-responses">;
}

function completedSseResponse(): Response {
  const completed = {
    type: "response.completed",
    response: {
      id: "resp_meta_catalog_cap",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
    },
  };
  return new Response(`data: ${JSON.stringify(completed)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function requireSynchronousStream(
  stream: ReturnType<StreamFn>,
): AssistantMessageEventStreamContract {
  if (
    stream instanceof Promise ||
    !("push" in stream) ||
    !("end" in stream) ||
    typeof stream.push !== "function" ||
    typeof stream.end !== "function"
  ) {
    throw new Error("Expected synchronous assistant event stream");
  }
  return stream as AssistantMessageEventStreamContract;
}

describe("meta provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    configureAiTransportHost(initialAiTransportHost);
  });

  it("applies Muse Spark 1.3 as the onboarding default and alias", () => {
    const config = applyMetaConfig({});

    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      "meta/muse-spark-1.3",
    );
    expect(config.agents?.defaults?.models?.["meta/muse-spark-1.3"]).toEqual({
      alias: "Muse Spark 1.3",
    });
    expect(config.agents?.defaults?.models?.["meta/muse-wonder-1.0"]).toEqual({
      alias: "Muse Wonder",
    });
  });

  it("publishes Wonder Standard without inventing API-only Full or Contributor variants", () => {
    const provider = buildMetaProvider();
    expect(provider.models[0]).toMatchObject({
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
    });
    expect(provider.models.map((model) => model.id)).not.toContain("muse-wonder-full-1.0");
    expect(provider.models.map((model) => model.id)).not.toContain("muse-wonder-1.0-contributor");
  });

  it("preserves an authored primary model and Wonder alias during setup", () => {
    const config = applyMetaConfig({
      agents: {
        defaults: {
          model: { primary: "meta/muse-spark-1.2" },
          models: {
            "meta/muse-wonder-1.0": { alias: "Wonder Work", params: { temperature: 0.7 } },
          },
        },
      },
    });
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      "meta/muse-spark-1.2",
    );
    expect(config.agents?.defaults?.models?.["meta/muse-wonder-1.0"]).toEqual({
      alias: "Wonder Work",
      params: { temperature: 0.7 },
    });
  });

  it("retains Wonder capabilities and prices when projecting authenticated catalog rows", () => {
    const models = buildOpenAICompatibleLiveModels(
      [
        { id: "muse-wonder-1.0", object: "model", created: 2 },
        { id: "muse-spark-1.3", object: "model", created: 1 },
      ],
      buildMetaProvider(),
    );
    // Shared discovery sorts IDs; it does not preserve Meta's newest-first wire order.
    expect(models.map((model) => model.id)).toEqual(["muse-spark-1.3", "muse-wonder-1.0"]);
    expect(models[1]).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_048_576,
      thinkingLevelMap: { max: "max" },
      cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
    });
  });

  it("does not wrap projected non-Responses Meta models for either stream hook", () => {
    const provider = captureProvider();
    const model = {
      ...resolveCatalogModel(CATALOG_CAP_MODEL_ID),
      api: "openclaw-provider-stream:meta:muse-spark-1.3",
    } as Model;

    for (const hook of [provider.wrapStreamFn, provider.wrapSimpleCompletionStreamFn]) {
      if (!hook) {
        throw new Error("Expected Meta stream hook");
      }
      const wrapped = hook({
        provider: "meta",
        modelId: model.id,
        model,
        sourceApi: "openai-completions",
        streamFn: () => createAssistantMessageEventStream(),
      });

      expect(wrapped).toBeUndefined();
    }
  });

  it("wraps projected direct completions from a Responses source API", () => {
    const wrapStream = captureCompletionWrapper();
    const model = {
      ...resolveCatalogModel(CATALOG_CAP_MODEL_ID),
      api: "openclaw-provider-stream:meta:muse-spark-1.3",
    } as Model;
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (streamModel, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload, streamModel);
      capturedPayload = payload;
      return createAssistantMessageEventStream();
    };
    const wrapped = wrapStream({
      provider: "meta",
      modelId: model.id,
      model,
      sourceApi: "openai-responses",
      streamFn: baseStreamFn,
    });
    if (!wrapped) {
      throw new Error("Expected projected Meta Responses stream wrapper");
    }

    void wrapped(model, { messages: [] }, { maxTokens: 0 });

    expect(capturedPayload).toMatchObject({
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 131072,
      store: false,
    });
  });

  it.each([undefined, 4096])(
    "preserves the caller output cap %s through Responses",
    async (maxTokens) => {
      const model = resolveCatalogModel(CATALOG_CAP_MODEL_ID);
      let capturedPayload: Record<string, unknown> | undefined;
      const fetchMock = vi.fn(async () => completedSseResponse());
      vi.stubGlobal("fetch", fetchMock);
      const streamFn = wrapMetaProviderStream({
        provider: "meta",
        modelId: model.id,
        model,
        streamFn: streamSimple,
      });
      if (!streamFn) {
        throw new Error("Expected Meta Responses stream wrapper");
      }

      const context: Context = {
        messages: [{ role: "user", content: "Catalog cap probe", timestamp: 0 }],
      };
      const stream = await streamFn(model, context, {
        apiKey: "unit-test-token",
        maxTokens,
        onPayload: (payload) => {
          capturedPayload = payload as Record<string, unknown>;
        },
      });
      const result = await stream.result();

      expect(result.stopReason).toBe("stop");
      expect(fetchMock).toHaveBeenCalledOnce();
      if (maxTokens === undefined) {
        expect(capturedPayload).not.toHaveProperty("max_output_tokens");
      } else {
        expect(capturedPayload?.max_output_tokens).toBe(maxTokens);
      }
    },
  );

  it.each([
    { level: "off", wireEffort: "minimal" },
    { level: "max", wireEffort: "max" },
  ] as const)(
    "sends Wonder $level as $wireEffort through the Responses transport",
    async ({ level, wireEffort }) => {
      const model = resolveCatalogModel("muse-wonder-1.0");
      let requestBody: Record<string, unknown> | undefined;
      let requestUrl: string | undefined;
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const request = new Request(_url, init);
        requestUrl = request.url;
        requestBody = (await request.json()) as Record<string, unknown>;
        return completedSseResponse();
      });
      vi.stubGlobal("fetch", fetchMock);
      const streamFn = expectDefined(
        captureCompletionWrapper()({
          provider: "meta",
          modelId: model.id,
          model,
          streamFn: streamSimple,
        }),
        "Wonder completion stream",
      );
      const stream = await streamFn(
        model,
        { messages: [{ role: "user", content: "Wonder reasoning probe", timestamp: 0 }] },
        { apiKey: "unit-test-token", reasoning: level, maxTokens: 4096 },
      );
      const result = await stream.result();
      expect(result.errorMessage).toBeUndefined();
      expect(result.stopReason).toBe("stop");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(requestUrl).toBe("https://api.meta.ai/v1/responses");
      expect(requestBody).toMatchObject({
        model: "muse-wonder-1.0",
        reasoning: { effort: wireEffort },
        max_output_tokens: 4096,
        store: false,
        include: ["reasoning.encrypted_content"],
      });
    },
  );

  it("preserves Meta replay fields through canonical simple-completion aliases", async () => {
    const wrapStream = captureCompletionWrapper();

    const registry = createApiRegistry();
    const runtime = createLlmRuntime(registry);
    const sourceModel = resolveCatalogModel(CATALOG_CAP_MODEL_ID);
    let capturedPayload: Record<string, unknown> | undefined;
    let sourceModelApi: Api | undefined;
    const sourceStreamFn: StreamFunction<"openai-responses", SimpleStreamOptions> = (
      streamModel,
      _context,
      options,
    ) => {
      sourceModelApi = streamModel.api;
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload, streamModel);
      capturedPayload = payload;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: { stopReason: "stop" } as never,
        });
        stream.end();
      });
      return stream;
    };
    registry.registerApiProvider({
      api: "openai-responses",
      stream: sourceStreamFn,
      streamSimple: sourceStreamFn,
    });
    configureAiTransportHost({
      ...initialAiTransportHost,
      registerCustomApi: (apiRegistry, api, streamFn) => {
        if (apiRegistry.getApiProvider(api)) {
          return false;
        }
        apiRegistry.registerApiProvider({
          api,
          stream: (streamModel, streamContext, options) =>
            requireSynchronousStream(streamFn(streamModel, streamContext, options)),
          streamSimple: (streamModel, streamContext, options) =>
            requireSynchronousStream(streamFn(streamModel, streamContext, options)),
        });
        return true;
      },
      plugin: {
        ...initialAiTransportHost.plugin,
        resolveProviderStream: () => undefined,
        wrapSimpleCompletionStream: ({ provider: providerId, context }) => {
          if (providerId !== "meta") {
            return undefined;
          }
          const { provider, modelId, model, streamFn } = context;
          return wrapStream({ provider, modelId, model, streamFn }) ?? undefined;
        },
      },
    });

    const preparedModel = prepareModelForSimpleCompletion({
      apiRegistry: registry,
      model: sourceModel,
    });
    expect(preparedModel.api).toMatch(/^openclaw-provider-simple:/);

    const result = await runtime.completeSimple(preparedModel, { messages: [] });

    expect(result.stopReason).toBe("stop");
    expect(sourceModelApi).toBe("openai-responses");
    expect(capturedPayload).toMatchObject({
      store: false,
      include: ["reasoning.encrypted_content"],
    });
    expect(capturedPayload).not.toHaveProperty("max_output_tokens");
  });

  it("advertises a high default thinking profile for every reasoning model", () => {
    const provider = captureProvider();
    const resolveThinkingProfile = expectDefined(
      provider.resolveThinkingProfile,
      "Meta thinking profile resolver",
    );
    const reasoningModels = buildMetaProvider().models.filter((model) => model.reasoning);
    expect(reasoningModels.map((model) => model.id)).toEqual([
      "muse-wonder-1.0",
      "muse-spark-1.3",
      "muse-spark-1.3-contributor",
      "muse-spark-1.2",
      "muse-spark-1.2-contributor",
      "muse-spark-1.1",
    ]);
    for (const model of reasoningModels) {
      const profile = resolveThinkingProfile({
        provider: "meta",
        modelId: model.id,
        reasoning: model.reasoning,
      });
      expect(profile?.defaultLevel).toBe("high");
      const levels = [
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        ...(["muse-wonder-1.0", "muse-spark-1.3"].includes(model.id) ? ["max"] : []),
      ];
      expect(profile?.levels.map((level) => level.id)).toEqual(levels);
      const fallbackProfile = resolveThinkingProfile({
        provider: "meta",
        modelId: model.id,
      });
      expect(fallbackProfile?.defaultLevel).toBe("high");
      expect(fallbackProfile?.levels.map((level) => level.id)).toEqual(levels);
    }
  });

  it("respects an authored max-effort restriction", () => {
    const resolveThinkingProfile = expectDefined(
      captureProvider().resolveThinkingProfile,
      "Meta thinking profile",
    );
    for (const overrides of [
      { thinkingLevelMap: { max: null } },
      { compat: { supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"] } },
    ]) {
      const profile = resolveThinkingProfile({
        provider: "meta",
        modelId: "muse-wonder-1.0",
        ...overrides,
      });
      expect(profile?.levels.map((level) => level.id)).not.toContain("max");
    }
  });

  it("respects an explicit non-reasoning catalog fact", () => {
    const provider = captureProvider();
    const resolveThinkingProfile = expectDefined(
      provider.resolveThinkingProfile,
      "Meta thinking profile resolver",
    );
    expect(
      resolveThinkingProfile({
        provider: "meta",
        modelId: "muse-spark-1.2",
        reasoning: false,
      }),
    ).toBeUndefined();
  });
});
