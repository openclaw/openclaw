import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import {
  acquireSimpleCompletionModelForAgent,
  resolveSimpleCompletionSelectionForAgent as resolveSelection,
} from "./simple-completion-runtime.js";
import type { SimpleCompletionModelResolver } from "./simple-completion-scope.js";
import { completionConfig, completionModelDefinition } from "./simple-completion.test-support.js";

type AgentConfig = NonNullable<OpenClawConfig["agents"]>;
function withAgents(defaults: AgentConfig["defaults"], entries?: AgentConfig["entries"]) {
  return { agents: { defaults, entries } };
}
const utilityDefaults = {
  model: "anthropic/claude-opus-4-6",
  utilityModel: "openai/gpt-5.4-mini",
};
function expectRoute(
  cfg: OpenClawConfig,
  provider: string,
  modelId: string,
  params: Partial<Omit<Parameters<typeof resolveSelection>[0], "cfg">> & {
    rawConfig?: boolean;
  } = {},
  profileId?: string,
) {
  const { rawConfig, ...selectionParams } = params;
  expect(
    resolveSelection({
      agentId: "main",
      ...selectionParams,
      cfg: rawConfig ? cfg : createCanonicalAgentConfigFixture(cfg).config,
    }),
  ).toMatchObject({ provider, modelId, ...(profileId ? { profileId } : {}) });
}

it("resolves explicit aliases in the selected agent scope", () => {
  const cfg = withAgents(
    { model: "openai/global-model", models: { "openai/global-model": { alias: "fast" } } },
    { worker: { models: { "anthropic/worker-model": { alias: "fast" } } } },
  );
  expectRoute(cfg, "anthropic", "worker-model", {
    agentId: "worker",
    modelRef: "fast",
    rawConfig: true,
  });
  expectRoute(cfg, "openai", "global-model", { modelRef: "fast", rawConfig: true });
});

it.each([
  ["openrouter/aurora-alpha", false],
  ["openrouter/aurora-alpha@harness-profile", true],
  ["harness-only[context=272k]@harness-profile", true],
] as const)("selects the native completion route for %s ACP=%s", (model, acp) => {
  const cfg = withAgents(
    { model: "anthropic/claude-opus-4-6@native-profile" },
    { ops: { model, ...(acp ? { runtime: { type: "acp" } } : {}) } },
  );
  expectRoute(
    cfg,
    acp ? "anthropic" : "openrouter",
    acp ? "claude-opus-4-6" : "openrouter/aurora-alpha",
    { agentId: "ops" },
    acp ? "native-profile" : undefined,
  );
});

it.each([
  [true, utilityDefaults.utilityModel, "openai", "gpt-5.4-mini"],
  ["required", utilityDefaults.utilityModel, "openai", "gpt-5.4-mini"],
  [false, utilityDefaults.utilityModel, "anthropic", "claude-opus-4-6"],
  [true, "", "anthropic", "claude-opus-4-6"],
] as const)(
  "selects utility mode %s with model %s",
  (useUtilityModel, utilityModel, provider, id) => {
    expectRoute(withAgents({ ...utilityDefaults, utilityModel }), provider, id, {
      useUtilityModel,
    });
  },
);

it.each([
  [undefined, "google", "gemini-3.1-flash-lite"],
  ["openrouter/mistralai/mistral-small", "openrouter", "mistralai/mistral-small"],
])("prefers agent utility routing with override %s", (modelRef, provider, modelId) => {
  const cfg = withAgents(utilityDefaults, {
    ops: { utilityModel: "google/gemini-3.1-flash-lite-preview" },
  });
  expectRoute(cfg, provider, modelId, { agentId: "ops", modelRef, useUtilityModel: true });
});

it.each([
  { label: "disabled", utilityModel: "" },
  { label: "unavailable", utilityModel: undefined },
  { label: "invalid", utilityModel: "/" },
  { label: "invalid override", utilityModel: "fixture/utility", modelRef: "/" },
])(
  "does not prepare the primary when required utility routing is $label",
  async ({ utilityModel, modelRef }) => {
    const cfg = withAgents({ model: "fixture/primary", utilityModel }, { main: {} });
    const params = { cfg, agentId: "main", modelRef, useUtilityModel: "required" as const };
    expect(resolveSelection({ ...params, manifestPlugins: [] })).toBeNull();
    const modelResolver = vi.fn<SimpleCompletionModelResolver>();
    await expect(
      acquireSimpleCompletionModelForAgent({ ...params, modelResolver }),
    ).resolves.toEqual({ error: "No model configured for agent main." });
    expect(modelResolver).not.toHaveBeenCalled();
  },
);

it("allows an explicit operation when required utility routing is disabled", () => {
  expectRoute(
    withAgents({ model: "fixture/primary", utilityModel: "" }, { main: {} }),
    "fixture",
    "operation",
    { modelRef: "fixture/operation", useUtilityModel: "required", rawConfig: true },
  );
});

it("resolves alias refs before parsing provider/model", () => {
  const cfg = withAgents({
    model: "fast@work",
    models: { "openrouter/anthropic/claude-sonnet-4-6": { alias: "fast" } },
  });
  expectRoute(cfg, "openrouter", "anthropic/claude-sonnet-4-6", {}, "work");
});

it("falls back to the runtime default", () => {
  expectRoute({}, "openai", "gpt-6-astra");
});

it("uses the configured provider model when the runtime default is unavailable", () => {
  expectRoute(
    completionConfig("openai", {
      baseUrl: "https://api.openai.com/v1",
      models: [completionModelDefinition({ id: "gpt-5" })],
    }),
    "openai",
    "gpt-5",
  );
});
