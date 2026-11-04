import type { DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { expect, it } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import type { RuntimeConfig } from "./config.js";
import { createPreparedDecisionProvider } from "./decisions.js";

type ProviderConfig = NonNullable<RuntimeConfig["providerConfig"]>;
type Decision = NonNullable<
  NonNullable<DecisionProviderContextV2["model"]["inference"]>["decision"]
>;
const config = { apiKey: "synthetic-key", timeoutMs: 2000 };
const hosted = "https://api.typesafe.ai/v1";
const pinned = manifest.modelCatalog.providers.typesafe.models.find(
  (model) => model.id === "jev-1.13.0",
)!;
const row = (decision: Decision, id = pinned.id) => ({
  provider: "typesafe",
  id,
  name: id === pinned.id ? pinned.name : id,
  ...(id === pinned.id ? { baseUrl: pinned.baseUrl } : {}),
  inference: { chat: false as const, decision },
});
const facts: Decision = {
  protocol: "typesafe-systemone",
  input: ["text", "image"],
  limits: {
    maxRequestTokens: 64000,
    maxStateAndQuestionTokens: 32000,
    image: { maxBytes: 4194304, mimeTypes: ["image/png", "image/jpeg"], remoteUrls: false },
  },
  billing: { unit: "tokens", source: "provider-docs", usdPerMillion: { input: 0.042, output: 0 } },
};
const {
  maxRequestTokens: _request,
  maxStateAndQuestionTokens: _question,
  ...imageLimits
} = facts.limits!;
const unlimited = { ...facts, limits: imageLimits };
const { billing: _billing, limits: _limits, ...customFacts } = facts;
const unbound = { ...customFacts, input: ["text" as const] };
const runtime = (overrides: Partial<ProviderConfig> = {}): RuntimeConfig => ({
  ...config,
  providerConfig: { baseUrl: hosted, models: [], ...overrides },
});
const unresolved = { source: "env" as const, provider: "default", id: "UNRESOLVED_HEADER" };
const auth = { mode: "authorization-bearer" as const, token: unresolved };
const enabled = { "TYPESAFE-DANGER-ZONE-LONG-CONTEXT": "true" };
const disabled = { "typesafe-danger-zone-long-context": "false" };
const model: ProviderConfig["models"][number] = {
  id: pinned.id,
  name: pinned.name,
  reasoning: false,
  input: ["text"],
  contextWindow: 4096,
  maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  headers: enabled,
};
function catalog(settings: RuntimeConfig, entries = [row(facts)]) {
  const provider = createPreparedDecisionProvider(() => settings).provider!;
  return { provider, rows: provider.augmentModelCatalog!({ env: {}, entries }) };
}

it.each([
  {
    provider: "openrouter",
    modelId: "deepseek/deepseek-v4.1-flash-1017",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  { provider: "openai", modelId: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" },
])("leaves $provider transport unchanged", ({ provider, modelId, baseUrl }) => {
  const { normalizeTransport } = createPreparedDecisionProvider(() => config).provider!;
  expect(
    normalizeTransport?.({
      provider,
      modelId,
      api: "openai-completions",
      baseUrl,
    }),
  ).toBeUndefined();
});

it.each<[RuntimeConfig, Decision, string?]>([
  [config, facts, hosted],
  [runtime({ baseUrl: "https://api.typesafe.ai" }), facts, hosted],
  [runtime({ baseUrl: "https://api.typesafe.ai/v1/" }), facts, hosted],
  [{ baseUrl: "http://127.0.0.1:8765", timeoutMs: 2000 }, unbound, "http://127.0.0.1:8765/v1"],
  [
    runtime({ baseUrl: "https://systemone.fixture.invalid/v1" }),
    unbound,
    "https://systemone.fixture.invalid/v1",
  ],
  [
    runtime({ baseUrl: "https://api.typesafe.ai/custom/v1" }),
    unbound,
    "https://api.typesafe.ai/custom/v1",
  ],
  [runtime({ headers: enabled }), unlimited],
  [runtime({ headers: disabled, models: [model] }), unlimited],
  [runtime({ headers: disabled, request: { headers: enabled } }), unlimited],
  [runtime({ headers: { "TypeSafe-Danger-Zone-Long-Context": unresolved } }), unlimited],
  [runtime({ headers: enabled, request: { headers: disabled } }), facts],
  [runtime({ headers: { "x-api-key": unresolved }, request: { auth } }), facts],
])("binds catalog facts to route and effective headers %j", async (settings, expected, baseUrl) => {
  const { provider, rows } = catalog(settings);
  expect((await rows)?.[0]?.inference?.decision).toEqual(expected);
  if (baseUrl) {
    expect(provider.normalizeTransport?.({ provider: "typesafe", modelId: model.id })).toEqual({
      baseUrl,
    });
  }
});

it("preserves native catalog rows, enriches V1, and unbinds only hosted facts", async () => {
  const decision: Decision = {
    ...facts,
    billing: { unit: "requests", source: "provider-catalog" },
    limits: { ...facts.limits, maxQuestions: 12 },
  };
  const native = row({ ...facts, protocol: "pinned" }, "pinned");
  const { rows } = catalog(runtime({ baseUrl: "https://systemone.fixture.invalid/v1" }), [
    row(decision),
    native,
    row({ protocol: "decision-v1", input: ["text"] }, "legacy"),
  ]);
  const result = await rows;
  expect(result?.[1]).toEqual(native);
  expect(result?.[2]?.inference?.decision?.protocol).toBe("typesafe-systemone");
  expect(result?.[0]?.inference).toEqual({
    chat: false,
    decision: { ...decision, input: ["text"], limits: { maxQuestions: 12 } },
  });
});
