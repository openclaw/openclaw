import { jsonResponse } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

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

function requireModelById(
  models: Awaited<ReturnType<typeof discoverKilocodeModels>>,
  id: string,
): Awaited<ReturnType<typeof discoverKilocodeModels>>[number] {
  const model = models.find((candidate) => candidate.id === id);
  if (!model) {
    throw new Error(`expected Kilocode model ${id}`);
  }
  return model;
}

const requireRecord = createRequireRecord("record", "expected-label-record");

function makeGatewayModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "anthropic/claude-sonnet-4",
    name: "Anthropic: Claude Sonnet 4",
    context_length: 200000,
    architecture: {
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
    top_provider: { max_completion_tokens: 8192 },
    pricing: {
      prompt: "0.000003",
      completion: "0.000015",
      input_cache_read: "0.0000003",
      input_cache_write: "0.00000375",
    },
    supported_parameters: ["max_tokens", "temperature", "tools", "reasoning"],
    ...overrides,
  };
}

function makeAutoModel(overrides: Record<string, unknown> = {}) {
  return makeGatewayModel({
    id: "kilo-auto/balanced",
    name: "Auto Balanced",
    context_length: 1000000,
    top_provider: { max_completion_tokens: 65536 },
    pricing: {
      prompt: "0.000000325",
      completion: "0.00000195",
      input_cache_read: "0.0000000325",
      input_cache_write: "0.00000040625",
    },
    supported_parameters: ["max_tokens", "temperature", "tools", "reasoning", "include_reasoning"],
    ...overrides,
  });
}

function stubResponse(response: Response) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValue({ response, release });
  return release;
}

function stubModels(data: unknown[]) {
  stubResponse(jsonResponse({ data }));
}

afterEach(() => fetchWithSsrFGuardMock.mockReset());
afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

describe("discoverKilocodeModels (fetch path)", () => {
  it.each([503, 200])(
    "preserves the public advisory builder for HTTP %s with no rows",
    async (status) => {
      stubResponse(jsonResponse({ data: [] }, status));
      await expect(buildKilocodeProviderWithDiscovery()).resolves.toEqual(buildKilocodeProvider());
    },
  );

  it("parses gateway models with correct pricing conversion", async () => {
    stubModels([makeAutoModel(), makeGatewayModel()]);
    const models = await discoverKilocodeModels();

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    const guardedFetch = requireRecord(
      fetchWithSsrFGuardMock.mock.calls[0]?.[0],
      "guarded fetch params",
    );
    expect(guardedFetch.url).toBe(KILOCODE_MODELS_URL);
    const guardedInit = requireRecord(guardedFetch.init, "guarded fetch init");
    expect(Object.fromEntries(new Headers(guardedInit.headers as HeadersInit))).toEqual({
      accept: "application/json",
    });
    expect(guardedFetch.policy).toEqual({ allowedHostnames: ["api.kilo.ai"] });
    expect(guardedFetch.timeoutMs).toBeGreaterThan(0);
    expect(guardedFetch.timeoutMs).toBeLessThanOrEqual(5000);
    expect(guardedFetch.auditContext).toBe("kilocode.model_discovery");
    expect(models).toHaveLength(2);

    const sonnet = requireModelById(models, "anthropic/claude-sonnet-4");
    expect(sonnet.cost.input).toBeCloseTo(3);
    expect(sonnet.cost.output).toBeCloseTo(15);
    expect(sonnet.cost.cacheRead).toBeCloseTo(0.3);
    expect(sonnet.cost.cacheWrite).toBeCloseTo(3.75);
    expect(sonnet.input).toEqual(["text", "image"]);
    expect(sonnet.reasoning).toBe(true);
    expect(sonnet.contextWindow).toBe(200000);
    expect(sonnet.maxTokens).toBe(8192);
  });

  it.each([
    {
      label: "negative routing rates with missing cache prices",
      pricing: { prompt: "-1", completion: "-1" },
      cacheRead: 0,
      cacheWrite: 0,
    },
    {
      label: "unknown routing rates with valid cache prices",
      pricing: {
        prompt: "unavailable",
        completion: "-1",
        input_cache_read: "0.0000003",
        input_cache_write: "0.00000375",
      },
      cacheRead: 0.3,
      cacheWrite: 3.75,
    },
  ])(
    "preserves known default-model pricing for $label",
    async ({ pricing, cacheRead, cacheWrite }) => {
      stubModels([
        makeAutoModel({ pricing }),
        makeGatewayModel({
          id: "kilo-auto/frontier",
          pricing: { prompt: "-1", completion: "-1" },
        }),
        makeGatewayModel({
          id: "kilo-auto/free",
          pricing: {
            prompt: "0",
            completion: "0",
            input_cache_read: "0",
            input_cache_write: "0",
          },
        }),
      ]);
      const models = await discoverKilocodeModels();

      expect(requireModelById(models, "kilo-auto/balanced").cost).toEqual({
        input: KILOCODE_DEFAULT_COST.input,
        output: KILOCODE_DEFAULT_COST.output,
        cacheRead,
        cacheWrite,
      });
      for (const id of ["kilo-auto/frontier", "kilo-auto/free"]) {
        expect(requireModelById(models, id).cost).toEqual({
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        });
      }
    },
  );

  it("propagates network errors", async () => {
    fetchWithSsrFGuardMock.mockRejectedValue(new Error("network error"));
    await expect(discoverKilocodeModels({ discoveryMode: "strict" })).rejects.toThrow(
      "network error",
    );
  });

  it("releases the response before propagating an HTTP error", async () => {
    const response = new Response("temporary failure", { status: 500 });
    const cancelSpy = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const release = stubResponse(response);

    await expect(discoverKilocodeModels({ discoveryMode: "strict" })).rejects.toMatchObject({
      status: 500,
    });
    expect(cancelSpy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects malformed model list envelopes", async () => {
    for (const payload of [[], { data: {} }]) {
      stubResponse(jsonResponse(payload));
      await expect(discoverKilocodeModels({ discoveryMode: "strict" })).rejects.toThrow(
        "Kilocode model list: malformed JSON response",
      );
    }
  });

  it.each([{ data: [] }, { data: [null] }])(
    "does not restore seed models when no usable live rows remain: %j",
    async (payload) => {
      stubResponse(jsonResponse(payload));
      await expect(discoverKilocodeModels({ discoveryMode: "strict" })).resolves.toEqual([]);
    },
  );

  it("falls back from malformed live token metadata", async () => {
    stubModels([
      makeGatewayModel({
        id: "some/bad-window",
        context_length: -1,
        top_provider: { max_completion_tokens: 8192.5 },
      }),
      makeGatewayModel({
        id: "some/bad-output",
        context_length: Number.POSITIVE_INFINITY,
        top_provider: { max_completion_tokens: 0 },
      }),
    ]);
    const models = await discoverKilocodeModels();

    expect(requireModelById(models, "some/bad-window")).toMatchObject({
      contextWindow: 1000000,
      maxTokens: 65536,
    });
    expect(requireModelById(models, "some/bad-output")).toMatchObject({
      contextWindow: 1000000,
      maxTokens: 65536,
    });
  });

  it("prefers the primary provider context window over the catalog-wide value", async () => {
    stubModels([
      makeGatewayModel({
        id: "minimax/minimax-m3",
        context_length: 1048576,
        top_provider: { context_length: 524288, max_completion_tokens: 512000 },
      }),
    ]);
    const models = await discoverKilocodeModels();

    expect(requireModelById(models, "minimax/minimax-m3")).toMatchObject({
      contextWindow: 524288,
      maxTokens: 512000,
    });
  });

  it("falls back to the catalog window when the provider window is unusable", async () => {
    const unusable: unknown[] = [0, -1, 4096.5, Number.POSITIVE_INFINITY, null, "131072"];
    stubModels(
      unusable.map((context_length, index) =>
        makeGatewayModel({
          id: `some/provider-window-${index}`,
          context_length: 200000,
          top_provider: { context_length, max_completion_tokens: 8192 },
        }),
      ),
    );
    const models = await discoverKilocodeModels();

    for (let index = 0; index < unusable.length; index++) {
      expect(requireModelById(models, `some/provider-window-${index}`)).toMatchObject({
        contextWindow: 200000,
        maxTokens: 8192,
      });
    }
  });

  it("detects text-only models without image modality", async () => {
    stubModels([
      makeGatewayModel({
        id: "some/text-model",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        supported_parameters: ["max_tokens", "temperature"],
      }),
    ]);
    const textModel = requireModelById(await discoverKilocodeModels(), "some/text-model");
    expect(textModel.input).toEqual(["text"]);
    expect(textModel.reasoning).toBe(false);
  });

  it("excludes image-output models while retaining chat and static routing entries", async () => {
    stubModels([
      makeGatewayModel({
        id: "google/gemini-3.1-flash-image",
        architecture: {
          input_modalities: ["text", "image"],
          output_modalities: ["image", "text"],
        },
      }),
      makeGatewayModel(),
    ]);
    expect((await discoverKilocodeModels()).map((model) => model.id)).toEqual([
      "kilo-auto/balanced",
      "anthropic/claude-sonnet-4",
    ]);
  });

  it("keeps a later valid duplicate when an earlier entry is malformed", async () => {
    stubModels([
      makeAutoModel({ name: "Broken Auto Balanced", pricing: undefined }),
      makeAutoModel(),
      makeGatewayModel(),
    ]);
    const models = await discoverKilocodeModels();
    const auto = requireModelById(models, "kilo-auto/balanced");
    expect(auto.name).toBe("Auto Balanced");
    expect(auto.cost.input).toBeCloseTo(0.325);
    expect(requireModelById(models, "anthropic/claude-sonnet-4").id).toBe(
      "anthropic/claude-sonnet-4",
    );
  });
});
