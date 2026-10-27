import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { attachModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderContext,
} from "openclaw/plugin-sdk/llm";
import {
  createRuntimeEnv,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  resolveAgentModelPrimaryValue,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { createCapturedThinkingConfigStream } from "openclaw/plugin-sdk/provider-test-contracts";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { beforeAll, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { wrapMoonshotStream } from "./native-video.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  MOONSHOT_BASE_URL,
  MOONSHOT_CN_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_ID,
  MOONSHOT_DEFAULT_MODEL_REF,
} from "./provider-catalog.js";

let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
beforeAll(async () => {
  provider = await registerSingleProviderPlugin(plugin);
});

async function applyConfig(methodId: string, config: OpenClawConfig) {
  const runNonInteractive = provider.auth.find(
    (method) => method.id === methodId,
  )!.runNonInteractive!;
  const toApiKeyCredential = vi.fn(() => null);
  const result = await runNonInteractive({
    authChoice: methodId === "api-key-cn" ? "moonshot-api-key-cn" : "moonshot-api-key",
    config,
    baseConfig: config,
    opts: {},
    runtime: createRuntimeEnv(),
    resolveApiKey: async () => ({ key: "stored-test-key", source: "profile" }),
    toApiKeyCredential,
  });
  expect(toApiKeyCredential).not.toHaveBeenCalled();
  return result!;
}

describe("moonshot provider plugin", () => {
  it.each([
    ["api-key", MOONSHOT_BASE_URL, "replace"],
    ["api-key-cn", MOONSHOT_CN_BASE_URL, "replace"],
    ["api-key", MOONSHOT_BASE_URL, undefined],
    ["api-key", MOONSHOT_BASE_URL, "merge"],
  ] as const)("applies %s config at %s with mode %s", async (methodId, baseUrl, mode) => {
    const config = await applyConfig(methodId, { models: { mode } });
    const catalog = config.models?.providers?.moonshot;
    expect(MOONSHOT_DEFAULT_MODEL_ID).toBe(manifest.modelCatalog.providers.moonshot.defaultModel);
    expect(catalog?.baseUrl).toBe(baseUrl);
    expect(catalog?.models.map((model) => model.id)).toEqual(
      mode === "replace" ? [MOONSHOT_DEFAULT_MODEL_ID] : [],
    );
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      MOONSHOT_DEFAULT_MODEL_REF,
    );
    expect(config.agents?.defaults?.models).toEqual({
      [MOONSHOT_DEFAULT_MODEL_REF]: { alias: "Kimi" },
    });
    expect(await applyConfig(methodId, config)).toEqual(config);
  });

  it("declares shipped Moonshot provider aliases in runtime and manifest metadata", () => {
    expect(provider.aliases).toEqual(["moonshotai", "moonshot-ai"]);
    expect(manifest.providerAuthAliases).toEqual({
      moonshotai: "moonshot",
      "moonshot-ai": "moonshot",
    });
  });

  it("rewrites duplicate tool-call ids with OpenAI-style ids for Moonshot replay", () => {
    const policy = provider.buildReplayPolicy?.({
      provider: "moonshot",
      modelApi: "openai-completions",
      modelId: "kimi-k2.6",
    } as never);
    expect(policy).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      duplicateToolCallIdStyle: "openai",
    });
    expect(policy).not.toHaveProperty("dropReasoningFromHistory");
  });

  it("keeps inherited object keys outside the always-thinking model family", () => {
    const ref = { provider: "moonshot", modelId: "constructor" };
    const captured = createCapturedThinkingConfigStream();
    expect(provider.isModernModelRef?.(ref)).toBe(false);
    expect(provider.resolveThinkingProfile?.({ ...ref, reasoning: true })).toEqual({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
      defaultLevel: "off",
    });
    expect(provider.wrapSimpleCompletionStreamFn?.({ ...ref, streamFn: captured.streamFn })).toBe(
      captured.streamFn,
    );
  });

  it("removes native video from a userinfo route", () => {
    const model = makeModel("kimi-k3", "https://u@api.moonshot.ai/v1");
    expect(provider.normalizeResolvedModel?.({ ...route, model } as never)?.input).toEqual([
      "text",
      "image",
    ]);
  });

  it.each(["kimi-k3", "kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"])(
    "gives %s native video and always-max thinking",
    async (id) => {
      const model = makeModel(id);
      const ref = { provider: model.provider, modelId: model.id };
      expect(
        provider.normalizeResolvedModel?.({
          ...ref,
          model: { ...model, input: ["text", "image"] },
        } as never)?.input,
      ).toEqual(["text", "image", "video"]);
      const captured = createCapturedThinkingConfigStream();
      const wrapped = provider.wrapSimpleCompletionStreamFn?.({
        ...ref,
        thinkingLevel: "off",
        streamFn: captured.streamFn,
      } as never);
      await wrapped?.(model as Model<"openai-completions">, { messages: [] } as Context, {});
      expect(captured.getCapturedPayload()).toEqual({
        config: { thinkingConfig: { thinkingBudget: -1 } },
        reasoning_effort: "max",
      });
      expect(provider.resolveThinkingProfile?.({ ...ref, reasoning: true })).toEqual({
        levels: [{ id: "max", label: "max" }],
        defaultLevel: "max",
        preserveWhenCatalogReasoningFalse: true,
      });
      expect(provider.isModernModelRef?.(ref)).toBe(true);
    },
  );
});

const MP4_A = "data:video/mp4;base64,YWFhYWFhYWFhYWFhYWFhYQ==";
const MP4_B = "data:video/mp4;base64,YmJiYmJiYmJiYmJiYmJiYg==";
const WEBM = "data:video/webm;base64,d2VibQ==";
const route = { provider: "moonshot", modelId: "kimi-k3" };

function makeModel(id = "kimi-k3", baseUrl = MOONSHOT_BASE_URL): Model {
  return {
    id,
    name: "Kimi K3",
    provider: "moonshot",
    api: "openai-completions",
    baseUrl,
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
  await wrapped(makeModel(), { messages: [] } as Context, { onPayload });
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
  await withServer(
    (request, response) => {
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
    },
    async (origin) => {
      const transport = createOpenAICompletionsTransportStreamFn();
      const transportModel = attachModelProviderRequestTransport(
        { ...makeModel(), provider: "custom", baseUrl: `${origin}/v1` },
        { allowPrivateNetwork: true },
      );
      const streamFn: StreamFn = (_model, context, options) =>
        transport(transportModel, context, options);
      const wrapped = expectDefined(
        provider.wrapStreamFn!({
          ...route,
          thinkingLevel: "off",
          streamFn,
        } as never),
        "Moonshot stream wrapper",
      );
      const message: ProviderContext["messages"][number] = {
        role: "user",
        content: [
          { type: "text", text: "before" },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
          { type: "video", mimeType: "video/mp4", data: "YWFhYWFhYWFhYWFhYWFhYQ==" },
          { type: "text", text: "after" },
        ],
        timestamp: 1,
      };
      let callerPayload: unknown;
      const stream = await wrapped(makeModel(), { messages: [message] } as never, {
        apiKey: "test-key",
        onPayload: (payload) => {
          callerPayload = payload;
        },
      });
      await stream.result();
      const body = JSON.stringify(callerPayload);
      expect(body).not.toMatch(/__openclaw|\/private\//u);
      expect(body).toContain(MP4_A);
      expect(requestBody).toHaveProperty(
        "messages.0.content",
        genericPayload().messages[0]!.content,
      );
    },
  );
});
