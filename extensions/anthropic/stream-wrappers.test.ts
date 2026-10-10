import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { calculateUsageCost } from "@openclaw/llm-core";
// Anthropic tests cover stream wrappers plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { type Model, streamSimple } from "openclaw/plugin-sdk/llm";
import { useProviderCatalogMetadata } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveProviderEndpoint } from "openclaw/plugin-sdk/provider-model-shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAnthropicBetaHeadersWrapper,
  createAnthropicFastModeWrapper,
  createAnthropicServiceTierWrapper,
  resolveAnthropicBetas,
  resolveAnthropicFastMode,
  wrapAnthropicProviderStream,
} from "./stream-wrappers.js";

useProviderCatalogMetadata(new URL(".", import.meta.url), new URL("../google/", import.meta.url));

const CONTEXT_1M_BETA = "context-1m-2025-08-07";
const OAUTH_BETA = "oauth-2025-04-20";
const initialTransportHost = getAiTransportHost();

beforeAll(() => {
  configureAiTransportHost({
    ...initialTransportHost,
    resolveProviderRequestCapabilities: (input) => ({
      ...initialTransportHost.resolveProviderRequestCapabilities(input),
      endpointClass: resolveProviderEndpoint(input.baseUrl).endpointClass,
      allowsAnthropicServiceTier: input.provider === "anthropic",
    }),
  });
});

afterAll(() => {
  configureAiTransportHost(initialTransportHost);
});

function runWrapper(apiKey: string | undefined): Record<string, string> | undefined {
  const captured: { headers?: Record<string, string> } = {};
  const base: StreamFn = (_model, _context, options) => {
    captured.headers = options?.headers;
    return {} as never;
  };
  const wrapper = createAnthropicBetaHeadersWrapper(base, [CONTEXT_1M_BETA]);
  void wrapper(
    { provider: "anthropic", id: "claude-opus-4-6" } as never,
    {} as never,
    { apiKey } as never,
  );
  return captured.headers;
}

function createPayloadCapturingBaseStream(captured: {
  headers?: Record<string, string>;
  payload?: Record<string, unknown>;
  options?: Parameters<StreamFn>[2];
}): StreamFn {
  return (model, _context, options) => {
    captured.headers = options?.headers;
    captured.options = options;
    const payload = {} as Record<string, unknown>;
    options?.onPayload?.(payload as never, model as never);
    captured.payload = payload;
    return {} as never;
  };
}

function runComposedAnthropicProviderStream(apiKey: string, modelId = "claude-sonnet-4-6") {
  const captured: { headers?: Record<string, string>; payload?: Record<string, unknown> } = {};
  const wrapped = wrapAnthropicProviderStream({
    streamFn: createPayloadCapturingBaseStream(captured),
    modelId,
    extraParams: { context1m: true, serviceTier: "auto" },
  } as never);

  void wrapped?.(
    { provider: "anthropic", api: "anthropic-messages", id: modelId } as never,
    {} as never,
    { apiKey } as never,
  );
  return captured;
}

function runPayloadWrapper(
  params: {
    apiKey?: string;
    provider?: string;
    api?: string;
    baseUrl?: string;
  },
  createWrapper: (base: StreamFn) => StreamFn,
): Record<string, unknown> | undefined {
  const captured: { payload?: Record<string, unknown> } = {};
  const wrapper = createWrapper(createPayloadCapturingBaseStream(captured));
  void wrapper(
    {
      provider: params.provider ?? "anthropic",
      api: params.api ?? "anthropic-messages",
      baseUrl: params.baseUrl,
      id: "claude-sonnet-4-6",
    } as never,
    {} as never,
    { apiKey: params.apiKey } as never,
  );
  return captured.payload;
}

function runNativeFastModeWrapper(params?: {
  apiKey?: string;
  provider?: string;
  api?: string;
  baseUrl?: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  modelId?: string;
  cost?: Parameters<StreamFn>[0]["cost"];
}) {
  const captured: {
    headers?: Record<string, string>;
    model?: Parameters<StreamFn>[0];
    payload?: Record<string, unknown>;
  } = {};
  const base: StreamFn = (model, _context, options) => {
    captured.headers = options?.headers;
    captured.model = model;
    const payload = {} as Record<string, unknown>;
    options?.onPayload?.(payload as never, model as never);
    captured.payload = payload;
    return {} as never;
  };
  const wrapper = createAnthropicFastModeWrapper(base, params?.enabled ?? true);
  void wrapper(
    {
      provider: params?.provider ?? "anthropic",
      api: params?.api ?? "anthropic-messages",
      baseUrl: params?.baseUrl,
      id: params?.modelId ?? "claude-opus-5",
      cost: params?.cost ?? { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    } as never,
    {} as never,
    {
      apiKey: params?.apiKey ?? "sk-ant-api03-test-key",
      headers: params?.headers,
    } as never,
  );
  return captured;
}

function runCompactionProviderWrapper(params?: {
  apiKey?: string;
  provider?: string;
  api?: string;
  baseUrl?: string;
  modelId?: string;
  extraParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  payload?: Record<string, unknown>;
}) {
  const captured: {
    headers?: Record<string, string>;
    payload?: Record<string, unknown>;
    options?: Parameters<StreamFn>[2];
  } = {};
  const modelId = params?.modelId ?? "claude-sonnet-4-6";
  const wrapped = wrapAnthropicProviderStream({
    streamFn: createPayloadCapturingBaseStream(captured),
    modelId,
    extraParams: params?.extraParams ?? {},
  } as never);
  const payload = params?.payload ?? {};
  void wrapped?.(
    {
      provider: params?.provider ?? "anthropic",
      api: params?.api ?? "anthropic-messages",
      baseUrl: params?.baseUrl ?? "https://api.anthropic.com/v1",
      id: modelId,
      contextWindow: 200_000,
    } as never,
    {} as never,
    {
      apiKey: params?.apiKey ?? "sk-ant-api03-test-key",
      headers: params?.headers,
      onPayload: (generated: unknown) =>
        Object.assign(generated as Record<string, unknown>, payload),
    } as never,
  );
  return captured;
}

describe("anthropic stream wrappers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips legacy context-1m betas for Claude CLI or legacy token auth", () => {
    const headers = runWrapper("sk-ant-oat01-123");
    expect(headers?.["anthropic-beta"]).toBeDefined();
    expect(headers?.["anthropic-beta"]).toContain(OAUTH_BETA);
    expect(headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
  });

  it("composes the anthropic provider stream chain from extra params", () => {
    const captured = runComposedAnthropicProviderStream("sk-ant-api-123");
    expect(captured.headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
    expect(captured.payload).toMatchObject({ service_tier: "auto" });
  });

  it.each([
    { name: "a documented model by default", modelId: "claude-sonnet-4-6", extraParams: {} },
    {
      name: "an explicit opt-in on another Claude model",
      modelId: "claude-opus-4-5",
      extraParams: { anthropicServerCompaction: true },
    },
  ])("passes server compaction for $name to the direct API-key transport", (params) => {
    const captured = runCompactionProviderWrapper({
      ...params,
      headers: { "Anthropic-Beta": "files-api-2025-04-14" },
    });

    expect(captured.headers?.["Anthropic-Beta"]).toBe("files-api-2025-04-14,compact-2026-01-12");
    expect(captured.options).toMatchObject({
      anthropicServerCompaction: true,
      anthropicCompactThreshold: 140_000,
    });
  });

  it.each([undefined, true, false])(
    "honors server compaction at the final request with a configured threshold (enabled=%s)",
    async (anthropicServerCompaction) => {
      const previousHost = getAiTransportHost();
      const requests: Array<{ headers: Headers; payload: Record<string, unknown> }> = [];
      configureAiTransportHost({
        ...previousHost,
        buildModelFetch: () => async (_input, init) => {
          if (typeof init?.body !== "string") {
            throw new Error("expected a JSON Anthropic request body");
          }
          requests.push({
            headers: new Headers(init.headers),
            payload: JSON.parse(init.body) as Record<string, unknown>,
          });
          const events = [
            {
              type: "message_start",
              message: {
                id: "msg_compaction",
                model: "claude-sonnet-4-6",
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 0 },
            },
            { type: "message_stop" },
          ];
          return new Response(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      const model = {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 4096,
      } satisfies Model<"anthropic-messages">;
      const wrapped = expectDefined(
        wrapAnthropicProviderStream({
          streamFn: streamSimple,
          modelId: model.id,
          extraParams: { anthropicServerCompaction, anthropicCompactThreshold: 150_000 },
        } as never),
        "Anthropic provider stream",
      );
      try {
        const stream = await wrapped(
          model,
          { messages: [{ role: "user", content: "Remember this.", timestamp: 1 }] },
          { apiKey: "sk-ant-api-synthetic" },
        );
        expect((await stream.result()).stopReason).toBe("stop");
      } finally {
        configureAiTransportHost(previousHost);
      }

      expect(requests).toHaveLength(1);
      if (anthropicServerCompaction === false) {
        expect(requests[0]?.payload).not.toHaveProperty("context_management");
        expect(requests[0]?.headers.get("anthropic-beta") ?? "").not.toContain(
          "compact-2026-01-12",
        );
      } else {
        expect(requests[0]?.payload.context_management).toMatchObject({
          edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 150_000 } }],
        });
        expect(requests[0]?.headers.get("anthropic-beta")).toContain("compact-2026-01-12");
      }
    },
  );

  it.each([
    {
      name: "the model is not documented for compaction",
      modelId: "claude-opus-4-5",
    },
    {
      name: "OAuth auth is used",
      apiKey: "sk-ant-oat01-test-token",
    },
  ])("skips server compaction when $name", (params) => {
    const captured = runCompactionProviderWrapper(params);

    expect(captured.headers?.["anthropic-beta"] ?? "").not.toContain("compact-2026-01-12");
    expect(captured.payload).not.toHaveProperty("context_management");
  });

  it("strips legacy context-1m beta from comma-separated string config", () => {
    expect(
      resolveAnthropicBetas(
        { anthropicBeta: `${CONTEXT_1M_BETA},files-api-2025-04-14` },
        "claude-sonnet-4-6",
      ),
    ).toEqual(["files-api-2025-04-14"]);
  });

  it("preserves OAuth-required betas when legacy context-1m is the only configured beta", () => {
    const captured: { headers?: Record<string, string> } = {};
    const wrapped = wrapAnthropicProviderStream({
      streamFn: createPayloadCapturingBaseStream(captured),
      modelId: "claude-sonnet-4-6",
      extraParams: { anthropicBeta: [CONTEXT_1M_BETA] },
    } as never);

    void wrapped?.(
      { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4-6" } as never,
      {} as never,
      { apiKey: "sk-ant-oat01-oauth-token" } as never,
    );

    expect(captured.headers?.["anthropic-beta"]).toContain(OAUTH_BETA);
    expect(captured.headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
  });

  it("leaves auto unresolved and falls back from Ultrafast to Fast at the provider boundary", () => {
    expect(resolveAnthropicFastMode({ fastMode: "auto" })).toBeUndefined();
    expect(resolveAnthropicFastMode({ fastMode: "ultrafast" })).toBe(true);
  });

  it("uses native fast mode and premium pricing for Claude Opus 5", () => {
    const captured = runNativeFastModeWrapper({
      baseUrl: "https://api.anthropic.com",
      headers: { "anthropic-beta": "files-api-2025-04-14" },
    });

    expect(captured.headers?.["anthropic-beta"]).toBe("files-api-2025-04-14,fast-mode-2026-02-01");
    expect(captured.payload).toEqual({ speed: "fast" });
    expect(captured.model?.cost).toEqual({
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
    });
  });

  it.each([
    {
      cacheRead: 250_000,
      expected: { input: 0.02, output: 0.01, cacheRead: 0.5, cacheWrite: 0.575, total: 1.105 },
    },
  ])(
    "prices fast-mode tiers and mixed cache writes with $cacheRead cached tokens",
    ({ cacheRead, expected }) => {
      const cost: Parameters<StreamFn>[0]["cost"] = {
        input: 5,
        output: 25,
        cacheRead: 0.5,
        cacheWrite: 6.25,
        tieredPricing: [
          { range: [0, 200_000], input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
          { range: [200_000, Infinity], input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
        ],
      };
      const original = structuredClone(cost);
      const captured = runNativeFastModeWrapper({ cost });
      const pricedModel = expectDefined(captured.model, "fast-mode model");
      const usageCost = calculateUsageCost(
        { input: 1_000, output: 100, cacheRead, cacheWrite: 20_000, cacheWrite1h: 5_000 },
        pricedModel.cost,
      );
      expect(usageCost).toEqual({ ...expected, total: expect.closeTo(expected.total, 10) });
      expect(cost).toEqual(original);
    },
  );

  it("keeps standard Opus 5 payload and pricing when fast mode is disabled", () => {
    const captured = runNativeFastModeWrapper({ enabled: false });

    expect(captured.headers).toBeUndefined();
    expect(captured.payload).toEqual({});
    expect(captured.model?.cost).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
  });

  it.each([
    {
      label: "OAuth",
      params: { apiKey: "sk-ant-oat01-test-token" },
    },
    {
      label: "Vertex",
      params: {
        baseUrl: "https://us-east5-aiplatform.googleapis.com",
      },
    },
  ])("does not send native fast mode over $label routes", ({ label, params }) => {
    if (label === "Vertex") {
      expect(resolveProviderEndpoint(params.baseUrl).endpointClass).toBe("google-vertex");
    }
    const captured = runNativeFastModeWrapper(params);

    expect(captured.headers).toBeUndefined();
    expect(captured.payload).toEqual({});
    expect(captured.model?.cost.input).toBe(5);
  });

  it("lets explicit service tier configuration override fast mode", () => {
    const captured: { headers?: Record<string, string>; payload?: Record<string, unknown> } = {};
    const wrapped = wrapAnthropicProviderStream({
      streamFn: createPayloadCapturingBaseStream(captured),
      modelId: "claude-opus-5",
      extraParams: { fastMode: true, serviceTier: "standard_only" },
    } as never);

    void wrapped?.(
      {
        provider: "anthropic",
        api: "anthropic-messages",
        id: "claude-opus-5",
      } as never,
      {} as never,
      { apiKey: "sk-ant-api03-test-key" } as never,
    );

    expect(captured.headers?.["anthropic-beta"] ?? "").not.toContain("fast-mode");
    expect(captured.payload).toEqual({});
  });
});

describe("createAnthropicThinkingPrefillWrapper", () => {
  function runThinkingPrefillWrapper(payload: Record<string, unknown>): Record<string, unknown> {
    const wrapper = wrapAnthropicProviderStream({
      streamFn: ((_model, _context, options) => {
        options?.onPayload?.(payload as never, {} as never);
        return {} as never;
      }) as StreamFn,
      modelId: "claude-sonnet-4-6",
      extraParams: {},
    } as never);
    void wrapper?.({ provider: "anthropic", api: "anthropic-messages" } as never, {} as never, {});
    return payload;
  }

  it("removes trailing assistant prefill when extended thinking is enabled", () => {
    const payload = runThinkingPrefillWrapper({
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    });

    expect(payload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
  });
});

describe("Anthropic service_tier payload wrappers", () => {
  it("fast mode does not inject service_tier for non-anthropic provider", () => {
    const payload = runPayloadWrapper(
      {
        apiKey: "sk-ant-api03-test-key",
        provider: "openai",
        api: "openai-completions",
      },
      (base) => createAnthropicFastModeWrapper(base, true),
    );
    expect(payload?.service_tier).toBeUndefined();
  });

  it("fast mode resolves dynamic service_tier for each stream call", () => {
    let enabled = true;
    const first = runPayloadWrapper({ apiKey: "sk-ant-api03-test-key" }, (base) =>
      createAnthropicFastModeWrapper(base, () => enabled),
    );
    enabled = false;
    const second = runPayloadWrapper({ apiKey: "sk-ant-api03-test-key" }, (base) =>
      createAnthropicFastModeWrapper(base, () => enabled),
    );
    expect(first?.service_tier).toBe("auto");
    expect(second?.service_tier).toBe("standard_only");
  });

  it("explicit service tier injects service_tier=standard_only for regular API keys", () => {
    const payload = runPayloadWrapper({ apiKey: "sk-ant-api03-test-key" }, (base) =>
      createAnthropicServiceTierWrapper(base, "standard_only"),
    );
    expect(payload?.service_tier).toBe("standard_only");
  });
});
