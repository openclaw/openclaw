import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { calculateUsageCost } from "@openclaw/llm-core";
import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import { useProviderCatalogMetadata } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveProviderEndpoint } from "openclaw/plugin-sdk/provider-model-shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeModel } from "./model-contract-cases.test-support.js";
import {
  createAnthropicBetaHeadersWrapper,
  createAnthropicFastModeWrapper,
  resolveAnthropicBetas,
  resolveAnthropicFastMode,
  wrapAnthropicProviderStream,
} from "./stream-wrappers.js";

useProviderCatalogMetadata(new URL(".", import.meta.url), new URL("../google/", import.meta.url));

const CONTEXT_1M_BETA = "context-1m-2025-08-07";
const OAUTH_BETA = "oauth-2025-04-20";
const standardCost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const fastCost = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
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

afterAll(() => configureAiTransportHost(initialTransportHost));

type Captured = {
  headers?: Record<string, string>;
  model?: Parameters<StreamFn>[0];
  payload?: Record<string, unknown>;
};
type WrapperFactory = (base: StreamFn) => StreamFn | undefined;
function captureStream({
  wrap,
  model = {},
  options = {},
  extraParams = {},
  payload = {},
}: {
  wrap?: WrapperFactory;
  model?: Partial<Parameters<StreamFn>[0]>;
  options?: Parameters<StreamFn>[2];
  extraParams?: Record<string, unknown>;
  payload?: Record<string, unknown>;
} = {}) {
  const captured: Captured = {};
  const base: StreamFn = (target, _context, opts) => {
    Object.assign(captured, { headers: opts?.headers, model: target, payload });
    opts?.onPayload?.(payload as never, target);
    return {} as never;
  };
  const target = { ...makeModel("claude-sonnet-4-6"), ...model };
  const wrapper = wrap
    ? wrap(base)
    : wrapAnthropicProviderStream({
        streamFn: base,
        modelId: target.id,
        extraParams,
      } as never);
  void wrapper?.(target, {} as never, options);
  return captured;
}

function runNativeFastModeWrapper(
  params: {
    apiKey?: string;
    baseUrl?: string;
    enabled?: boolean;
    headers?: Record<string, string>;
    cost?: Parameters<StreamFn>[0]["cost"];
  } = {},
) {
  return captureStream({
    wrap: (base) => createAnthropicFastModeWrapper(base, params.enabled ?? true),
    model: {
      id: "claude-opus-5",
      baseUrl: params.baseUrl,
      cost: params.cost ?? { ...standardCost },
    },
    options: { apiKey: params.apiKey ?? "sk-ant-api03-test-key", headers: params.headers },
  });
}

describe("anthropic stream wrappers", () => {
  it("composes the anthropic provider stream chain from extra params", () => {
    const captured = captureStream({
      extraParams: { context1m: true, serviceTier: "auto" },
      options: { apiKey: "sk-ant-api-123" },
    });
    expect(captured.headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
    expect(captured.payload).toMatchObject({ service_tier: "auto" });
  });

  it.each([
    ["claude-sonnet-4-6", undefined, undefined, 200_000],
    ["claude-sonnet-4-6", true, 150_000, 1_000_000],
    ["claude-sonnet-4-6", false, 150_000, 1_000_000],
    ["claude-opus-4-5", true, 150_000, 1_000_000],
  ] as const)(
    "honors compaction on %s at the final request (enabled=%s, threshold=%s)",
    async (modelId, anthropicServerCompaction, anthropicCompactThreshold, contextWindow) => {
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
                model: modelId,
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
      const model = makeModel(modelId, { contextWindow });
      const wrapped = expectDefined(
        wrapAnthropicProviderStream({
          streamFn: streamSimple,
          modelId: model.id,
          extraParams: { anthropicServerCompaction, anthropicCompactThreshold },
        } as never),
        "Anthropic provider stream",
      );
      try {
        const stream = await wrapped(
          model,
          { messages: [{ role: "user", content: "Remember this.", timestamp: 1 }] },
          {
            apiKey: "sk-ant-api-synthetic",
            headers: { "Anthropic-Beta": "files-api-2025-04-14" },
          },
        );
        expect((await stream.result()).stopReason).toBe("stop");
      } finally {
        configureAiTransportHost(previousHost);
      }

      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.get("anthropic-beta")).toContain("files-api-2025-04-14");
      if (anthropicServerCompaction === false) {
        expect(requests[0]?.payload).not.toHaveProperty("context_management");
        expect(requests[0]?.headers.get("anthropic-beta") ?? "").not.toContain(
          "compact-2026-01-12",
        );
      } else {
        expect(requests[0]?.payload.context_management).toMatchObject({
          edits: [
            {
              type: "compact_20260112",
              trigger: { type: "input_tokens", value: anthropicCompactThreshold ?? 140_000 },
            },
          ],
        });
        expect(requests[0]?.headers.get("anthropic-beta")).toContain("compact-2026-01-12");
      }
    },
  );

  it.each([
    { name: "the model is not documented for compaction", modelId: "claude-opus-4-5" },
    { name: "OAuth auth is used", apiKey: "sk-ant-oat01-test-token" },
  ])("skips server compaction when $name", (params) => {
    const captured = captureStream({
      model: makeModel(params.modelId ?? "claude-sonnet-4-6"),
      options: { apiKey: params.apiKey ?? "sk-ant-api03-test-key" },
    });

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

  it.each(["provider", "beta"] as const)("preserves OAuth betas in the %s wrapper", (wrapper) => {
    const captured = captureStream({
      wrap:
        wrapper === "beta"
          ? (base) => createAnthropicBetaHeadersWrapper(base, [CONTEXT_1M_BETA])
          : undefined,
      extraParams: { anthropicBeta: [CONTEXT_1M_BETA] },
      options: { apiKey: "sk-ant-oat01-oauth-token" },
    });

    expect(captured.headers?.["anthropic-beta"]).toContain(OAUTH_BETA);
    expect(captured.headers?.["anthropic-beta"]).not.toContain(CONTEXT_1M_BETA);
  });

  it("deduplicates beta headers once while preserving caller headers and first occurrence order", () => {
    const streamingBeta = "fine-grained-tool-streaming-2025-05-14";
    const thinkingBeta = "interleaved-thinking-2025-05-14";
    const headers = { "Anthropic-Beta": `existing,${streamingBeta}`, "x-request": "unchanged" };
    const betas = [thinkingBeta, "custom", "custom", CONTEXT_1M_BETA];
    const model = makeModel("claude-sonnet-4-6");
    let sentHeaders: Parameters<StreamFn>[2];
    const stream = createAnthropicBetaHeadersWrapper((_model, _context, options) => {
      sentHeaders = options;
      return {} as never;
    }, betas);
    const add = vi.spyOn(Set.prototype, "add");
    let additions: number;
    try {
      void stream(model, { messages: [] }, { headers });
      additions = add.mock.calls.length;
    } finally {
      add.mockRestore();
    }

    expect(sentHeaders?.headers).toEqual({
      "Anthropic-Beta": `existing,${streamingBeta},${thinkingBeta},custom`,
      "x-request": "unchanged",
    });
    expect(headers["Anthropic-Beta"]).toBe(`existing,${streamingBeta}`);
    expect(betas).toEqual([thinkingBeta, "custom", "custom", CONTEXT_1M_BETA]);
    expect(additions).toBe(7);
  });

  it("leaves auto unresolved and falls back from Ultrafast to Fast at the provider boundary", () => {
    expect(resolveAnthropicFastMode({ fastMode: "auto" })).toBeUndefined();
    expect(resolveAnthropicFastMode({ fastMode: "ultrafast" })).toBe(true);
  });

  it.each([true, false])(
    "applies native Opus 5 fast mode and pricing only when enabled (%s)",
    (enabled) => {
      const captured = runNativeFastModeWrapper({
        enabled,
        baseUrl: enabled ? "https://api.anthropic.com" : undefined,
        headers: enabled ? { "anthropic-beta": "files-api-2025-04-14" } : undefined,
      });
      expect([captured.headers, captured.payload, captured.model?.cost]).toEqual([
        enabled ? { "anthropic-beta": "files-api-2025-04-14,fast-mode-2026-02-01" } : undefined,
        enabled ? { speed: "fast" } : {},
        enabled ? fastCost : standardCost,
      ]);
    },
  );

  it("prices fast-mode tiers and mixed cache writes without mutating standard pricing", () => {
    const cost: Parameters<StreamFn>[0]["cost"] = {
      ...standardCost,
      tieredPricing: [
        { range: [0, 200_000], ...standardCost },
        { range: [200_000, Infinity], ...fastCost },
      ],
    };
    const original = structuredClone(cost);
    const captured = runNativeFastModeWrapper({ cost });
    const pricedModel = expectDefined(captured.model, "fast-mode model");
    const usageCost = calculateUsageCost(
      { input: 1_000, output: 100, cacheRead: 250_000, cacheWrite: 20_000, cacheWrite1h: 5_000 },
      pricedModel.cost,
    );
    expect(usageCost).toEqual({
      input: 0.02,
      output: 0.01,
      cacheRead: 0.5,
      cacheWrite: 0.575,
      total: expect.closeTo(1.105, 10),
    });
    expect(cost).toEqual(original);
  });

  it.each([
    { label: "OAuth", params: { apiKey: "sk-ant-oat01-test-token" } },
    { label: "Vertex", params: { baseUrl: "https://us-east5-aiplatform.googleapis.com" } },
  ])("does not send native fast mode over $label routes", ({ params }) => {
    const captured = runNativeFastModeWrapper(params);

    expect([captured.headers, captured.payload, captured.model?.cost.input]).toEqual([
      undefined,
      {},
      5,
    ]);
  });

  it("lets explicit service tier configuration override fast mode", () => {
    const captured = captureStream({
      extraParams: { fastMode: true, serviceTier: "standard_only" },
      model: { id: "claude-opus-5" },
      options: { apiKey: "sk-ant-api03-test-key" },
    });

    expect(captured.headers?.["anthropic-beta"] ?? "").not.toContain("fast-mode");
    expect(captured.payload).toEqual({});
  });
});

it("removes trailing assistant prefill when extended thinking is enabled", () => {
  const { payload } = captureStream({
    payload: {
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    },
  });

  expect(payload?.messages).toEqual([{ role: "user", content: "Return JSON." }]);
});

describe("Anthropic service_tier payload wrappers", () => {
  it("fast mode does not inject service_tier for non-anthropic provider", () => {
    const { payload } = captureStream({
      model: { provider: "openai", api: "openai-completions" },
      options: { apiKey: "sk-ant-api03-test-key" },
      wrap: (base) => createAnthropicFastModeWrapper(base, true),
    });
    expect(payload?.service_tier).toBeUndefined();
  });

  it("fast mode resolves dynamic service_tier for each stream call", () => {
    let enabled = true;
    const run = () =>
      captureStream({
        options: { apiKey: "sk-ant-api03-test-key" },
        wrap: (base) => createAnthropicFastModeWrapper(base, () => enabled),
      }).payload;
    const first = run();
    enabled = false;
    expect([first?.service_tier, run()?.service_tier]).toEqual(["auto", "standard_only"]);
  });
});
