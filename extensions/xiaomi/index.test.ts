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
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import xiaomiPlugin from "./index.js";

type OpenAICompletionsModel = Model<"openai-completions">;

type PayloadCapture = {
  payload?: Record<string, unknown>;
};

const emptyUsage = createZeroUsageFixture();
const modelIds = [
  "mimo-v2.6-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro-ultraspeed",
  "mimo-v2.5",
  "mimo-v2.5-pro",
] as const;

const readToolCall = { type: "toolCall", id: "call_1", name: "read", arguments: {} };
const readToolResult = {
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "read",
  content: [{ type: "text", text: "ok" }],
  isError: false,
  timestamp: 3,
};
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
  id: (typeof modelIds)[number],
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
    compat: {},
  } as OpenAICompletionsModel;
}

function readToolReplayContext(provider = "xiaomi", reasoning = true): Context {
  const assistantMessage = {
    role: "assistant",
    api: "openai-completions",
    provider,
    model: provider === "openai" ? "gpt-5.5" : "mimo-v2.5-pro",
    content: [
      ...(reasoning
        ? [{ type: "thinking", thinking: "call reasoning", thinkingSignature: "reasoning_content" }]
        : []),
      readToolCall,
    ],
    usage: emptyUsage,
    stopReason: "toolUse",
    timestamp: 2,
  };
  return {
    messages: [{ role: "user", content: "hi", timestamp: 1 }, assistantMessage, readToolResult],
    tools: [readTool],
  } as Context;
}

async function captureThinkingPayload(
  model: OpenAICompletionsModel,
  thinkingLevel: "off" | "high",
  context = readToolReplayContext(model.provider),
) {
  const capture: PayloadCapture = {};
  const provider = await getXiaomiProvider(model.provider);
  const streamFn: StreamFn = (_streamModel, streamContext, options) => {
    capture.payload = buildOpenAICompletionsParams(model, streamContext, { reasoning: "high" });
    options?.onPayload?.(capture.payload, model);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.end());
    return stream;
  };
  const stream = expectDefined(
    provider.wrapStreamFn?.({
      provider: model.provider,
      modelId: model.id,
      model,
      streamFn,
      thinkingLevel,
    }),
    "Registered MiMo thinking stream",
  );
  await stream(model, context, {});
  return capture;
}

function readPayloadMessage(
  capture: PayloadCapture,
  index: number,
): Record<string, unknown> | undefined {
  return (capture.payload?.messages as Array<Record<string, unknown>> | undefined)?.[index];
}

describe("xiaomi provider plugin", () => {
  it("builds the static Xiaomi model catalog with reasoning flags", async () => {
    const provider = await getXiaomiProvider();
    const catalogProvider = await runSingleProviderCatalog({ catalog: provider.staticCatalog });

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://api.xiaomimimo.com/v1");

    expect(catalogProvider.models?.map((model) => model.id)).toEqual(modelIds);
    expect(catalogProvider.models?.find((m) => m.id === "mimo-v2.6-flash")?.input).toEqual([
      "text",
      "image",
    ]);
    for (const [id, input, output, cacheRead] of [
      ["mimo-v2.6-flash", 0.14, 0.28, 0.0028],
      ["mimo-v2.6-pro", 0.435, 0.87, 0.0036],
      ["mimo-v2.6-pro-ultraspeed", 4.35, 8.7, 0.036],
    ] as const) {
      expect(catalogProvider.models?.find((m) => m.id === id)?.cost).toEqual({
        input,
        output,
        cacheRead,
        cacheWrite: 0,
      });
    }
    expect(catalogProvider.models?.every((model) => model.reasoning)).toBe(true);
  });

  it("exposes Token Plan catalog rows only after a provider config selects a region", async () => {
    const response = Response.json({
      data: [
        { id: "mimo-v2.6-pro" },
        { id: "mimo-v2.6-flash" },
        { id: "mimo-v2.5" },
        { id: "mimo-v2.5-pro" },
      ],
    });
    const release = vi.fn(async () => undefined);
    const guardedFetch = vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockResolvedValue({
      response,
      finalUrl: "https://token-plan-cn.xiaomimimo.com/v1/models",
      release,
    });

    try {
      const provider = await getXiaomiProvider("xiaomi-token-plan");
      const runCatalog = (config: Record<string, unknown>, source: "env" | "profile") =>
        provider.catalog?.run({
          config,
          env: {},
          resolveProviderApiKey: () => ({ apiKey: "tp-test" }),
          resolveProviderAuth: () => ({
            apiKey: "tp-test",
            mode: "api_key",
            source,
            ...(source === "profile" ? { profileId: "xiaomi-token-plan:default" } : {}),
          }),
        } as never);
      expect(await runCatalog({}, "env")).toBeNull();
      expect(guardedFetch).not.toHaveBeenCalled();
      const configured = await runCatalog(
        {
          models: {
            providers: {
              "xiaomi-token-plan": {
                baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
              },
            },
          },
        },
        "profile",
      );
      if (!configured || !("provider" in configured)) {
        throw new Error("expected configured Xiaomi Token Plan catalog");
      }
      expect(configured.provider.baseUrl).toBe("https://token-plan-cn.xiaomimimo.com/v1");
      expect(configured.provider.api).toBe("openai-completions");
      expect(configured.provider.models?.map((model) => model.id)).toEqual([
        "mimo-v2.5",
        "mimo-v2.5-pro",
        "mimo-v2.6-flash",
        "mimo-v2.6-pro",
      ]);
      expect(
        configured.provider.models?.find((model) => model.id === "mimo-v2.6-flash")?.input,
      ).toEqual(["text", "image"]);
      for (const model of configured.provider.models ?? []) {
        expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      }
      expect(guardedFetch).toHaveBeenCalledOnce();
      const request = guardedFetch.mock.calls[0]?.[0];
      expect(request?.url).toBe("https://token-plan-cn.xiaomimimo.com/v1/models");
      expect(request?.init?.method ?? "GET").toBe("GET");
      expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer tp-test");
      expect(response.bodyUsed).toBe(true);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      guardedFetch.mockRestore();
    }
  });

  it.each([
    [
      "xiaomi-api-key",
      "xiaomiApiKey",
      "tp-test",
      "This looks like a Xiaomi MiMo Token Plan key (tp-...). " +
        "Re-run onboarding with one of: --auth-choice xiaomi-token-plan-cn, " +
        "--auth-choice xiaomi-token-plan-sgp, or --auth-choice xiaomi-token-plan-ams.",
    ],
    [
      "xiaomi-token-plan-ams",
      "xiaomiTokenPlanApiKey",
      "sk-test",
      "This looks like a Xiaomi MiMo pay-as-you-go key (sk-...). " +
        "Re-run onboarding with --auth-choice xiaomi-api-key or pass --xiaomi-api-key.",
    ],
    [
      "xiaomi-api-key",
      "xiaomiApiKey",
      "bad-key",
      'Xiaomi MiMo pay-as-you-go keys must start with "sk-". The entered key does not match the expected format.',
    ],
    [
      "xiaomi-token-plan-sgp",
      "xiaomiTokenPlanApiKey",
      "bad-key",
      'Xiaomi MiMo Token Plan keys must start with "tp-". The entered key does not match the expected format.',
    ],
  ])("rejects keys for %s (%s, %s)", async (choice, option, key, error) => {
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

    const normalized = provider.normalizeResolvedModel?.({
      provider: "xiaomi",
      modelId: model.id,
      modelApi: model.api,
      model,
    } as never);

    expect(
      (normalized?.compat as { omitEmptyArrayItems?: unknown } | undefined)?.omitEmptyArrayItems,
    ).toBe(true);
  });

  it("advertises thinking profiles for MiMo reasoning models only", async () => {
    const provider = await getXiaomiProvider();
    const resolveThinkingProfile = expectDefined(
      provider.resolveThinkingProfile,
      "Xiaomi thinking profile resolver",
    );
    const expectedLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

    for (const modelId of modelIds) {
      const profile = resolveThinkingProfile({ provider: "xiaomi", modelId } as never);
      expect(profile?.levels.map((l) => l.id)).toEqual(expectedLevels);
      expect(profile?.defaultLevel).toBe("high");
    }

    expect(resolveThinkingProfile({ provider: "xiaomi", modelId: "custom-model" } as never)).toBe(
      undefined,
    );
  });

  it("adds blank reasoning_content for replayed tool calls from non-xiaomi turns", async () => {
    const capture = await captureThinkingPayload(
      mimoReasoningModel("mimo-v2.5-pro"),
      "high",
      readToolReplayContext("openai", false),
    );

    const assistantMessage = readPayloadMessage(capture, 1);
    expect(assistantMessage).toMatchObject({
      role: "assistant",
      reasoning_content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
    });
  });

  it("preserves replayed reasoning_content when MiMo thinking is enabled", async () => {
    const capture = await captureThinkingPayload(
      mimoReasoningModel("mimo-v2.5-pro", "xiaomi-token-plan"),
      "high",
    );

    expect(capture.payload).toHaveProperty("thinking.type", "enabled");
    const assistantMessage = readPayloadMessage(capture, 1);
    expect(assistantMessage).toMatchObject({
      role: "assistant",
      reasoning_content: "call reasoning",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read" } }],
    });
  });

  it("strips reasoning_content when MiMo thinking is disabled", async () => {
    const capture = await captureThinkingPayload(mimoReasoningModel("mimo-v2.5"), "off");

    expect(capture.payload).toHaveProperty("thinking.type", "disabled");
    expect(readPayloadMessage(capture, 1)).not.toHaveProperty("reasoning_content");
  });
});
