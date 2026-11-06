import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it } from "vitest";
import { createProviderDynamicModelContext as createContext } from "../test-support/provider-model-test-helpers.js";
import {
  isGoogleGeminiTextModelId,
  isGoogleTextGenerationModelId,
  isModernGoogleModel,
  resolveGoogleGeminiForwardCompatModel,
} from "./provider-models.js";

const google = "google";
const cli = "google-gemini-cli";
const vertex = "google-vertex";
const antigravity = "google-antigravity";
const directApi = "google-generative-ai";
const antigravityApi = "openai-completions";
const wideContext = { contextWindow: 1_048_576 };
const reasoningModel = { ...wideContext, reasoning: true };
const antigravityModel: Partial<ProviderRuntimeModel> = {
  api: antigravityApi,
  baseUrl: "https://antigravity.example/v1",
  ...reasoningModel,
};
const pro = "gemini-3.1-pro-preview";
const retiredPro = "gemini-3-pro-preview";
const flash = "gemini-3-flash-preview";
const lite = "gemini-3.1-flash-lite";
const stableLite = "gemini-2.5-flash-lite";
const stableFlash = "gemini-2.5-flash";

function template(
  provider: string,
  id: string,
  overrides: Partial<ProviderRuntimeModel> = {},
): ProviderRuntimeModel {
  return {
    id,
    name: id,
    provider,
    api: provider === cli ? cli : directApi,
    baseUrl:
      provider === cli
        ? "https://cloudcode-pa.googleapis.com"
        : "https://generativelanguage.googleapis.com/v1beta",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
    ...overrides,
  } as ProviderRuntimeModel;
}

function resolveModel(providerId: string, modelId: string, models: ProviderRuntimeModel[]) {
  return resolveGoogleGeminiForwardCompatModel({
    providerId,
    ctx: createContext({ provider: providerId, modelId, models }),
  });
}

function expectResolution(
  provider: string,
  id: string,
  models: ProviderRuntimeModel[],
  fields: Partial<ProviderRuntimeModel>,
) {
  expect(resolveModel(provider, id, models)).toMatchObject({ provider, id, ...fields });
}

it.each<[string, string, ProviderRuntimeModel[], Partial<ProviderRuntimeModel>]>([
  [cli, stableLite, [template(google, stableLite)], { api: directApi, reasoning: false }],
  [
    cli,
    stableLite,
    [template(cli, lite, wideContext)],
    { api: cli, contextWindow: 1_048_576, reasoning: false },
  ],
  [vertex, pro, [template(cli, retiredPro)], { api: cli, reasoning: false }],
  [
    google,
    "gemini-4-argon-preview-11-02",
    [template(google, "gemini-4-argon", reasoningModel)],
    reasoningModel,
  ],
  [
    google,
    "google/gemini-3-pro-preview",
    [template(google, pro)],
    { id: "google/gemini-3.1-pro-preview", api: "google-interactions", reasoning: true },
  ],
  [
    cli,
    pro,
    [
      template(cli, retiredPro, { contextWindow: 100_000 }),
      template(cli, pro, wideContext),
      template(google, pro, { contextWindow: 200_000 }),
    ],
    { api: cli, baseUrl: "https://cloudcode-pa.googleapis.com", contextWindow: 1_048_576 },
  ],
  [
    google,
    "gemini-3.7-flash",
    [template(google, flash, { reasoning: false })],
    { api: "google-interactions", reasoning: false },
  ],
  [
    google,
    flash,
    [template(google, stableFlash, reasoningModel)],
    {
      api: "google-interactions",
      input: ["text", "image"],
      contextWindow: 1_048_576,
      reasoning: true,
    },
  ],
  [
    cli,
    flash,
    [template(google, stableFlash, wideContext)],
    { api: directApi, input: ["text", "image"], contextWindow: 1_048_576 },
  ],
  [
    antigravity,
    "gemini-3.1-pro-preview-customtools",
    [template(antigravity, "gemini-3-pro-low", antigravityModel)],
    antigravityModel,
  ],
  [
    antigravity,
    pro,
    [
      template(antigravity, "gemini-3-pro-high", {
        api: antigravityApi,
        maxTokens: 65_536,
        reasoning: true,
      }),
    ],
    { api: antigravityApi, maxTokens: 65_536, reasoning: true },
  ],
  [
    vertex,
    "gemini-3.5-flash-lite",
    [template(cli, flash, { contextWindow: 128_000 }), template(cli, lite, wideContext)],
    { contextWindow: 1_048_576, reasoning: false },
  ],
  [
    google,
    "gemma-4-26b",
    [template(google, flash, { reasoning: false })],
    { id: "gemma-4-26b-a4b-it", api: directApi, reasoning: true },
  ],
  [google, "gemma-3-4b-it", [template(google, flash, { reasoning: false })], { reasoning: false }],
])("resolves %s/%s (case %#)", (provider, id, models, fields) => {
  expectResolution(provider, id, models, fields);
});

it("resolves Gemini latest aliases from current Google templates", () => {
  const models = [
    template(google, retiredPro, { reasoning: true }),
    template(google, flash, { reasoning: true }),
    template(google, lite, { reasoning: true }),
  ];

  for (const id of ["gemini-pro-latest", "gemini-flash-latest", "gemini-flash-lite-latest"]) {
    expectResolution(google, id, models, {
      api: "google-interactions",
      reasoning: true,
    });
  }
});

it.each(["gemini-4-flash", "gemini-4.1-flash-lite-preview", "gemini-4.1-pro-preview"])(
  "routes forward-compatible Gemini %s through Interactions",
  (id) => {
    expectResolution(google, id, [template(google, "gemini-4-argon")], {
      api: "google-interactions",
    });
  },
);

it.each([cli, vertex, antigravity])("keeps %s Flash on its existing transport", (provider) => {
  const api = provider === vertex ? "google-vertex" : provider === cli ? cli : antigravityApi;
  const id = provider === antigravity ? "gemini-3-flash" : flash;
  expectResolution(provider, "gemini-3.9-flash", [template(provider, id, { api })], { api });
});

it("does not inherit Interactions when Gemma uses a Flash template", () => {
  expectResolution(
    google,
    "gemma-4-27b-it",
    [template(google, flash, { api: "google-interactions" })],
    { api: directApi },
  );
});

it("keeps custom Google endpoints and CLI fallback templates on GenerateContent", () => {
  expectResolution(
    google,
    "gemini-3.9-flash",
    [
      template(google, flash, {
        api: "google-interactions",
        baseUrl: "https://proxy.example/v1beta",
      }),
    ],
    { api: directApi },
  );
  expectResolution(
    cli,
    "gemini-3.9-flash",
    [template(google, flash, { api: "google-interactions" })],
    { api: directApi },
  );
});

it.each([undefined, "google-generative-ai", "google-interactions"] as const)(
  "uses the configured endpoint and explicit API %s for forward-compatible Flash",
  (api) => {
    const resolved = resolveGoogleGeminiForwardCompatModel({
      providerId: google,
      ctx: {
        ...createContext({
          provider: google,
          modelId: "gemini-3.9-flash",
          models: [template(google, flash, { api: "google-interactions" })],
        }),
        providerConfig: { baseUrl: "https://proxy.example/v1beta", api, models: [] },
      },
    });
    expect(resolved?.api).toBe(api ?? directApi);
  },
);

it("resolves Antigravity Gemini 3.1 flash variants from the flash template", () => {
  const models = [
    template(antigravity, "gemini-3-flash", { api: antigravityApi, contextWindow: 1_048_576 }),
  ];

  for (const id of ["gemini-3.1-flash-preview", lite]) {
    expectResolution(antigravity, id, models, { api: antigravityApi, contextWindow: 1_048_576 });
  }
});

it("returns undefined for Antigravity Gemini 3.1 models without a matching template", () => {
  const model = resolveModel(antigravity, "gemini-3.1-pro-preview-customtools", [
    template(antigravity, "claude-opus-4-6-thinking"),
  ]);

  expect(model).toBeUndefined();
});

it.each([
  ["gemini-2.5-pro", true],
  ["gemini-3.7-flash", true],
  ["gemini-4-argon", true],
  ["gemini-1.5-pro", false],
  ["gemini-pro-latest", true],
  ["gemini-flash-latest", true],
  ["gemini-flash-lite-latest", true],
  ["gemma-4-26b-a4b-it", true],
] as const)("classifies modern Google model %s as %s", (id, expected) => {
  expect(isModernGoogleModel(id)).toBe(expected);
});

it("keeps non-chat Gemini surfaces out of text discovery and forward compatibility", () => {
  for (const modelId of [
    "gemini-3.1-flash-image",
    "gemini-3.1-flash-tts-preview",
    "gemini-3.1-flash-live-preview",
    "gemini-2.5-flash-preview-native-audio-dialog",
  ]) {
    expect(isGoogleTextGenerationModelId(modelId)).toBe(false);
    expect(resolveModel(google, modelId, [template(google, flash)])).toBeUndefined();
  }
});

it("classifies only ordinary Gemini generation ids as Gemini text models", () => {
  expect(isGoogleGeminiTextModelId("models/gemini-flash-latest")).toBe(true);
  for (const modelId of [
    "tunedModels/gemini-2.5-flash",
    "gemini-2.5-computer-use-preview",
    "gemma-4-26b-a4b-it",
  ]) {
    expect(isGoogleGeminiTextModelId(modelId), modelId).toBe(false);
  }
});
