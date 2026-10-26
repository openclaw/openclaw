import type { DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { expect, it } from "vitest";
import type { RuntimeConfig } from "./config.js";
import { createPreparedDecisionProvider } from "./decisions.js";
const config = { apiKey: "synthetic-key", timeoutMs: 2000 };

type ProviderConfig = NonNullable<RuntimeConfig["providerConfig"]>;
type Inference = NonNullable<DecisionProviderContextV2["model"]["inference"]>;
const catalogRow = (id: string, decision: Inference["decision"]) => ({
  provider: "typesafe",
  id,
  name: id,
  inference: { chat: false as const, decision },
});

it("preserves native facts and enriches V1 catalog entries", async () => {
  const native = catalogRow("pinned", {
    protocol: "pinned",
    input: ["text"],
    billing: { unit: "tokens", source: "provider-docs", usdPerMillion: { input: 0.01 } },
  });
  const legacy = catalogRow("legacy", { protocol: "decision-v1", input: ["text"] });
  const provider = createPreparedDecisionProvider(() => config);
  const rows = await provider.provider?.augmentModelCatalog?.({
    env: {},
    entries: [native, legacy],
  });
  expect(rows?.find((row) => row.id === "pinned")).toEqual(native);
  expect(rows?.find((row) => row.id === "legacy")?.inference?.decision?.protocol).toBe(
    "typesafe-systemone",
  );
});

const pinnedRow = catalogRow("jev-1.13.0", {
  protocol: "typesafe-systemone",
  input: ["text"],
  limits: { maxRequestTokens: 64000, maxStateAndQuestionTokens: 32000 },
  billing: {
    unit: "tokens",
    source: "provider-docs",
    usdPerMillion: { input: 0.042, output: 0 },
  },
});
const pinnedFacts = pinnedRow.inference.decision!;
async function preparedFacts(runtime: RuntimeConfig) {
  const provider = createPreparedDecisionProvider(() => runtime);
  const rows = await provider.provider?.augmentModelCatalog?.({ env: {}, entries: [pinnedRow] });
  return { facts: rows?.[0]?.inference?.decision, provider };
}
function configuredModel(overrides: Partial<ProviderConfig["models"][number]> = {}) {
  return {
    id: pinnedRow.id,
    name: pinnedRow.name,
    reasoning: false,
    input: ["text" as const],
    contextWindow: 4096,
    maxTokens: 256,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}
function configuredRuntime(overrides: Partial<ProviderConfig> = {}): RuntimeConfig {
  return {
    ...config,
    providerConfig: { baseUrl: "https://api.typesafe.ai/v1", models: [], ...overrides },
  };
}
const secretRef = (id: string) => ({ source: "env" as const, provider: "default", id });
const longContext = (
  value: string | ReturnType<typeof secretRef>,
  name = "TypeSafe-Danger-Zone-Long-Context",
) => ({
  [name]: value,
});
const enabled = longContext("true", "typesafe-danger-zone-long-context");
const disabled = longContext("false");
const request = (headers: ProviderConfig["headers"]) => ({ request: { headers } });
const model = configuredModel({
  headers: longContext("true", "TYPESAFE-DANGER-ZONE-LONG-CONTEXT"),
});
const unresolvedKey = secretRef("UNRESOLVED_SYNTHETIC_KEY");

it.each([undefined, "https://api.typesafe.ai", "https://api.typesafe.ai/v1/"])(
  "retains hosted facts on normalized root %s",
  async (baseUrl) => {
    const runtime = baseUrl === undefined ? config : configuredRuntime({ baseUrl });
    const { facts, provider } = await preparedFacts(runtime);
    expect(facts).toEqual(pinnedFacts);
    expect(
      provider.provider?.normalizeTransport?.({ provider: "typesafe", modelId: pinnedRow.id }),
    ).toEqual({ baseUrl: "https://api.typesafe.ai/v1" });
  },
);

it.each([
  { baseUrl: "http://127.0.0.1:8765", timeoutMs: 2000 },
  configuredRuntime({ baseUrl: "https://systemone.fixture.invalid/v1" }),
  configuredRuntime({ baseUrl: "https://api.typesafe.ai/custom/v1" }),
  configuredRuntime({ baseUrl: "https://api.typesafe.ai/v1/systemone" }),
])("unbinds hosted facts on custom routes", async (runtime) => {
  const { facts } = await preparedFacts(runtime);
  const { billing: _billing, limits: _limits, ...unbound } = pinnedFacts;
  expect(facts).toEqual(unbound);
});

const { limits: _hostedLimits, ...unlimitedFacts } = pinnedFacts;
it.each<[Partial<ProviderConfig>, boolean]>([
  [{ headers: enabled }, false],
  [{ headers: disabled, models: [model] }, false],
  [{ headers: disabled, ...request(enabled) }, false],
  [{ headers: longContext(secretRef("UNRESOLVED_SYNTHETIC_HEADER")) }, false],
  [{ headers: enabled, ...request(disabled) }, true],
  [
    {
      headers: { "x-api-key": unresolvedKey },
      request: { auth: { mode: "authorization-bearer", token: unresolvedKey } },
    },
    true,
  ],
])("binds hosted limits with effective headers %j", async (overrides, limited) => {
  const { facts } = await preparedFacts(configuredRuntime(overrides));
  expect(facts).toEqual(limited ? pinnedFacts : unlimitedFacts);
});

it("retains catalog billing and non-token limits on custom routes", async () => {
  const decision: NonNullable<Inference["decision"]> = {
    ...pinnedFacts,
    billing: { unit: "requests", source: "provider-catalog" },
    limits: { ...pinnedFacts.limits, maxQuestions: 12 },
  };
  const runtime = configuredRuntime({ baseUrl: "https://systemone.fixture.invalid/v1" });
  const provider = createPreparedDecisionProvider(() => runtime);
  const rows = await provider.provider?.augmentModelCatalog?.({
    env: {},
    entries: [{ ...pinnedRow, inference: { ...pinnedRow.inference, decision } }],
  });
  expect(rows?.[0]?.inference).toEqual({
    ...pinnedRow.inference,
    decision: { ...decision, limits: { maxQuestions: 12 } },
  });
});
