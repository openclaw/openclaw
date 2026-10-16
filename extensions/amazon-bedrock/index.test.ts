import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bedrockModel, runtimeUser } from "./bedrock.test-support.js";
import amazonBedrockPlugin from "./index.js";

type InferenceProfileResult =
  | { models: Array<{ modelArn: string }> }
  | { stall: (signal: AbortSignal) => void };

const inferenceProfileGetResults: InferenceProfileResult[] = [];
const bedrockClientConfigs: Array<Record<string, unknown>> = [];
const destroyBedrockClient = vi.fn();
const sendBedrockCommand = vi.fn(
  async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
    const commandName = command?.constructor?.name;
    if (commandName === "ListFoundationModelsCommand") {
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
    if (commandName === "ListInferenceProfilesCommand") {
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
    return next ?? { models: [foundationModel("anthropic.claude-sonnet-4-6")] };
  },
);

vi.mock("@aws-sdk/client-bedrock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-bedrock")>()),
  BedrockClient: class {
    constructor(config: Record<string, unknown> = {}) {
      bedrockClientConfigs.push(config);
    }
    send = sendBedrockCommand;
    destroy = destroyBedrockClient;
  },
}));

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

const spyStreamFn = (_model: unknown, _context: unknown, options: Record<string, unknown>) =>
  options;

const ANTHROPIC_MODEL = "us.anthropic.claude-sonnet-4-6-v1";
const NON_ANTHROPIC_MODEL = "amazon.nova-sonic-v1:0";

const MODEL_DESCRIPTOR = modelDescriptor(NON_ANTHROPIC_MODEL);

const profileArn = (id: string, region = "us-east-1") =>
  `arn:aws:bedrock:${region}:123456789012:application-inference-profile/${id}`;
const APP_INFERENCE_PROFILE_ARN = profileArn("my-claude-profile");
const BEDROCK_RUNTIME_CONTEXT = "OpenClaw runtime context:\nTransient context";

function foundationModel(id: string, region = "us-east-1") {
  return { modelArn: `arn:aws:bedrock:${region}::foundation-model/${id}` };
}

function queueProfileTargets(targets: string[], region = "us-east-1") {
  inferenceProfileGetResults.push({
    models: targets.map((target) => foundationModel(target, region)),
  });
}

function modelDescriptor(modelId: string, api = "openai-completions"): never {
  return {
    api,
    provider: "amazon-bedrock",
    id: modelId,
  } as never;
}

async function applyPayload(
  result: Record<string, unknown>,
  payload: Record<string, unknown>,
  model: unknown,
) {
  if (typeof result.onPayload === "function") {
    await result.onPayload(payload, model);
  }
  return payload;
}

function wrappedOptions(
  provider: RegisteredProviderPlugin,
  model: Model,
  options: Record<string, unknown> = {},
  params: Record<string, unknown> = {},
  context: Context = { messages: [] },
): Record<string, unknown> {
  const wrapped = provider.wrapStreamFn?.({
    provider: "amazon-bedrock",
    modelId: model.id,
    streamFn: spyStreamFn,
    ...params,
  } as never);
  return wrapped?.(model, context, options) as unknown as Record<string, unknown>;
}

async function callWrappedStream(
  provider: RegisteredProviderPlugin,
  descriptor: never,
  config?: OpenClawConfig,
  extraParams?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = wrappedOptions(provider, descriptor, {}, { config, extraParams });
  const payload = {};

  if (typeof result?.onPayload === "function") {
    await applyPayload(result, payload, descriptor);
    if (Object.keys(payload).length > 0) {
      return { ...result, capturedPayload: payload };
    }
  }

  return result;
}

function runtimePluginConfig(config?: Record<string, unknown>): OpenClawConfig {
  return {
    plugins: { entries: config ? { "amazon-bedrock": { config } } : {} },
  } as OpenClawConfig;
}

function buildBedrockCachePayload(
  text = "Hello",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...overrides,
    system: [{ text: "You are helpful." }],
    messages: [{ role: "user", content: [{ text }] }],
  };
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
    const models = [{ id: NON_ANTHROPIC_MODEL, input: ["text", "image"] }];

    const result = await provider.catalog?.run({
      config: { models: { providers: { "amazon-bedrock": { models } } } },
      env: { AWS_PROFILE: "default", AWS_REGION: "us-east-1" } as NodeJS.ProcessEnv,
    } as never);

    if (!result || !("provider" in result)) {
      throw new Error("expected single provider catalog result");
    }
    expect(result.provider.baseUrl).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    expect(result.provider.models[0]).toMatchObject({
      id: NON_ANTHROPIC_MODEL,
      input: ["text"],
    });
  });

  it("normalizes explicit Claude 4.6 rows with native max metadata", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);

    const normalized = provider.normalizeResolvedModel?.({
      provider: "amazon-bedrock",
      modelId: "us.anthropic.claude-opus-4-6-v1",
      model: bedrockModel({ id: "us.anthropic.claude-opus-4-6-v1" }),
    } as never);

    expect(normalized?.thinkingLevelMap).toEqual({ xhigh: null, max: "max" });

    const restricted = provider.normalizeResolvedModel?.({
      provider: "amazon-bedrock",
      modelId: "us.anthropic.claude-opus-4-6-v1",
      model: {
        ...(normalized as NonNullable<typeof normalized>),
        thinkingLevelMap: { max: null },
      },
    } as never);

    expect(restricted?.thinkingLevelMap).toEqual({ xhigh: null, max: null });
  });

  it("keeps unsupported provider routes disabled with the runtime cache override", async () => {
    await withEnvAsync({ AWS_BEDROCK_FORCE_CACHE: "1" }, async () => {
      const provider = await registerWithConfig(undefined);
      const result = await callWrappedStream(provider, NON_ANTHROPIC_MODEL, MODEL_DESCRIPTOR);
      expectWrappedResultFields(result, { cacheRetention: "none" });
    });
  });

  it("omits temperature for canonical Bedrock Opus aliases", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    const model = {
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      id: "production-claude",
      params: { canonicalModelId: "claude-opus-4-8" },
    };
    const result = wrappedOptions(
      provider,
      model as never,
      { temperature: 0.2, maxTokens: 10 },
      { model },
    );
    expect(result).toMatchObject({ maxTokens: 10 });
    expect(result).not.toHaveProperty("temperature");
    expect(result).not.toHaveProperty("cacheRetention", "none");
  });

  it("uses plugin discovery region when provider URLs do not encode one", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    const result = wrappedOptions(
      provider,
      MODEL_DESCRIPTOR,
      {},
      {
        model: bedrockModel({
          id: NON_ANTHROPIC_MODEL,
          baseUrl: "https://bedrock-runtime.internal.example",
        }),
        config: runtimePluginConfig({ discovery: { region: "eu-central-1" } }),
      },
    );
    expect(result).toMatchObject({ region: "eu-central-1" });
  });

  it("preserves Bedrock Opus 4.6 max thinking in the final payload", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    const modelId = "us.anthropic.claude-opus-4-6-v1";
    const result = wrappedOptions(
      provider,
      modelDescriptor(modelId, "bedrock-converse-stream"),
      { reasoning: "high" },
      { thinkingLevel: "max" },
    );
    const payload = {
      additionalModelRequestFields: {
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
      },
    };
    await applyPayload(result, payload, undefined);
    expect(payload.additionalModelRequestFields).toEqual({
      output_config: { effort: "max" },
      thinking: { type: "adaptive" },
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

  describe("guardrail payload injection", () => {
    it.each([
      [
        ANTHROPIC_MODEL,
        {
          guardrailIdentifier: "guardrail-anthropic",
          guardrailVersion: "2",
          streamProcessingMode: "async",
          trace: "disabled",
        },
      ],
      [NON_ANTHROPIC_MODEL, { guardrailIdentifier: "guardrail-nova", guardrailVersion: "3" }],
    ] as const)("injects guardrails for %s", async (modelId, guardrail) => {
      const provider = await registerWithConfig({ guardrail });
      const result = await callWrappedStream(provider, modelDescriptor(modelId));
      expect(result.capturedPayload).toEqual({ guardrailConfig: guardrail });
      if (modelId === ANTHROPIC_MODEL) {
        expect(result).not.toHaveProperty("cacheRetention", "none");
      } else {
        expect(result).toMatchObject({ cacheRetention: "none" });
      }
    });

    it.each([false, true])(
      "uses current guardrail config after changing startup enabled=%s",
      async (startupEnabled) => {
        const guardrail = { guardrailIdentifier: "configured-guardrail", guardrailVersion: "7" };
        const provider = await registerWithConfig(startupEnabled ? { guardrail } : undefined);
        const result = await callWrappedStream(
          provider,
          MODEL_DESCRIPTOR,
          runtimePluginConfig(startupEnabled ? undefined : { guardrail }),
        );

        expect(result.capturedPayload).toEqual(
          startupEnabled ? undefined : { guardrailConfig: guardrail },
        );
        expect(result).toMatchObject({ cacheRetention: "none" });
      },
    );
  });

  describe("service tier", () => {
    it.each([
      ["snake-case priority", NON_ANTHROPIC_MODEL, { service_tier: "priority" }, "priority"],
      ["invalid value", NON_ANTHROPIC_MODEL, { serviceTier: "not-a-tier" }, undefined],
      ["fable", "us.anthropic.claude-fable-5", { serviceTier: "flex" }, undefined],
      ["opus", "us.anthropic.claude-opus-5", { serviceTier: "flex" }, undefined],
      ["sonnet", "us.anthropic.claude-sonnet-5", { serviceTier: "flex" }, undefined],
    ] as const)("handles %s", async (_name, modelId, params, tier) => {
      const result = await callWrappedStream(
        await registerWithConfig(),
        modelDescriptor(modelId, "bedrock-converse-stream"),
        runtimePluginConfig(),
        params,
      );
      if (tier) {
        expect(result).toHaveProperty("capturedPayload.serviceTier", { type: tier });
      } else {
        expect(result).not.toHaveProperty("capturedPayload");
      }
    });
  });

  describe("application inference profile cache point injection", () => {
    async function applyProfilePayload(
      payload: Record<string, unknown>,
      {
        provider,
        id = APP_INFERENCE_PROFILE_ARN,
        options = {},
        context = { messages: [] },
        model = modelDescriptor(id),
      }: {
        provider?: RegisteredProviderPlugin;
        id?: string;
        options?: Record<string, unknown>;
        context?: Context;
        model?: Model;
      } = {},
    ) {
      const result = wrappedOptions(
        provider ?? (await registerWithConfig()),
        model,
        options,
        { modelId: id, model },
        context,
      );
      return applyPayload(result, payload, model);
    }

    it("defaults to short cache retention when not explicitly set", async () => {
      const payload = buildBedrockCachePayload();
      await applyProfilePayload(payload);
      expect(payload.system).toEqual([
        { text: "You are helpful." },
        { cachePoint: { type: "default" } },
      ]);
    });

    it("keeps opaque-profile fallback checkpoints before dynamic system context and out of transient history", async () => {
      const payload = {
        system: [{ text: "Stable workspace" }, { text: "Dynamic suffix" }],
        messages: [{ role: "user", content: [{ text: BEDROCK_RUNTIME_CONTEXT }] }],
      };
      await applyProfilePayload(payload, {
        options: { cacheRetention: "long" },
        context: {
          systemPrompt: `Stable workspace${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
          messages: [runtimeUser(BEDROCK_RUNTIME_CONTEXT, 0)],
        },
      });
      expect(payload.system).toEqual([
        { text: "Stable workspace" },
        { cachePoint: { type: "default", ttl: "1h" } },
        { text: "Dynamic suffix" },
      ]);
      expect(payload.messages[0]?.content).toEqual([{ text: BEDROCK_RUNTIME_CONTEXT }]);
    });

    it("leaves canonical-profile runtime checkpoints unchanged", async () => {
      const payload = {
        system: [
          { text: "Stable workspace" },
          { cachePoint: { type: "default" } },
          { text: "Dynamic suffix" },
        ],
        messages: [
          {
            role: "user",
            content: [{ text: "Stable request" }, { cachePoint: { type: "default" } }],
          },
          { role: "user", content: [{ text: BEDROCK_RUNTIME_CONTEXT }] },
        ],
      };
      const expected = structuredClone(payload);
      await applyProfilePayload(payload, {
        options: { cacheRetention: "short" },
        context: {
          messages: [
            { role: "user", content: "Stable request", timestamp: 0 },
            runtimeUser(BEDROCK_RUNTIME_CONTEXT, 1),
          ],
        },
        model: bedrockModel({
          id: APP_INFERENCE_PROFILE_ARN,
          params: { canonicalModelId: "claude-haiku-4-5" },
        }),
      });
      expect(payload).toEqual(expected);
    });

    it("keeps the latest two user checkpoints across a large new content batch", async () => {
      const payload = {
        system: [{ text: "You are helpful." }],
        messages: [
          { role: "user", content: [{ text: "First question" }] },
          { role: "assistant", content: [{ text: "Answer" }] },
          {
            role: "user",
            content: Array.from({ length: 21 }, (_, index) => ({ text: `Follow-up ${index}` })),
          },
        ],
      };

      await applyProfilePayload(payload, { options: { cacheRetention: "short" } });

      expect(payload.messages[0]?.content).toEqual([
        { text: "First question" },
        { cachePoint: { type: "default" } },
      ]);
      expect(payload.messages[1]?.content).toHaveLength(1);
      expect(payload.messages[2]?.content).toHaveLength(22);
      expect(payload.messages[2]?.content.at(-1)).toEqual({ cachePoint: { type: "default" } });
    });

    it("uses the supported cache TTL after resolving mixed opaque targets", async () => {
      const targets = ["anthropic.claude-sonnet-4-6", "anthropic.claude-3-7-sonnet-20250219-v1:0"];
      const modelId = profileArn("cache-ttl-mixed");
      queueProfileTargets(targets);
      const payload = buildBedrockCachePayload();

      await applyProfilePayload(payload, { id: modelId, options: { cacheRetention: "long" } });

      const system = payload.system as Array<Record<string, unknown>>;
      const cachePoint = { type: "default" };
      expect(system[1]).toEqual({ cachePoint });
      expect(payload.messages).toEqual([
        { role: "user", content: [{ text: "Hello" }, { cachePoint }] },
      ]);
      expect(sendBedrockCommand).toHaveBeenCalledTimes(1);
      expect(bedrockClientConfigs).toEqual([
        { region: "us-east-1", credentialDefaultProvider: expect.any(Function) },
      ]);
      expect(destroyBedrockClient).toHaveBeenCalledTimes(1);
    });

    it("omits temperature after resolving opaque profiles without a display name", async () => {
      const modelId = profileArn("opus-temperature-unnamed", "us-west-2");
      queueProfileTargets(["anthropic.claude-opus-4.7-v1:0"], "us-west-2");
      const payload = buildBedrockCachePayload("Hello", {
        inferenceConfig: { temperature: 0.3, maxTokens: 10 },
      });

      await applyProfilePayload(payload, {
        id: modelId,
        options: {
          temperature: 0.3,
          maxTokens: 10,
          cacheRetention: "none",
        },
      });

      expect(payload.inferenceConfig).toEqual({ maxTokens: 10 });
      expect(sendBedrockCommand).toHaveBeenCalledTimes(1);
      expect(bedrockClientConfigs).toEqual([
        { region: "us-west-2", credentialDefaultProvider: expect.any(Function) },
      ]);
    });

    it("keeps opaque profile caching disabled for a resolved Nova target", async () => {
      const modelId = profileArn("opaque-nova");
      queueProfileTargets(["anthropic.claude-sonnet-4-6-20250514-v1:0", "amazon.nova-pro-v1:0"]);
      const payload = buildBedrockCachePayload();

      await applyProfilePayload(payload, { id: modelId, options: { cacheRetention: "short" } });

      expect(payload.system).toEqual([{ text: "You are helpful." }]);
      expect(payload.messages).toEqual([{ role: "user", content: [{ text: "Hello" }] }]);
    });

    it("times out stalled profile lookup, destroys its client, and retries next request", async () => {
      vi.useFakeTimers();
      try {
        const modelId = profileArn("timeout-retry");
        const firstStarted = createDeferred<AbortSignal>();
        inferenceProfileGetResults.push({ stall: firstStarted.resolve });
        queueProfileTargets(["anthropic.claude-sonnet-4-6-20250514-v1:0"]);
        const provider = await registerWithConfig(undefined);
        const firstPayload = buildBedrockCachePayload();
        const secondPayload = buildBedrockCachePayload("Hello again");

        const firstRequest = applyProfilePayload(firstPayload, {
          provider,
          id: modelId,
          options: { cacheRetention: "short" },
        });
        const firstSignal = await firstStarted.promise;
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(firstRequest).resolves.toBe(firstPayload);

        expect(firstSignal.aborted).toBe(true);
        expect(firstSignal.reason).toMatchObject({ name: "TimeoutError" });
        expect(firstPayload.system).toEqual([{ text: "You are helpful." }]);
        expect(destroyBedrockClient).toHaveBeenCalledTimes(1);

        await applyProfilePayload(secondPayload, {
          provider,
          id: modelId,
          options: { cacheRetention: "short" },
        });

        expect(secondPayload.system).toEqual([
          { text: "You are helpful." },
          { cachePoint: { type: "default" } },
        ]);
        expect(sendBedrockCommand).toHaveBeenCalledTimes(2);
        expect(destroyBedrockClient).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves caller cancellation across both profile lookup paths", async () => {
      const cases = [profileArn("opaque-abort"), profileArn("claude-abort")];

      for (const [index, modelId] of cases.entries()) {
        const started = createDeferred<AbortSignal>();
        inferenceProfileGetResults.push({ stall: started.resolve });
        const provider = await registerWithConfig(undefined);
        const controller = new AbortController();
        const reason = new Error(`caller cancelled ${index}`);
        const payload = buildBedrockCachePayload("Hello", {
          inferenceConfig: { temperature: 0.3 },
        });

        const request = applyProfilePayload(payload, {
          provider,
          id: modelId,
          options: {
            cacheRetention: "short",
            temperature: 0.3,
            signal: controller.signal,
          },
        });
        await started.promise;
        controller.abort(reason);

        await expect(request).rejects.toBe(reason);
      }

      expect(sendBedrockCommand).toHaveBeenCalledTimes(2);
      expect(destroyBedrockClient).toHaveBeenCalledTimes(2);
    });
  });
});
