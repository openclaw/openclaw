import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import { makeTextToolResult } from "../test-support/message-fixtures.test-support.js";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import xiaomiPlugin from "./index.js";

type OpenAICompletionsModel = Model<"openai-completions">;

const readTool = {
  name: "read",
  description: "Read data",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
};

const registerXiaomiPlugin = () =>
  registerProviderPlugin({
    plugin: xiaomiPlugin,
    id: "xiaomi",
    name: "Xiaomi Provider",
  });

async function getXiaomiProvider(id = "xiaomi") {
  const { providers } = await registerXiaomiPlugin();
  return requireRegisteredProvider(providers, id);
}

function mimoReasoningModel(
  id: "mimo-v2.5" | "mimo-v2.5-pro",
  provider: "xiaomi" | "xiaomi-token-plan" = "xiaomi",
): OpenAICompletionsModel {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://api.xiaomimimo.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 32_000,
  } as OpenAICompletionsModel;
}

function readToolReplayContext(provider = "xiaomi", reasoning = true): Context {
  const assistantMessage = makeAgentAssistantMessage({
    api: "openai-completions",
    provider,
    model: provider === "openai" ? "gpt-5.5" : "mimo-v2.5-pro",
    content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
    stopReason: "toolUse",
    timestamp: 2,
  });
  if (reasoning) {
    assistantMessage.content.unshift({
      type: "thinking",
      thinking: "call reasoning",
      thinkingSignature: "reasoning_content",
    });
  }
  return {
    messages: [assistantMessage, makeTextToolResult("call_1", "read", "ok", false, 3)],
    tools: [readTool],
  } as Context;
}

it("builds the static Xiaomi model catalog with reasoning flags", async () => {
  const provider = await getXiaomiProvider();
  const catalogProvider = await runSingleProviderCatalog({ catalog: provider.staticCatalog });

  expect(catalogProvider).toMatchObject({
    api: "openai-completions",
    baseUrl: "https://api.xiaomimimo.com/v1",
  });

  expect(catalogProvider.models?.find((model) => model.id === "mimo-v2.6-flash")).toMatchObject({
    input: ["text", "image"],
    reasoning: true,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  });
});

it("exposes Token Plan catalog rows only after a provider config selects a region", async () => {
  const response = Response.json({
    data: [{ id: "mimo-v2.6-flash" }],
  });
  const release = vi.fn(async () => undefined);
  const guardedFetch = vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockResolvedValue({
    response,
    finalUrl: "https://token-plan-cn.xiaomimimo.com/v1/models",
    release,
  });

  try {
    const provider = await getXiaomiProvider("xiaomi-token-plan");
    const runCatalog = (baseUrl?: string) =>
      provider.catalog?.run({
        config: baseUrl ? { models: { providers: { "xiaomi-token-plan": { baseUrl } } } } : {},
        env: {},
        resolveProviderApiKey: () => ({ apiKey: "tp-test" }),
      } as never);
    expect(await runCatalog()).toBeNull();
    expect(guardedFetch).not.toHaveBeenCalled();
    const configured = await runCatalog("https://token-plan-cn.xiaomimimo.com/v1");
    if (!configured || !("provider" in configured)) {
      throw new Error("expected configured Xiaomi Token Plan catalog");
    }
    expect(configured.provider).toMatchObject({
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      api: "openai-completions",
    });
    expect(configured.provider.models).toMatchObject([
      {
        id: "mimo-v2.6-flash",
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
    const request = guardedFetch.mock.calls[0]?.[0];
    expect(request?.url).toBe("https://token-plan-cn.xiaomimimo.com/v1/models");
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer tp-test");
    expect(response.bodyUsed).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  } finally {
    guardedFetch.mockRestore();
  }
});

it.each`
  choice                     | option                     | key          | error
  ${"xiaomi-api-key"}        | ${"xiaomiApiKey"}          | ${"tp-test"} | ${"This looks like a Xiaomi MiMo Token Plan key (tp-...). Re-run onboarding with one of: --auth-choice xiaomi-token-plan-cn, --auth-choice xiaomi-token-plan-sgp, or --auth-choice xiaomi-token-plan-ams."}
  ${"xiaomi-token-plan-ams"} | ${"xiaomiTokenPlanApiKey"} | ${"sk-test"} | ${"This looks like a Xiaomi MiMo pay-as-you-go key (sk-...). Re-run onboarding with --auth-choice xiaomi-api-key or pass --xiaomi-api-key."}
  ${"xiaomi-api-key"}        | ${"xiaomiApiKey"}          | ${"bad-key"} | ${'Xiaomi MiMo pay-as-you-go keys must start with "sk-". The entered key does not match the expected format.'}
  ${"xiaomi-token-plan-sgp"} | ${"xiaomiTokenPlanApiKey"} | ${"bad-key"} | ${'Xiaomi MiMo Token Plan keys must start with "tp-". The entered key does not match the expected format.'}
`("rejects keys for $choice ($option, $key)", async ({ choice, option, key, error }) => {
  const { providers } = await registerXiaomiPlugin();
  const resolved = resolveProviderPluginChoice({ providers, choice });
  const run = expectDefined(resolved?.method.runNonInteractive, "Xiaomi non-interactive auth");
  await expect(
    run({
      authChoice: choice,
      config: {},
      baseConfig: {},
      opts: { [option]: key },
      runtime: {} as never,
      resolveApiKey: async () => ({ key, source: "flag" }),
      toApiKeyCredential: vi.fn(),
    } as never),
  ).rejects.toThrow(error);
});

it("marks resolved MiMo models for empty array items omission", async () => {
  const provider = await getXiaomiProvider();
  const model = mimoReasoningModel("mimo-v2.5");

  expect(
    provider.normalizeResolvedModel?.({
      provider: "xiaomi",
      modelId: model.id,
      modelApi: model.api,
      model,
    } as never),
  ).toMatchObject({ compat: { omitEmptyArrayItems: true } });
});

it("advertises thinking profiles for MiMo reasoning models only", async () => {
  const provider = await getXiaomiProvider();
  const resolveProfile = (modelId: string) =>
    provider.resolveThinkingProfile?.({ provider: "xiaomi", modelId } as never);
  expect(resolveProfile("mimo-v2.6-flash")).toMatchObject({
    levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((id) => ({ id })),
    defaultLevel: "high",
  });
  expect(resolveProfile("custom-model")).toBeUndefined();
});

it.each(["foreign", "enabled", "disabled"] as const)(
  "handles %s reasoning replay",
  async (mode) => {
    const provider = mode === "enabled" ? "xiaomi-token-plan" : "xiaomi";
    const model = mimoReasoningModel(mode === "disabled" ? "mimo-v2.5" : "mimo-v2.5-pro", provider);
    const capture: { payload?: Record<string, unknown> } = {};
    const streamFn: StreamFn = (_model, context, options) => {
      capture.payload = buildOpenAICompletionsParams(model, context, { reasoning: "high" });
      options?.onPayload?.(capture.payload, model);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end());
      return stream;
    };
    const plugin = await getXiaomiProvider(provider);
    const stream = expectDefined(
      plugin.wrapStreamFn?.({
        provider,
        modelId: model.id,
        model,
        streamFn,
        thinkingLevel: mode === "disabled" ? "off" : "high",
      }),
      "Registered MiMo thinking stream",
    );
    await stream(
      model,
      readToolReplayContext(mode === "foreign" ? "openai" : provider, mode !== "foreign"),
      {},
    );
    const payload = capture.payload;
    const assistantMessage = (payload?.messages as Array<Record<string, unknown>> | undefined)?.[0];
    if (mode === "disabled") {
      expect(payload).toHaveProperty("thinking.type", "disabled");
      expect(assistantMessage).not.toHaveProperty("reasoning_content");
      return;
    }
    if (mode === "enabled") {
      expect(payload).toHaveProperty("thinking.type", "enabled");
    }
    expect(assistantMessage).toMatchObject({
      role: "assistant",
      reasoning_content: mode === "foreign" ? "" : "call reasoning",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
    });
  },
);
