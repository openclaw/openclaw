// Telnyx tests cover index plugin behavior.
import type { Model } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import telnyxPlugin from "./index.js";
import { applyTelnyxConfig } from "./onboard.js";
import { createTelnyxToolPayloadWrapper } from "./stream.js";

const TEST_VALUE = "resolved-marker";

function telnyxModel(): Model<"openai-completions"> {
  return {
    id: "moonshotai/Kimi-K2.6",
    name: "Kimi K2.6",
    provider: "telnyx",
    api: "openai-completions",
    baseUrl: "https://api.telnyx.com/v2/ai/openai",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 8_192,
  };
}

function capturePatchedPayload(payload: Record<string, unknown>) {
  let captured: Record<string, unknown> | undefined;
  const streamFn: NonNullable<ProviderWrapStreamFnContext["streamFn"]> = (
    model,
    _context,
    options,
  ) => {
    options?.onPayload?.(payload, model);
    captured = payload;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.end());
    return stream;
  };
  const wrapped = createTelnyxToolPayloadWrapper({
    provider: "telnyx",
    modelId: "moonshotai/Kimi-K2.6",
    streamFn,
  } as ProviderWrapStreamFnContext);
  if (!wrapped) {
    throw new Error("Telnyx payload wrapper missing");
  }
  void wrapped(telnyxModel(), { messages: [] }, {});
  return captured;
}

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
      "telnyx/moonshotai/Kimi-K3",
    );
    expect(catalog).toMatchObject({
      apiKey: TEST_VALUE,
      baseUrl: "https://api.telnyx.com/v2/ai/openai",
      api: "openai-completions",
    });
    expect(catalog.models).toHaveLength(14);
    expect(provider.staticCatalog).toBeDefined();
    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "moonshotai/Kimi-K2.6",
      } as never)?.dropReasoningFromHistory,
    ).not.toBe(true);
  });
  it("drops token caps only when function tools are present", () => {
    // Telnyx error 10015 rejects max_tokens combined with function tools.
    expect(
      capturePatchedPayload({
        max_tokens: 1024,
        tools: [{ type: "function", function: { name: "probe" } }],
      }),
    ).toEqual({ tools: [{ type: "function", function: { name: "probe" } }] });
    expect(capturePatchedPayload({ max_completion_tokens: 1024, tools: [] })).toEqual({
      max_completion_tokens: 1024,
      tools: [],
    });
    expect(capturePatchedPayload({ max_tokens: 1024 })).toEqual({ max_tokens: 1024 });
  });
});
