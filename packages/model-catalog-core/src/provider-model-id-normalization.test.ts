import { expect, it } from "vitest";
import {
  collectManifestModelIdNormalizationPolicies,
  type ManifestModelIdNormalizationProvider,
  normalizeConfiguredProviderCatalogModelId as configuredId,
  normalizeStaticProviderModelIdWithPolicies as staticId,
  stripSelfProviderModelPrefix,
} from "./provider-model-id-normalization.js";

function policiesFor(provider: string, policy: ManifestModelIdNormalizationProvider) {
  return collectManifestModelIdNormalizationPolicies([
    { modelIdNormalization: { providers: { [provider]: policy } } },
  ]);
}

const prototypeLikeModels = ["constructor", "__proto__", "toString"];
const aliasProviders = ["anthropic", "vercel-ai-gateway", "xai", "fixture"];

it.each(
  aliasProviders.flatMap((provider) => prototypeLikeModels.map((model) => ({ provider, model }))),
)("requires an own alias for $provider model ID $model", ({ provider, model }) => {
  expect(configuredId(provider, model, policiesFor("fixture", { aliases: {} }))).toBe(model);
  const policies = policiesFor(provider, {
    aliases: Object.fromEntries([[model.toLowerCase(), "custom-model"]]),
  });
  expect(configuredId(provider, model, policies)).toBe("custom-model");
});

it("applies manifest policies before built-in provider normalization", () => {
  const policies = policiesFor("Google-Vertex", { aliases: { pro: "gemini-3-pro" } });
  expect(staticId("google-vertex", "pro", policies)).toBe("gemini-3.1-pro-preview");
});

it.each([
  ["gemini-3-pro-preview", "gemini-3.1-pro-preview"],
  ["gemma-4-26b", "gemma-4-26b-a4b-it"],
])("normalizes gateway-prefixed Google catalog ref %s", (model, expected) => {
  expect(configuredId("openrouter", `openrouter/google/${model}`)).toBe(
    `openrouter/google/${expected}`,
  );
});

it.each([staticId, configuredId])("strips the native Anthropic prefix through %s", (normalize) => {
  expect(normalize("anthropic", "anthropic/claude-haiku-4-5")).toBe("claude-haiku-4-5");
});

it("resolves Anthropic aliases while keeping version pins", () => {
  for (const [alias, model] of Object.entries({
    opus: "claude-opus-5-5",
    "opus-5.5": "claude-opus-5-5",
    "anthropic/opus": "claude-opus-5-5",
    "claude-opus-5": "claude-opus-5",
    "opus-5": "claude-opus-5",
    sonnet: "claude-sonnet-5-5",
    fable: "claude-fable-5-1",
    haiku: "claude-haiku-5-5",
    "opus-4.7": "claude-opus-4-7",
  })) {
    expect(staticId("anthropic", alias)).toBe(model);
  }
});

it.each([
  ["sonnet", "anthropic/claude-sonnet-4-6"],
  ["sonnet-5", "anthropic/claude-sonnet-5"],
])("resolves gateway alias %s", (alias, expected) => {
  expect(staticId("vercel-ai-gateway", alias)).toBe(expected);
});

it.each([
  ["google", "gemini-2.0-flash"],
  ["google-gemini-cli", "gemini-2.0-flash"],
  ["google-vertex", "gemini-3-pro-preview"],
  ["xai", "grok-4-fast-reasoning"],
  ["openai", "gpt-5.4"],
  ["vercel-ai-gateway", "opus-4.6"],
])("preserves the native %s catalog prefix", (provider, model) => {
  const ref = `${provider}/${model}`;
  expect(staticId(provider, ref)).toBe(ref);
});

it("strips self provider model prefixes before runtime provider calls", () => {
  expect(stripSelfProviderModelPrefix("google", "google/gemini-2.0-flash")).toBe(
    "gemini-2.0-flash",
  );
});
it("strips by the matched length when the manifest prefix differs in case and spacing", () => {
  const policies = policiesFor("openai", { stripPrefixes: [" OpenAI/ "] });
  expect(staticId("openai", "openai/gpt-4", policies)).toBe("gpt-4");
});
