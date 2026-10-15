import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  formatAgentRunRouteChange,
  type AgentRunTerminalReceipt,
} from "./agent-run-terminal-receipt.js";
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

describe("isProviderModelRerouted", () => {
  it("keeps an equivalent vendor wire id from producing a model-switch fact", () => {
    const requested = { provider: "arcee", model: "trinity-large-thinking" };
    const effective = {
      provider: "arcee",
      model: "arcee-ai/trinity-large-thinking",
      responseModel: "arcee-ai/trinity-large-thinking",
    };
    const rerouted = isProviderModelRerouted(requested, effective);
    expect(rerouted).toBe(false);
    expect(
      formatAgentRunRouteChange(
        { ...visibleRerouteReceipt, requested, effective, rerouted },
        "run-1",
      ),
    ).toBeUndefined();
  });

  describe("with a configured model row declaring response model equivalence", () => {
    const declaredConfig = (
      provider: string,
      modelId: string,
      overrides: Partial<ModelDefinitionConfig> = {},
    ): OpenClawConfig => ({
      models: {
        providers: {
          [provider]: {
            baseUrl: "https://endpoint.example/v1",
            models: [
              {
                id: modelId,
                name: modelId,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 8_192,
                responseModelEquivalent: true,
                ...overrides,
              },
            ],
          },
        },
      },
    });
    const requested = { provider: "broker", model: "team/chat" };
    const config = declaredConfig("broker", "team/chat");

    it("keeps the endpoint's concrete response model from producing a model-switch fact", () => {
      const effective = { ...requested, responseModel: "upstream-model-2026-10-01" };
      expect(isProviderModelRerouted(requested, effective, config)).toBe(false);
      expect(isProviderModelRerouted(requested, effective)).toBe(true);
    });

    it.each([
      { provider: "broker", model: "team/utility", responseModel: "upstream-model" },
      { provider: "other-broker", model: "team/chat", responseModel: "upstream-model" },
    ])("retains a fallback to $provider/$model", (effective) => {
      expect(isProviderModelRerouted(requested, effective, config)).toBe(true);
    });

    it("ignores a catalog-authored row", () => {
      expect(
        isProviderModelRerouted(
          requested,
          { ...requested, responseModel: "upstream-model" },
          declaredConfig("broker", "team/chat", { metadataSource: "models-add" }),
        ),
      ).toBe(true);
    });

    it("keeps bundled provider policy authoritative", () => {
      const openaiRequested = { provider: "openai", model: "gpt-5.6" };
      const effective = { ...openaiRequested, responseModel: "gpt-5.6-luna" };
      expect(isProviderModelRerouted(openaiRequested, effective)).toBe(true);
      expect(
        isProviderModelRerouted(openaiRequested, effective, declaredConfig("openai", "gpt-5.6")),
      ).toBe(true);
    });

    it.each([{ provider: "partner-chat", origin: "global" as const, rerouted: false }])(
      "respects $origin catalog alias ownership for $provider",
      ({ rerouted, provider, ...owner }) => {
        const snapshot = createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "catalog-owner",
              providers: ["catalog-provider"],
              modelCatalog: { aliases: { [provider]: { provider: "catalog-provider" } } },
              ...owner,
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
          ).toBe(rerouted);
        });
      },
    );
  });

  it.each([{ requested: "gpt-5.6-luna", response: "gpt-5.6-luna-2026-08-02", rerouted: false }])(
    "classifies an OpenAI $requested run answered as $response as rerouted=$rerouted",
    ({ requested, response, rerouted }) => {
      expect(
        isProviderModelRerouted(
          { provider: "openai", model: requested },
          { provider: "openai", model: requested, responseModel: response },
        ),
      ).toBe(rerouted);
    },
  );
});

describe("formatAgentRunRouteChange", () => {
  it("uses the producer response model", () => {
    expect(formatAgentRunRouteChange(visibleRerouteReceipt, "run-1")).toBe(
      "Model route changed: provider/requested → provider/actual.",
    );
  });

  it("redacts and bounds route text", () => {
    const secret = `sk-${"s".repeat(96)}`;
    const routeChange = formatAgentRunRouteChange(
      {
        runId: "run-1",
        sessionId: "session-1",
        turnId: "turn-1",
        requested: { provider: "provider", model: secret },
        effective: {
          provider: "provider",
          model: "configured",
          responseModel: "m".repeat(500),
        },
        successfulToolNames: [],
        rerouted: true,
        terminalDisposition: "visible",
      },
      "run-1",
    );

    expect(routeChange).not.toContain(secret);
    expect(routeChange?.length).toBeLessThanOrEqual(320);
  });
});
