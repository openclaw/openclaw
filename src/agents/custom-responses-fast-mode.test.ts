import { createServer } from "node:http";
import type { Model } from "@openclaw/llm-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveOpenAIResponsesPayloadPolicy } from "../../packages/ai/src/transports/openai-responses-payload-policy.js";
import { supportsOpenAIResponsesFastMode } from "../llm/providers/openai-fast-mode.js";
import { buildProviderStreamFamilyHooks } from "../plugin-sdk/provider-stream.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { resolveFastModeForElapsed } from "../shared/fast-mode.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { applyExtraParamsToAgent } from "./embedded-agent-runner/extra-params.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-transport-stream.js";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";
import type { StreamFn } from "./runtime/index.js";

const providerRuntime = vi.hoisted<{
  plugin?: Pick<ProviderPlugin, "wrapStreamFn" | "resolveFastModeSupport">;
}>(() => ({}));

// mock-isolation: Inject provider policy without registry activation; real composition and transport run below.
vi.mock("../plugins/provider-hook-runtime.js", () => ({
  ensureProviderRuntimePluginHandle: () => ({ plugin: providerRuntime.plugin }),
  getModelProviderRuntimePluginHandle: () => undefined,
  resolveLoadedProviderRuntimePlugin: () => undefined,
  resolveProviderRuntimePlugin: () => providerRuntime.plugin,
}));

const baseModel: Model<"openai-responses"> = {
  id: "custom-model",
  name: "Custom model",
  provider: "custom-provider",
  api: "openai-responses",
  baseUrl: "https://example.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 256,
  compat: { supportsServiceTier: true },
};

describe("custom Responses service-tier capability", () => {
  it.each([
    { api: "openai-responses", baseUrl: "https://example.invalid/v1", expected: true },
    { api: "openai-completions", baseUrl: "https://example.invalid/v1", expected: false },
    { api: "openai-chatgpt-responses", baseUrl: "https://example.invalid/v1", expected: false },
    { api: "azure-openai-responses", baseUrl: "https://example.invalid/v1", expected: false },
    { api: "anthropic-messages", baseUrl: "https://example.invalid/v1", expected: false },
    { api: "openai-responses", baseUrl: "not a URL", expected: false },
    { api: "openai-responses", baseUrl: "file:///tmp/model", expected: false },
    { api: "openai-responses", baseUrl: "", expected: false },
  ])("gates $api on $baseUrl", ({ expected, ...route }) => {
    expect(supportsOpenAIResponsesFastMode({ ...baseModel, ...route })).toBe(expected);
  });

  it("does not enable unrelated native OpenAI payload features", () => {
    const options = { enablePromptCacheStripping: true, enableServerCompaction: true };
    const baseline = resolveOpenAIResponsesPayloadPolicy(
      { ...baseModel, compat: undefined },
      options,
    );
    expect(baseline.allowsServiceTier).toBe(false);
    expect(resolveOpenAIResponsesPayloadPolicy(baseModel, options)).toEqual({
      ...baseline,
      allowsServiceTier: true,
    });
  });
});

describe("custom Responses Fast mode over local HTTP/SSE", () => {
  const requests: Array<{
    url: string | undefined;
    payload: Record<string, unknown>;
    providerHeader: string | string[] | undefined;
  }> = [];
  let fixture: Awaited<ReturnType<typeof reserveTestPortListener>>;
  let baseUrl: string;
  beforeAll(async () => {
    fixture = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((req, res) => {
          let body = "";
          req.setEncoding("utf8");
          req.on("data", (chunk: string) => {
            body += chunk;
          });
          req.on("end", () => {
            requests.push({
              url: req.url,
              payload: JSON.parse(body) as Record<string, unknown>,
              providerHeader: req.headers["x-fixture-provider"],
            });
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(
              `data: ${JSON.stringify({
                type: "response.completed",
                response: {
                  id: "response-fixture",
                  status: "completed",
                  output: [],
                  usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
                },
              })}\n\n`,
            );
          });
        }),
    });
    baseUrl = `http://127.0.0.1:${fixture.claim.port}/v1`;
  });
  afterAll(async () => {
    if (fixture) {
      await fixture.releaseListener();
      await fixture.claim.release();
    }
  });
  afterEach(() => {
    delete providerRuntime.plugin;
  });

  function createRequester(
    params: Record<string, unknown>,
    supported: boolean | null = true,
    transportTier?: "default" | "priority",
    provider = baseModel.provider,
  ) {
    const model = attachModelProviderRequestTransport(
      {
        ...baseModel,
        provider,
        baseUrl,
        compat: supported === null ? undefined : { supportsServiceTier: supported },
      },
      { allowPrivateNetwork: true },
    );
    const agent: { streamFn: StreamFn } = { streamFn: createOpenAIResponsesTransportStreamFn() };
    applyExtraParamsToAgent(
      agent,
      {},
      model.provider,
      model.id,
      undefined,
      undefined,
      "main",
      undefined,
      model,
      undefined,
      undefined,
      { preparedExtraParams: params },
    );
    return async () => {
      const stream = await agent.streamFn(
        model,
        {
          systemPrompt: "Answer briefly.",
          messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        },
        {
          apiKey: "test-key",
          transport: "sse",
          serviceTier: transportTier,
        },
      );
      const result = await stream.result();
      expect(result.errorMessage).toBeUndefined();
      expect(result.stopReason).not.toBe("error");
      expect(requests.at(-1)?.url).toBe("/v1/responses");
      return requests.at(-1)!.payload;
    };
  }

  function request(
    params: Record<string, unknown>,
    supported: boolean | null = true,
    transportTier?: "default" | "priority",
  ) {
    return createRequester(params, supported, transportTier)();
  }

  it("maps on/off, preserves explicit tiers, and follows an auto cutoff callback", async () => {
    expect(await request({ fastMode: true })).toHaveProperty("service_tier", "priority");
    expect(await request({ fastMode: false })).not.toHaveProperty("service_tier");
    expect(await request({ fastMode: "auto" })).not.toHaveProperty("service_tier");
    for (const serviceTier of ["auto", "default", "flex", "priority", "ultrafast"]) {
      expect(await request({ fastMode: true, serviceTier })).toHaveProperty(
        "service_tier",
        serviceTier,
      );
    }
    expect(await request({ fast_mode: true, service_tier: "flex" })).toHaveProperty(
      "service_tier",
      "flex",
    );
    expect(await request({ fastMode: true, serviceTier: "invalid" })).toHaveProperty(
      "service_tier",
      "priority",
    );
    expect(await request({ fastMode: true, serviceTier: "flex" }, true, "default")).toHaveProperty(
      "service_tier",
      "default",
    );
    let nowMs = 1000;
    const params = {
      fastMode: () =>
        resolveFastModeForElapsed({ mode: "auto", startedAtMs: 1000, fastAutoOnSeconds: 30, nowMs })
          .enabled,
    };
    const autoRequest = createRequester(params);
    expect(await autoRequest()).toHaveProperty("service_tier", "priority");
    nowMs = 31_001;
    expect(await autoRequest()).not.toHaveProperty("service_tier");
  });

  it("leaves undeclared and explicitly disabled routes unchanged", async () => {
    for (const supported of [null, false]) {
      const payload = await request({ fastMode: true, serviceTier: "priority" }, supported);
      expect(payload).not.toHaveProperty("service_tier");
    }
    const payload = await request({ fastMode: true });
    expect(payload.store).not.toBe(true);
    for (const key of [
      "instructions",
      "context_management",
      "prompt_cache_key",
      "text",
      "reasoning",
    ]) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  it.each([
    { provider: "openai", decision: false },
    { provider: "openai", decision: undefined },
    { provider: "custom-provider", decision: false },
    { provider: "custom-provider", decision: undefined },
  ])(
    "preserves $provider Fast ownership for a $decision policy",
    async ({ provider, decision }) => {
      const family = buildProviderStreamFamilyHooks("openai-responses-defaults");
      providerRuntime.plugin = {
        resolveFastModeSupport: () => decision,
        wrapStreamFn: (ctx) =>
          family.wrapStreamFn?.({
            ...ctx,
            extraParams: { ...ctx.extraParams, fastMode: () => false },
          }),
      };
      const providerRequest = createRequester({ fastMode: true }, true, undefined, provider);
      expect(await providerRequest()).not.toHaveProperty("service_tier");
    },
  );

  it("applies the declared capability alongside an unrelated provider wrapper", async () => {
    providerRuntime.plugin = {
      wrapStreamFn: ({ streamFn }) =>
        streamFn
          ? (model, context, options) =>
              streamFn(model, context, {
                ...options,
                headers: { ...options?.headers, "x-fixture-provider": "custom" },
              })
          : undefined,
    };
    expect(await request({ fastMode: true })).toHaveProperty("service_tier", "priority");
    expect(requests.at(-1)?.providerHeader).toBe("custom");
  });
});
