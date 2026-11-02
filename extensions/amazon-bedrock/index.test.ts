import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bedrockModel,
  checkpoint,
  runtimeUser,
  wireText,
  wireUser,
} from "./bedrock.test-support.js";
import amazonBedrockPlugin from "./index.js";

type InferenceProfileResult =
  | { models: Array<{ modelArn: string }> }
  | { stall: (signal: AbortSignal) => void };
const inferenceProfileGetResults: InferenceProfileResult[] = [];
const bedrockClientConfigs: Array<Record<string, unknown>> = [];
const destroyBedrockClient = vi.fn();
const ANTHROPIC_MODEL = "us.anthropic.claude-sonnet-4-6-v1";
const NON_ANTHROPIC_MODEL = "amazon.nova-sonic-v1:0";
const BEDROCK_RUNTIME_CONTEXT = "OpenClaw runtime context:\nTransient context";
const profileArn = (name: string, region = "us-east-1") =>
  `arn:aws:bedrock:${region}:123456789012:application-inference-profile/${name}`;
const APP_INFERENCE_PROFILE_ARN = profileArn("my-claude-profile");
const profileTargets = (...targets: string[]): InferenceProfileResult => ({
  models: targets.map((target) => ({
    modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${target}`,
  })),
});

const sendBedrockCommand = vi.fn(
  async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
    if (command?.constructor?.name === "ListFoundationModelsCommand") {
      return {
        modelSummaries: [
          {
            modelId: NON_ANTHROPIC_MODEL,
            modelName: "Nova Sonic",
            providerName: "Amazon",
            inputModalities: ["TEXT"],
            outputModalities: ["TEXT"],
            responseStreamingSupported: true,
            modelLifecycle: { status: "ACTIVE" },
          },
        ],
      };
    }
    if (command?.constructor?.name === "ListInferenceProfilesCommand") {
      return { inferenceProfileSummaries: [] };
    }
    const next = inferenceProfileGetResults.shift();
    if (next && "stall" in next) {
      const signal = options?.abortSignal;
      if (!signal) {
        throw new Error("expected Bedrock control-plane abort signal");
      }
      next.stall(signal);
      return await new Promise<never>((_resolve, reject) => {
        const rejectFromSignal = () => {
          const reason = signal.reason;
          reject(reason instanceof Error ? reason : new Error("Bedrock request aborted"));
        };
        if (signal.aborted) {
          rejectFromSignal();
        } else {
          signal.addEventListener("abort", rejectFromSignal, { once: true });
        }
      });
    }
    return next ?? profileTargets("anthropic.claude-sonnet-4-6");
  },
);

vi.mock("@aws-sdk/client-bedrock", () => {
  class GetInferenceProfileCommand {
    constructor(readonly input: { inferenceProfileIdentifier: string }) {}
  }
  class ListFoundationModelsCommand {
    constructor(readonly input: Record<string, unknown> = {}) {}
  }
  class ListInferenceProfilesCommand {
    constructor(readonly input: Record<string, unknown> = {}) {}
  }
  class BedrockClient {
    constructor(config: Record<string, unknown> = {}) {
      bedrockClientConfigs.push(config);
    }
    send = sendBedrockCommand;
    destroy = destroyBedrockClient;
  }
  return {
    BedrockClient,
    GetInferenceProfileCommand,
    ListFoundationModelsCommand,
    ListInferenceProfilesCommand,
  };
});

type RegisteredProviderPlugin = Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
function registerWithConfig(
  pluginConfig?: Record<string, unknown>,
): Promise<RegisteredProviderPlugin> {
  return registerSingleProviderPlugin({
    register(api) {
      amazonBedrockPlugin.register({ ...api, pluginConfig });
    },
  });
}
function runtimePluginConfig(config?: Record<string, unknown>): OpenClawConfig {
  return { plugins: { entries: config ? { "amazon-bedrock": { config } } : {} } } as OpenClawConfig;
}
function descriptor(id: string, overrides: Partial<Model> = {}): never {
  return { api: "openai-completions", provider: "amazon-bedrock", id, ...overrides } as never;
}
function cachePayload(
  text = "Hello",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...overrides,
    system: [wireText("You are helpful.")],
    messages: [wireUser(wireText(text))],
  };
}

async function callStream(
  {
    provider,
    modelId = NON_ANTHROPIC_MODEL,
    model,
    config,
    extraParams,
    thinkingLevel,
    options = {},
    context = { messages: [] },
  }: {
    provider?: RegisteredProviderPlugin;
    modelId?: string;
    model?: Model;
    config?: OpenClawConfig;
    extraParams?: Record<string, unknown>;
    thinkingLevel?: string;
    options?: Record<string, unknown>;
    context?: Context;
  },
  payload?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const streamModel = model ?? descriptor(modelId);
  const registered = provider ?? (await registerWithConfig());
  const wrapped = registered.wrapStreamFn?.({
    provider: "amazon-bedrock",
    modelId,
    model,
    config,
    extraParams,
    thinkingLevel,
    streamFn: (_model: unknown, _context: unknown, opts: Record<string, unknown>) => opts,
  } as never);
  const result = wrapped?.(streamModel, context, options) as unknown as Record<string, unknown>;
  if (payload && typeof result?.onPayload === "function") {
    await (result.onPayload as (p: Record<string, unknown>, model: unknown) => Promise<unknown>)(
      payload,
      streamModel,
    );
    if (Object.keys(payload).length > 0) {
      return { ...result, capturedPayload: payload };
    }
  }
  return result;
}
async function callBedrockConverse(
  extraParams: Record<string, unknown>,
  payload: Record<string, unknown> = {},
  modelId = NON_ANTHROPIC_MODEL,
) {
  return callStream(
    {
      modelId,
      model: descriptor(modelId, { api: "bedrock-converse-stream" }),
      config: runtimePluginConfig(),
      extraParams,
    },
    payload,
  );
}
async function patchProfile(
  payload: Record<string, unknown>,
  {
    modelId = APP_INFERENCE_PROFILE_ARN,
    model = descriptor(modelId),
    options = { cacheRetention: "short" },
    context,
    provider,
  }: {
    modelId?: string;
    model?: Model;
    options?: Record<string, unknown>;
    context?: Context;
    provider?: RegisteredProviderPlugin;
  } = {},
) {
  await callStream({ provider, modelId, model, options, context }, payload);
  return payload;
}
function expectClientRegion(region: string) {
  expect(bedrockClientConfigs).toEqual([
    { region, credentialDefaultProvider: expect.any(Function) },
  ]);
}

describe("amazon-bedrock provider plugin", () => {
  beforeEach(() => {
    inferenceProfileGetResults.length = 0;
    bedrockClientConfigs.length = 0;
    destroyBedrockClient.mockClear();
    sendBedrockCommand.mockClear();
  });
  afterAll(() => {
    vi.doUnmock("@aws-sdk/client-bedrock");
    vi.resetModules();
  });

  it("publishes its stream through the provider lifecycle", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    expect(
      provider.createStreamFn?.({ model: { api: "bedrock-converse-stream" } } as never),
    ).toBeTypeOf("function");
    expect(
      provider.createStreamFn?.({ model: { api: "anthropic-messages" } } as never),
    ).toBeUndefined();
  });

  it("returns raw discovery for the host to merge with materialized config", async () => {
    const provider = await registerWithConfig();
    const configured = { models: [{ id: NON_ANTHROPIC_MODEL, input: ["text", "image"] }] };
    const result = await provider.catalog?.run({
      config: { models: { providers: { "amazon-bedrock": configured } } },
      env: { AWS_PROFILE: "default", AWS_REGION: "us-east-1" } as NodeJS.ProcessEnv,
    } as never);
    if (!result || !("provider" in result)) {
      throw new Error("expected single provider catalog result");
    }
    expect(result.provider.baseUrl).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    expect(result.provider.models[0]).toMatchObject({ id: NON_ANTHROPIC_MODEL, input: ["text"] });
  });

  it("normalizes explicit Claude 4.6 rows with native max metadata", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    const modelId = "us.anthropic.claude-opus-4-6-v1";
    const normalize = (model: Model) =>
      provider.normalizeResolvedModel?.({ provider: "amazon-bedrock", modelId, model } as never);
    const normalized = normalize(
      bedrockModel({ id: modelId, name: "Claude Opus 4.6", contextWindow: 1_000_000 }),
    );
    expect(normalized?.thinkingLevelMap).toEqual({ xhigh: null, max: "max" });
    const restricted = normalize({
      ...(normalized as NonNullable<typeof normalized>),
      thinkingLevelMap: { max: null },
    });
    expect(restricted?.thinkingLevelMap).toEqual({ xhigh: null, max: null });
  });

  it("keeps unsupported provider routes disabled with the runtime cache override", async () => {
    await withEnvAsync({ AWS_BEDROCK_FORCE_CACHE: "1" }, async () => {
      expect(await callStream({})).toMatchObject({ cacheRetention: "none" });
    });
  });

  it("omits temperature for canonical Bedrock Opus aliases", async () => {
    const modelId = "production-claude";
    const result = await callStream({
      modelId,
      model: descriptor(modelId, {
        api: "bedrock-converse-stream",
        params: { canonicalModelId: "claude-opus-4-8" },
      }),
      options: { temperature: 0.2, maxTokens: 10 },
    });
    expect(result).toMatchObject({ maxTokens: 10 });
    expect(result).not.toHaveProperty("temperature");
    expect(result).not.toHaveProperty("cacheRetention", "none");
  });

  it("uses plugin discovery region when provider URLs do not encode one", async () => {
    const result = await callStream({
      model: descriptor(NON_ANTHROPIC_MODEL, {
        api: "bedrock-converse-stream",
        baseUrl: "https://bedrock-runtime.internal.example",
      }),
      config: runtimePluginConfig({ discovery: { region: "eu-central-1" } }),
    });
    expect(result).toMatchObject({ region: "eu-central-1" });
  });

  it("preserves Bedrock Opus 4.6 max thinking in the final payload", async () => {
    const modelId = "us.anthropic.claude-opus-4-6-v1";
    const payload = {
      additionalModelRequestFields: {
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
      },
    };
    await callStream(
      {
        modelId,
        thinkingLevel: "max",
        options: { reasoning: "high" },
        model: descriptor(modelId, { api: "bedrock-converse-stream" }),
      },
      payload,
    );
    expect(payload.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
    });
  });

  it("classifies nested Bedrock deprecated-temperature validation as format failover", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    expect(
      provider.classifyFailoverReason?.({
        provider: "amazon-bedrock",
        modelId: "us.anthropic.claude-opus-4-7",
        errorMessage:
          'ValidationException: The model returned the following errors: {"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}',
      } as never),
    ).toBe("format");
  });

  it.each([
    {
      anthropic: true,
      guardrail: {
        guardrailIdentifier: "guardrail-anthropic",
        guardrailVersion: "2",
        streamProcessingMode: "async",
        trace: "disabled",
      },
    },
    {
      anthropic: false,
      guardrail: { guardrailIdentifier: "guardrail-nova", guardrailVersion: "3" },
    },
  ])("injects guardrails with Anthropic=$anthropic", async ({ guardrail, anthropic }) => {
    const result = await callStream(
      {
        provider: await registerWithConfig({ guardrail }),
        modelId: anthropic ? ANTHROPIC_MODEL : NON_ANTHROPIC_MODEL,
      },
      {},
    );
    expect(result.capturedPayload).toEqual({ guardrailConfig: guardrail });
    if (anthropic) {
      expect(result).not.toHaveProperty("cacheRetention", "none");
    } else {
      expect(result).toMatchObject({ cacheRetention: "none" });
    }
  });

  it.each([false, true])(
    "uses current guardrail config after changing startup enabled=%s",
    async (startupEnabled) => {
      const guardrail = { guardrailIdentifier: "configured-guardrail", guardrailVersion: "7" };
      const result = await callStream(
        {
          provider: await registerWithConfig(startupEnabled ? { guardrail } : undefined),
          config: runtimePluginConfig(startupEnabled ? undefined : { guardrail }),
        },
        {},
      );
      expect(result.capturedPayload).toEqual(
        startupEnabled ? undefined : { guardrailConfig: guardrail },
      );
      expect(result).toMatchObject({ cacheRetention: "none" });
    },
  );

  it.each([
    [{ serviceTier: " PRIORITY ", service_tier: "flex" }, {}, "priority"],
    [{ serviceTier: null, service_tier: " FLEX " }, {}, "flex"],
    [{ serviceTier: 42 }, {}, undefined],
    [{ serviceTier: "not-a-tier" }, {}, undefined],
    [{ serviceTier: "priority" }, { serviceTier: { type: "reserved" } }, "reserved"],
  ] as const)(
    "preserves tier input precedence and authored payloads: %j",
    async (params, payload, expected) => {
      const result = await callBedrockConverse(params, { ...payload });
      expect(result.capturedPayload).toEqual(
        expected ? { serviceTier: { type: expected } } : undefined,
      );
      if (!expected) {
        expect(result).not.toHaveProperty("capturedPayload");
      }
    },
  );

  it.each(["fable", "opus", "sonnet"])(
    "omits unsupported service tiers for Claude %s 5",
    async (family) => {
      expect(
        await callBedrockConverse({ serviceTier: "flex" }, {}, `us.anthropic.claude-${family}-5`),
      ).not.toHaveProperty("capturedPayload");
    },
  );

  it("defaults to short cache retention when not explicitly set", async () => {
    const payload = await patchProfile(cachePayload(), { options: {} });
    expect(payload.system).toEqual([wireText("You are helpful."), checkpoint]);
  });

  it("keeps opaque-profile fallback checkpoints before dynamic system context and out of transient history", async () => {
    const payload = {
      system: [wireText("Stable workspace"), wireText("Dynamic suffix")],
      messages: [wireUser(wireText(BEDROCK_RUNTIME_CONTEXT))],
    };
    await patchProfile(payload, {
      options: { cacheRetention: "long" },
      context: {
        systemPrompt: `Stable workspace${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [runtimeUser(BEDROCK_RUNTIME_CONTEXT, 0)],
      },
    });
    expect(payload.system).toEqual([
      wireText("Stable workspace"),
      { cachePoint: { type: "default", ttl: "1h" } },
      wireText("Dynamic suffix"),
    ]);
    expect(payload.messages[0]?.content).toEqual([wireText(BEDROCK_RUNTIME_CONTEXT)]);
  });

  it("leaves canonical-profile runtime checkpoints unchanged", async () => {
    const payload = {
      system: [wireText("Stable workspace"), checkpoint, wireText("Dynamic suffix")],
      messages: [
        wireUser(wireText("Stable request"), checkpoint),
        wireUser(wireText(BEDROCK_RUNTIME_CONTEXT)),
      ],
    };
    const expected = structuredClone(payload);
    await patchProfile(payload, {
      model: bedrockModel({
        id: APP_INFERENCE_PROFILE_ARN,
        params: { canonicalModelId: "claude-haiku-4-5" },
      }),
      context: {
        messages: [
          { role: "user", content: "Stable request", timestamp: 0 },
          runtimeUser(BEDROCK_RUNTIME_CONTEXT, 1),
        ],
      },
    });
    expect(payload).toEqual(expected);
  });

  it("keeps the latest two user checkpoints across a large new content batch", async () => {
    const payload = {
      system: [wireText("You are helpful.")],
      messages: [
        wireUser(wireText("First question")),
        { role: "assistant", content: [wireText("Answer")] },
        wireUser(...Array.from({ length: 21 }, (_, index) => wireText(`Follow-up ${index}`))),
      ],
    };
    await patchProfile(payload);
    expect(payload.messages[0]?.content).toEqual([wireText("First question"), checkpoint]);
    expect(payload.messages[1]?.content).toHaveLength(1);
    expect(payload.messages[2]?.content).toHaveLength(22);
    expect(payload.messages[2]?.content.at(-1)).toEqual(checkpoint);
  });

  it("uses the shortest supported cache TTL for mixed opaque targets", async () => {
    inferenceProfileGetResults.push(
      profileTargets("anthropic.claude-sonnet-4-6", "anthropic.claude-3-7-sonnet-20250219-v1:0"),
    );
    const payload = await patchProfile(cachePayload(), {
      modelId: profileArn("cache-ttl-mixed"),
      options: { cacheRetention: "long" },
    });
    expect(payload.system).toEqual([wireText("You are helpful."), checkpoint]);
    expect(payload.messages).toEqual([wireUser(wireText("Hello"), checkpoint)]);
    expectClientRegion("us-east-1");
    expect(destroyBedrockClient).toHaveBeenCalledTimes(1);
  });

  it("omits temperature after resolving an unnamed opaque profile", async () => {
    inferenceProfileGetResults.push({
      models: [
        { modelArn: "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-opus-4.7-v1:0" },
      ],
    });
    const payload = await patchProfile(
      cachePayload("Hello", { inferenceConfig: { temperature: 0.3, maxTokens: 10 } }),
      {
        modelId: profileArn("opus-temperature-unnamed", "us-west-2"),
        options: { temperature: 0.3, maxTokens: 10, cacheRetention: "none" },
      },
    );
    expect(payload.inferenceConfig).toEqual({ maxTokens: 10 });
    expectClientRegion("us-west-2");
  });

  it("keeps opaque profile caching disabled when a target is not Claude", async () => {
    inferenceProfileGetResults.push(
      profileTargets("anthropic.claude-sonnet-4-6-20250514-v1:0", "amazon.nova-pro-v1:0"),
    );
    const payload = await patchProfile(cachePayload(), { modelId: profileArn("opaque-nova") });
    expect(payload.system).toEqual([wireText("You are helpful.")]);
    expect(payload.messages).toEqual([wireUser(wireText("Hello"))]);
  });

  it("times out stalled profile lookup, destroys its client, and retries next request", async () => {
    vi.useFakeTimers();
    try {
      const modelId = profileArn("timeout-retry");
      const firstStarted = createDeferred<AbortSignal>();
      inferenceProfileGetResults.push(
        { stall: firstStarted.resolve },
        profileTargets("anthropic.claude-sonnet-4-6-20250514-v1:0"),
      );
      const provider = await registerWithConfig();
      const firstPayload = cachePayload();
      const firstRequest = patchProfile(firstPayload, { provider, modelId });
      const firstSignal = await firstStarted.promise;
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(firstRequest).resolves.toBe(firstPayload);
      expect(firstSignal.aborted).toBe(true);
      expect(firstSignal.reason).toMatchObject({ name: "TimeoutError" });
      expect(firstPayload.system).toEqual([wireText("You are helpful.")]);
      expect(destroyBedrockClient).toHaveBeenCalledTimes(1);
      const secondPayload = await patchProfile(cachePayload("Hello again"), { provider, modelId });
      expect(secondPayload.system).toEqual([wireText("You are helpful."), checkpoint]);
      expect(sendBedrockCommand).toHaveBeenCalledTimes(2);
      expect(destroyBedrockClient).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves caller cancellation across both profile lookup paths", async () => {
    for (const name of ["opaque-abort", "claude-abort"]) {
      const started = createDeferred<AbortSignal>();
      inferenceProfileGetResults.push({ stall: started.resolve });
      const controller = new AbortController();
      const reason = new Error(`caller cancelled ${name}`);
      const request = patchProfile(
        cachePayload("Hello", { inferenceConfig: { temperature: 0.3 } }),
        {
          modelId: profileArn(name),
          options: { cacheRetention: "short", temperature: 0.3, signal: controller.signal },
        },
      );
      await started.promise;
      controller.abort(reason);
      await expect(request).rejects.toBe(reason);
    }
    expect(sendBedrockCommand).toHaveBeenCalledTimes(2);
    expect(destroyBedrockClient).toHaveBeenCalledTimes(2);
  });
});
