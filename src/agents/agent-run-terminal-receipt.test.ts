import { expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  formatAgentRunRouteChange,
  type AgentRunTerminalReceipt,
} from "./agent-run-terminal-receipt.js";
import { makeModel } from "./embedded-agent-runner/model.test-harness.js";
import { isProviderModelRerouted } from "./provider-model-route.js";

const visibleRerouteReceipt: AgentRunTerminalReceipt = {
  runId: "run-1",
  sessionId: "session-1",
  turnId: "turn-1",
  requested: { provider: "provider", model: "requested" },
  effective: { provider: "provider", model: "configured", responseModel: "actual" },
  successfulToolNames: [],
  rerouted: true,
  terminalDisposition: "visible",
};
function declaredConfig(
  provider = "broker",
  modelId = "team/chat",
  overrides: Partial<ModelDefinitionConfig> = {},
): OpenClawConfig {
  const row = { ...makeModel(modelId), responseModelEquivalent: true, ...overrides };
  const providerConfig = { baseUrl: "https://endpoint.example/v1", models: [row] };
  return { models: { providers: { [provider]: providerConfig } } };
}

const vendorWireId = "arcee-ai/trinity-large-thinking";
it.each([
  ["arcee", "trinity-large-thinking", vendorWireId, vendorWireId],
  ["openai", "gpt-5.6-luna", "gpt-5.6-luna", "gpt-5.6-luna-2026-08-02"],
])(
  "keeps %s/%s wire equivalents from producing a model-switch fact",
  (provider, model, selected, responseModel) => {
    const requested = { provider, model };
    const effective = { provider, model: selected, responseModel };
    const rerouted = isProviderModelRerouted(requested, effective);
    expect(rerouted).toBe(false);
    expect(
      formatAgentRunRouteChange(
        { ...visibleRerouteReceipt, requested, effective, rerouted },
        "run-1",
      ),
    ).toBeUndefined();
  },
);

const brokerRequested = { provider: "broker", model: "team/chat" };
const config = declaredConfig();
const brokerEffective = { ...brokerRequested, responseModel: "upstream-model-2026-10-01" };
const catalogConfig = declaredConfig("broker", "team/chat", { metadataSource: "models-add" });
it.each([
  ["declared endpoint", {}, config, false],
  ["undeclared endpoint", {}, undefined, true],
  ["model fallback", { model: "team/utility" }, config, true],
  ["provider fallback", { provider: "other-broker" }, config, true],
  ["catalog-authored row", {}, catalogConfig, true],
] satisfies Array<[string, Partial<typeof brokerRequested>, OpenClawConfig | undefined, boolean]>)(
  "classifies %s",
  (_name, changes, cfg, expected) => {
    expect(isProviderModelRerouted(brokerRequested, { ...brokerEffective, ...changes }, cfg)).toBe(
      expected,
    );
  },
);

it("keeps bundled provider policy authoritative", () => {
  const openaiRequested = { provider: "openai", model: "gpt-5.6" };
  const effective = { ...openaiRequested, responseModel: "gpt-5.6-luna" };
  expect(isProviderModelRerouted(openaiRequested, effective)).toBe(true);
  expect(
    isProviderModelRerouted(openaiRequested, effective, declaredConfig("openai", "gpt-5.6")),
  ).toBe(true);
});

it("respects global catalog alias ownership for partner-chat", () => {
  const provider = "partner-chat";
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "catalog-owner",
        providers: ["catalog-provider"],
        modelCatalog: { aliases: { [provider]: { provider: "catalog-provider" } } },
        origin: "global",
      },
    ],
  });
  withPluginMetadataSnapshotScope(snapshot, () => {
    const alias = { provider, model: "team/chat" };
    expect(
      isProviderModelRerouted(
        alias,
        { ...alias, responseModel: "upstream-model" },
        declaredConfig(provider, alias.model),
      ),
    ).toBe(false);
  });
});
it("uses the producer response model", () => {
  expect(formatAgentRunRouteChange(visibleRerouteReceipt, "run-1")).toBe(
    "Model route changed: provider/requested → provider/actual.",
  );
});

it("redacts and bounds route text", () => {
  const secret = `sk-${"s".repeat(96)}`;
  const routeChange = formatAgentRunRouteChange(
    {
      ...visibleRerouteReceipt,
      requested: { provider: "provider", model: secret },
      effective: {
        ...visibleRerouteReceipt.effective,
        responseModel: "m".repeat(500),
      },
    },
    "run-1",
  );

  expect(routeChange).not.toContain(secret);
  expect(routeChange?.length).toBeLessThanOrEqual(320);
});
