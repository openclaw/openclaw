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
      expect(profile?.levels.map((level) => level.id)).toEqual([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      expect(
        resolveThinkingProfile({
          provider: "meta",
          modelId: model.id,
        })?.defaultLevel,
      ).toBe("high");
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
