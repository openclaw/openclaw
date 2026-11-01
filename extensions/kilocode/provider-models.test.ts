import { jsonResponse } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({ fetchWithSsrFGuardMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { buildKilocodeProvider, buildKilocodeProviderWithDiscovery } from "./api.js";
import {
  discoverKilocodeModels,
  KILOCODE_DEFAULT_COST,
  KILOCODE_MODELS_URL,
} from "./provider-models.js";

function modelById(models: Awaited<ReturnType<typeof discoverKilocodeModels>>, id: string) {
  return models.find((model) => model.id === id) ?? expect.fail(`missing model ${id}`);
}

function pricing(prompt: string, completion: string, cacheRead?: string, cacheWrite?: string) {
  return { prompt, completion, input_cache_read: cacheRead, input_cache_write: cacheWrite };
}

function cost<T>(input: T, output: T, cacheRead: T, cacheWrite: T) {
  return { input, output, cacheRead, cacheWrite };
}

const chatModel = {
  id: "chat",
  context_length: 200000,
  architecture: { input_modalities: ["text", "image"] },
  top_provider: { max_completion_tokens: 8192 },
  pricing: pricing("0.000003", "0.000015", "0.0000003", "0.00000375"),
  supported_parameters: ["reasoning"],
};

const autoModel = {
  ...chatModel,
  id: "kilo-auto/balanced",
  name: "Auto Balanced",
  pricing: pricing("0.000000325", "0.00000195", "0.0000000325", "0.00000040625"),
};

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

it("parses gateway model pricing and advertised tool capability", async () => {
  const models = await discoverModels([
    autoModel,
    chatModel,
    { ...chatModel, id: "tools", supported_parameters: ["tools", "tool_choice"] },
    { ...chatModel, id: "unadvertised", supported_parameters: undefined },
  ]);

  expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
    expect.objectContaining({
      url: KILOCODE_MODELS_URL,
      policy: { allowedHostnames: ["api.kilo.ai"] },
    }),
  );
  const timeoutMs = fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.timeoutMs;
  expect(timeoutMs).toBeGreaterThan(0);
  expect(timeoutMs).toBeLessThanOrEqual(5000);
  expect(models).toHaveLength(4);

  expect(modelById(models, "chat")).toMatchObject({
    cost: cost(expect.closeTo(3), expect.closeTo(15), expect.closeTo(0.3), expect.closeTo(3.75)),
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 8192,
  });
  expect(modelById(models, "chat").compat).toEqual({ supportsTools: false });
  expect(modelById(models, "tools").compat).toEqual({ supportsTools: true });
  expect(modelById(models, "unadvertised").compat).toBeUndefined();
});

it("preserves known default-model pricing for unknown routing rates with valid cache prices", async () => {
  const models = await discoverModels([
    { ...autoModel, pricing: pricing("unavailable", "-1", "0.0000003", "0.00000375") },
    { ...chatModel, id: "kilo-auto/frontier", pricing: pricing("-1", "-1") },
    { ...chatModel, id: "kilo-auto/free", pricing: pricing("0", "0", "0", "0") },
  ]);
  expect(modelById(models, "kilo-auto/balanced").cost).toEqual({
    ...KILOCODE_DEFAULT_COST,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  });
  for (const id of ["kilo-auto/frontier", "kilo-auto/free"]) {
    expect(modelById(models, id).cost).toEqual(cost(0, 0, 0, 0));
  }
});

it("rejects malformed model list envelopes", async () => {
  stubResponse(jsonResponse({ data: {} }));
  await expect(discoverKilocodeModels({ discoveryMode: "strict" })).rejects.toThrow(
    "Kilocode model list: malformed JSON response",
  );
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
    const models = await discoverModels([{ ...chatModel, context_length, top_provider }]);
    expect(modelById(models, "chat")).toMatchObject({ contextWindow, maxTokens });
  },
);

it("detects text-only models without image modality", async () => {
  const models = await discoverModels([
    { ...chatModel, architecture: { input_modalities: ["text"] }, supported_parameters: [] },
  ]);
  expect(modelById(models, "chat")).toMatchObject({
    input: ["text"],
    reasoning: false,
    compat: { supportsTools: false },
  });
});

it("excludes image-output models while retaining chat and static routing entries", async () => {
  const models = await discoverModels([
    { ...chatModel, id: "image", architecture: { output_modalities: ["image", "text"] } },
    chatModel,
  ]);
  expect(models.map((model) => model.id)).toEqual(["kilo-auto/balanced", "chat"]);
});

it("keeps a later valid duplicate when an earlier entry is malformed", async () => {
  const models = await discoverModels([
    { ...autoModel, name: "Broken Auto Balanced", pricing: undefined },
    autoModel,
  ]);
  expect(modelById(models, "kilo-auto/balanced")).toMatchObject({
    name: "Auto Balanced",
    cost: { input: expect.closeTo(0.325) },
  });
});
