// Telnyx tests cover index plugin behavior.
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import telnyxPlugin from "./index.js";
import { applyTelnyxConfig } from "./onboard.js";

const TEST_VALUE = "resolved-marker";

describe("Telnyx provider registration", () => {
  it("registers authenticated live and network-free static catalogs", async () => {
    const provider = await registerSingleProviderPlugin(telnyxPlugin);
    const choice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "telnyx-api-key",
    });
    const catalog = await runSingleProviderCatalog(provider, {
      resolveProviderApiKey: () => ({ apiKey: TEST_VALUE }),
      resolveProviderAuth: () => ({
        apiKey: TEST_VALUE,
        discoveryApiKey: undefined,
        mode: "api_key",
        source: "env",
      }),
    });

    expect(provider).toMatchObject({
      id: "telnyx",
      label: "Telnyx",
      docsPath: "/providers/telnyx",
      envVars: ["TELNYX_API_KEY"],
      resolveDynamicModel: expect.any(Function),
    });
    expect(choice?.provider.id).toBe("telnyx");
    expect(choice?.method.id).toBe("api-key");
    expect(resolveAgentModelPrimaryValue(applyTelnyxConfig({}).agents?.defaults?.model)).toBe(
      "telnyx/moonshotai/Kimi-K2.6",
    );
    expect(catalog).toMatchObject({
      apiKey: TEST_VALUE,
      baseUrl: "https://api.telnyx.com/v2/ai/openai",
      api: "openai-completions",
    });
    expect(catalog.models).toHaveLength(9);
    expect(provider.staticCatalog).toBeDefined();
    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "moonshotai/Kimi-K2.6",
      } as never)?.dropReasoningFromHistory,
    ).not.toBe(true);
  });
});
