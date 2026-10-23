import { jsonResponse } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  ssrfPolicyFromHttpBaseUrlAllowedHostname: (baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  }),
}));

import { buildKilocodeProvider, buildKilocodeProviderWithDiscovery } from "./api.js";
import {
  discoverKilocodeModels,
  KILOCODE_DEFAULT_COST,
  KILOCODE_MODELS_URL,
} from "./provider-models.js";

function requireModelById(models: Awaited<ReturnType<typeof discoverKilocodeModels>>, id: string) {
  return models.find((model) => model.id === id) ?? expect.fail(`missing model ${id}`);
}

const requireRecord = createRequireRecord("record", "expected-label-record");

function pricing(prompt: string, completion: string, cacheRead?: string, cacheWrite?: string) {
  return { prompt, completion, input_cache_read: cacheRead, input_cache_write: cacheWrite };
}

function makeGatewayModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "anthropic/claude-sonnet-4",
    name: "Anthropic: Claude Sonnet 4",
    context_length: 200000,
    architecture: {
      input_modalities: ["text", "image"],
    },
    top_provider: { max_completion_tokens: 8192 },
    pricing: pricing("0.000003", "0.000015", "0.0000003", "0.00000375"),
    supported_parameters: ["reasoning"],
    ...overrides,
  };
}

function makeAutoModel(overrides: Record<string, unknown> = {}) {
  return makeGatewayModel({
    id: "kilo-auto/balanced",
    name: "Auto Balanced",
    pricing: pricing("0.000000325", "0.00000195", "0.0000000325", "0.00000040625"),
    ...overrides,
  });
}

function stubResponse(response: Response) {
  fetchWithSsrFGuardMock.mockResolvedValue({ response, release: vi.fn(async () => {}) });
}

function discoverModels(data: unknown[]) {
  stubResponse(jsonResponse({ data }));
  return discoverKilocodeModels();
}

afterEach(() => fetchWithSsrFGuardMock.mockReset());
afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

it("preserves the public advisory builder for HTTP 200 with no rows", async () => {
  stubResponse(jsonResponse({ data: [] }));
  await expect(buildKilocodeProviderWithDiscovery()).resolves.toEqual(buildKilocodeProvider());
});

it("parses gateway models with correct pricing conversion", async () => {
  const models = await discoverModels([makeAutoModel(), makeGatewayModel()]);

  expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
  const guardedFetch = requireRecord(
    fetchWithSsrFGuardMock.mock.calls[0]?.[0],
    "guarded fetch params",
  );
  expect(guardedFetch.url).toBe(KILOCODE_MODELS_URL);
  expect(guardedFetch.auditContext).toBe("kilocode.model_discovery");
  expect(guardedFetch.policy).toEqual({ allowedHostnames: ["api.kilo.ai"] });
  const guardedInit = requireRecord(guardedFetch.init, "guarded fetch init");
  expect(Object.fromEntries(new Headers(guardedInit.headers as HeadersInit))).toEqual({
    accept: "application/json",
  });
  expect(guardedFetch.timeoutMs).toBeGreaterThan(0);
  expect(guardedFetch.timeoutMs).toBeLessThanOrEqual(5000);
  expect(models).toHaveLength(2);

  const sonnet = requireModelById(models, "anthropic/claude-sonnet-4");
  expect(sonnet).toMatchObject({
    cost: {
      input: expect.closeTo(3),
      output: expect.closeTo(15),
      cacheRead: expect.closeTo(0.3),
      cacheWrite: expect.closeTo(3.75),
    },
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 8192,
  });
});

it("preserves known default-model pricing for unknown routing rates with valid cache prices", async () => {
  const models = await discoverModels([
    makeAutoModel({ pricing: pricing("unavailable", "-1", "0.0000003", "0.00000375") }),
    makeGatewayModel({ id: "kilo-auto/frontier", pricing: pricing("-1", "-1") }),
    makeGatewayModel({ id: "kilo-auto/free", pricing: pricing("0", "0", "0", "0") }),
  ]);
  expect(requireModelById(models, "kilo-auto/balanced").cost).toEqual({
    input: KILOCODE_DEFAULT_COST.input,
    output: KILOCODE_DEFAULT_COST.output,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  });
  for (const id of ["kilo-auto/frontier", "kilo-auto/free"]) {
    expect(requireModelById(models, id).cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  }
});

it("rejects malformed model list envelopes", async () => {
  for (const payload of [[], { data: {} }]) {
    stubResponse(jsonResponse(payload));
    await expect(discoverKilocodeModels({ discoveryMode: "strict" })).rejects.toThrow(
      "Kilocode model list: malformed JSON response",
    );
  }
});

it("does not restore seed models when no usable live rows remain", async () => {
  stubResponse(jsonResponse({ data: [null] }));
  await expect(discoverKilocodeModels({ discoveryMode: "strict" })).resolves.toEqual([]);
});

it.each([
  [-1, { max_completion_tokens: 8192.5 }, 1000000, 65536],
  [Number.POSITIVE_INFINITY, { max_completion_tokens: 0 }, 1000000, 65536],
  [1048576, { context_length: 524288, max_completion_tokens: 512000 }, 524288, 512000],
])(
  "resolves catalog window %s and provider limits %j to %s/%s",
  async (context_length, top_provider, contextWindow, maxTokens) => {
    const models = await discoverModels([makeGatewayModel({ context_length, top_provider })]);
    expect(requireModelById(models, "anthropic/claude-sonnet-4")).toMatchObject({
      contextWindow,
      maxTokens,
    });
  },
);

it("detects text-only models without image modality", async () => {
  const models = await discoverModels([
    makeGatewayModel({
      id: "some/text-model",
      architecture: { input_modalities: ["text"] },
      supported_parameters: [],
    }),
  ]);
  expect(requireModelById(models, "some/text-model")).toMatchObject({
    input: ["text"],
    reasoning: false,
  });
});

it("excludes image-output models while retaining chat and static routing entries", async () => {
  const models = await discoverModels([
    makeGatewayModel({
      id: "google/gemini-3.1-flash-image",
      architecture: {
        output_modalities: ["image", "text"],
      },
    }),
    makeGatewayModel(),
  ]);
  expect(models.map((model) => model.id)).toEqual([
    "kilo-auto/balanced",
    "anthropic/claude-sonnet-4",
  ]);
});

it("keeps a later valid duplicate when an earlier entry is malformed", async () => {
  const models = await discoverModels([
    makeAutoModel({ name: "Broken Auto Balanced", pricing: undefined }),
    makeAutoModel(),
    makeGatewayModel(),
  ]);
  const auto = requireModelById(models, "kilo-auto/balanced");
  expect(auto.name).toBe("Auto Balanced");
  expect(auto.cost.input).toBeCloseTo(0.325);
  expect(requireModelById(models, "anthropic/claude-sonnet-4").id).toBe(
    "anthropic/claude-sonnet-4",
  );
});
