import type { DecisionBatch, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { evaluate } from "./client.js";
import type { RuntimeConfig } from "./config.js";
import { createPreparedDecisionProvider } from "./decisions.js";
import { EvaluationError } from "./errors.js";
import { legacyWireFixture } from "./prepared.test-support.js";
vi.mock("./client.js", () => ({ evaluate: vi.fn() }));
const batch: DecisionBatch = {
  state: "synthetic",
  questions: { b: { type: "boolean" } },
};
const context = () => ({
  model: "jev-agent-selected",
  agentId: "research",
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 500,
});
const config = { apiKey: "synthetic-key", timeoutMs: 2000 };
beforeEach(() => {
  vi.mocked(evaluate).mockReset();
});
describe("host decision adapter", () => {
  it("does not convert caller cancellation or implementation errors into fallback", async () => {
    const provider = legacyWireFixture(
      createPreparedDecisionProvider(() => config),
      () => config,
    );
    const controller = new AbortController();
    vi.mocked(evaluate).mockImplementation(async () => {
      controller.abort(new Error("caller closed"));
      throw new EvaluationError("cancelled", "transport");
    });
    await expect(
      provider.evaluate(batch, {
        ...context(),
        signal: controller.signal,
      }),
    ).rejects.toThrow("caller closed");
    vi.mocked(evaluate).mockRejectedValue(new Error("private detail"));
    const failure = provider.evaluate(batch, context());
    await expect(failure).rejects.toMatchObject({
      name: "Error",
      message: "TypeSafe decision adapter contract failure.",
    });
    await expect(failure).rejects.not.toHaveProperty("cause");
  });
});

it("preserves canonical per-model capability and billing facts while enriching V1 input", async () => {
  const native = {
    provider: "typesafe",
    id: "pinned",
    name: "Pinned",
    inference: {
      chat: false as const,
      decision: {
        protocol: "pinned",
        input: ["text" as const],
        billing: {
          unit: "tokens" as const,
          source: "provider-docs" as const,
          usdPerMillion: { input: 0.01 },
        },
      },
    },
  };
  const legacy = {
    provider: "typesafe",
    id: "legacy",
    name: "Legacy",
    inference: {
      chat: false as const,
      decision: { protocol: "decision-v1", input: ["text" as const] },
    },
  };
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

type ProviderConfig = NonNullable<RuntimeConfig["providerConfig"]>;
type Inference = NonNullable<DecisionProviderContextV2["model"]["inference"]>;
const pinned = manifest.modelCatalog.providers.typesafe.models.find(
  (model) => model.id === "jev-1.13.0",
)!;
const pinnedRow = {
  id: pinned.id,
  name: pinned.name,
  baseUrl: pinned.baseUrl,
  provider: "typesafe",
  inference: {
    chat: false,
    decision: {
      protocol: "typesafe-systemone",
      input: ["text"],
      limits: { maxRequestTokens: 64000, maxStateAndQuestionTokens: 32000 },
      billing: {
        unit: "tokens",
        source: "provider-docs",
        usdPerMillion: { input: 0.042, output: 0 },
      },
    },
  } satisfies Inference,
};
async function preparedFacts(runtime: RuntimeConfig) {
  const provider = createPreparedDecisionProvider(() => runtime);
  const rows = await provider.provider?.augmentModelCatalog?.({ env: {}, entries: [pinnedRow] });
  return { facts: rows?.[0]?.inference?.decision, provider };
}
function configuredModel(overrides: Partial<ProviderConfig["models"][number]> = {}) {
  return {
    id: pinned.id,
    name: pinned.name,
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

it.each([undefined, "https://api.typesafe.ai", "https://api.typesafe.ai/v1/"])(
  "keeps pinned hosted facts on the matching normalized API root (%s)",
  async (baseUrl) => {
    const runtime = baseUrl === undefined ? config : configuredRuntime({ baseUrl });
    const { facts, provider } = await preparedFacts(runtime);
    expect(facts).toEqual(pinnedRow.inference.decision);
    expect(
      provider.provider?.normalizeTransport?.({ provider: "typesafe", modelId: pinned.id }),
    ).toEqual({ baseUrl: "https://api.typesafe.ai/v1" });
  },
);

it.each([
  { baseUrl: "http://127.0.0.1:8765", timeoutMs: 2000 },
  configuredRuntime({ baseUrl: "https://systemone.fixture.invalid/v1" }),
  configuredRuntime({ baseUrl: "https://api.typesafe.ai/custom/v1" }),
  configuredRuntime({ baseUrl: "https://api.typesafe.ai/v1/systemone" }),
])("does not carry hosted billing or limits onto a different physical route", async (runtime) => {
  const { facts } = await preparedFacts(runtime);
  expect(facts?.billing).toBeUndefined();
  expect(facts?.limits).toBeUndefined();
  expect(facts?.protocol).toBe("typesafe-systemone");
  expect(pinnedRow.inference.decision.billing).toBeDefined();
});

it.each<Partial<ProviderConfig>>([
  { headers: { "TypeSafe-Danger-Zone-Long-Context": "true" } },
  {
    headers: { "typesafe-danger-zone-long-context": "false" },
    models: [configuredModel({ headers: { "TYPESAFE-DANGER-ZONE-LONG-CONTEXT": "true" } })],
  },
  {
    headers: { "TypeSafe-Danger-Zone-Long-Context": "false" },
    request: { headers: { "typesafe-danger-zone-long-context": "true" } },
  },
])(
  "withdraws default context limits when effective long-context mode is enabled",
  async (overrides) => {
    const { facts } = await preparedFacts(configuredRuntime(overrides));
    expect(facts?.limits).toBeUndefined();
    expect(facts?.billing).toEqual(pinnedRow.inference.decision.billing);
  },
);

it("uses final request header precedence instead of the provider long-context setting", async () => {
  const { facts } = await preparedFacts(
    configuredRuntime({
      headers: { "TypeSafe-Danger-Zone-Long-Context": "true" },
      request: { headers: { "typesafe-danger-zone-long-context": "false" } },
    }),
  );
  expect(facts).toEqual(pinnedRow.inference.decision);
});

it("preserves canonical catalog billing without carrying hosted token limits to a custom route", async () => {
  const inference: Inference = {
    ...pinnedRow.inference,
    decision: {
      ...pinnedRow.inference.decision,
      billing: { unit: "requests", source: "provider-catalog" },
      limits: { ...pinnedRow.inference.decision.limits, maxQuestions: 12 },
    },
  };
  const runtime = configuredRuntime({
    baseUrl: "https://systemone.fixture.invalid/v1",
  });
  const provider = createPreparedDecisionProvider(() => runtime);
  const rows = await provider.provider?.augmentModelCatalog?.({
    env: {},
    entries: [{ ...pinnedRow, inference }],
  });
  expect(rows?.[0]?.inference).toEqual({
    ...inference,
    decision: { ...inference.decision, limits: { maxQuestions: 12 } },
  });
});

it("keeps unresolved unrelated secrets out of catalog fact binding", async () => {
  const { facts } = await preparedFacts(
    configuredRuntime({
      headers: {
        "x-api-key": { source: "env", provider: "default", id: "UNRESOLVED_SYNTHETIC_KEY" },
      },
      request: {
        auth: {
          mode: "authorization-bearer",
          token: { source: "env", provider: "default", id: "UNRESOLVED_SYNTHETIC_KEY" },
        },
      },
    }),
  );
  expect(facts).toEqual(pinnedRow.inference.decision);
});

it("withdraws default limits while the long-context header is unresolved", async () => {
  const { facts } = await preparedFacts(
    configuredRuntime({
      headers: {
        "TypeSafe-Danger-Zone-Long-Context": {
          source: "env",
          provider: "default",
          id: "UNRESOLVED_SYNTHETIC_HEADER",
        },
      },
    }),
  );
  expect(facts?.limits).toBeUndefined();
  expect(facts?.billing).toEqual(pinnedRow.inference.decision.billing);
});
