// Telnyx tests cover index plugin behavior.
import type { AssistantMessageEvent, Model } from "openclaw/plugin-sdk/llm";
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
import { createTelnyxToolPayloadWrapper, resetTelnyxCapRejectionCacheForTest } from "./stream.js";

const TEST_VALUE = "resolved-marker";

function telnyxModel(id = "moonshotai/Kimi-K2.6"): Model<"openai-completions"> {
  return {
    id,
    name: id,
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

const PROBE_TOOL = {
  name: "live_probe",
  description: "probe",
  parameters: { type: "object" as const, properties: {} },
};

type StreamAttempt = { payload: Record<string, unknown>; failWith?: string };

/** Runs the wrapper against scripted attempts; returns the payload each attempt sent. */
async function runWrappedToolRequest(params: {
  modelId: string;
  attempts: Array<{ failWith?: string }>;
  withTools?: boolean;
}) {
  const sent: StreamAttempt[] = [];
  let attempt = 0;
  const streamFn: NonNullable<ProviderWrapStreamFnContext["streamFn"]> = (
    model,
    _context,
    options,
  ) => {
    const script = params.attempts[attempt] ?? {};
    attempt += 1;
    const payload: Record<string, unknown> = {
      max_tokens: 1024,
      ...(params.withTools === false ? {} : { tools: [{ type: "function" }] }),
    };
    void options?.onPayload?.(payload, model);
    sent.push({ payload, failWith: script.failWith });
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      if (script.failWith) {
        (stream as unknown as { push(event: unknown): void }).push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage: script.failWith,
            timestamp: Date.now(),
          },
        });
      }
      stream.end();
    });
    return stream;
  };
  const wrapped = createTelnyxToolPayloadWrapper({
    provider: "telnyx",
    modelId: params.modelId,
    streamFn,
  } as ProviderWrapStreamFnContext);
  if (!wrapped) {
    throw new Error("Telnyx payload wrapper missing");
  }
  const stream = wrapped(
    telnyxModel(params.modelId),
    {
      messages: [],
      ...(params.withTools === false ? {} : { tools: [PROBE_TOOL] }),
    } as never,
    {},
  );
  const events: AssistantMessageEvent[] = [];
  for await (const event of await Promise.resolve(stream)) {
    events.push(event);
  }
  return { sent, events };
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
  it("pre-strips token caps for known cap-rejecting models with tools", async () => {
    resetTelnyxCapRejectionCacheForTest();
    // Telnyx error 10015: hosted models reject max_tokens combined with tools.
    const { sent } = await runWrappedToolRequest({
      modelId: "moonshotai/Kimi-K3",
      attempts: [{}],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.max_tokens).toBeUndefined();
    expect(sent[0]?.payload.tools).toBeDefined();
  });

  it("preserves the caller token cap for models that accept cap+tools", async () => {
    resetTelnyxCapRejectionCacheForTest();
    const { sent } = await runWrappedToolRequest({
      modelId: "openai/gpt-5.4",
      attempts: [{}],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.max_tokens).toBe(1024);
  });

  it("keeps caps on requests without tools even for rejecting models", async () => {
    resetTelnyxCapRejectionCacheForTest();
    const { sent } = await runWrappedToolRequest({
      modelId: "moonshotai/Kimi-K3",
      attempts: [{}],
      withTools: false,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.max_tokens).toBe(1024);
  });

  it("retries an unknown model without caps after a 400 and remembers it", async () => {
    resetTelnyxCapRejectionCacheForTest();
    // First request: cap attempt 400s, retry without cap succeeds.
    const first = await runWrappedToolRequest({
      modelId: "google/gemini-2.5-flash",
      attempts: [{ failWith: "400 status code (no body)" }, {}],
    });
    expect(first.sent).toHaveLength(2);
    expect(first.sent[0]?.payload.max_tokens).toBe(1024);
    expect(first.sent[1]?.payload.max_tokens).toBeUndefined();
    expect(first.events.some((event) => event.type === "error")).toBe(false);

    // Second request: rejection is remembered, no failing first attempt.
    const second = await runWrappedToolRequest({
      modelId: "google/gemini-2.5-flash",
      attempts: [{}],
    });
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]?.payload.max_tokens).toBeUndefined();
  });

  it("forwards the retry error without caching when dropping the cap does not help", async () => {
    resetTelnyxCapRejectionCacheForTest();
    const { sent, events } = await runWrappedToolRequest({
      modelId: "openai/gpt-9-future",
      attempts: [
        { failWith: "400 status code (no body)" },
        { failWith: "400 status code (no body)" },
      ],
    });
    expect(sent).toHaveLength(2);
    expect(events.some((event) => event.type === "error")).toBe(true);

    // Not cached: the next request attempts with the cap again.
    const next = await runWrappedToolRequest({
      modelId: "openai/gpt-9-future",
      attempts: [{}],
    });
    expect(next.sent[0]?.payload.max_tokens).toBe(1024);
  });
});
