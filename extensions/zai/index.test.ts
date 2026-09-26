import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

function createGlm47Template(): Model<"openai-completions"> {
  return {
    id: "glm-4.7",
    name: "GLM-4.7",
    provider: "zai",
    api: "openai-completions",
    baseUrl: "https://api.z.ai/api/paas/v4",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
    contextWindow: 204800,
    maxTokens: 131072,
  };
}

function expectFields(
  model: Record<string, unknown> | undefined,
  fields: Record<string, unknown>,
): void {
  if (!model) {
    throw new Error("Expected provider result");
  }
  for (const [key, value] of Object.entries(fields)) {
    expect(model[key]).toEqual(value);
  }
}

async function captureStreamPayload(
  params: Pick<ProviderWrapStreamFnContext, "extraParams" | "thinkingLevel"> & {
    modelId?: string;
  } = {},
) {
  const provider = await registerSingleProviderPlugin(plugin);
  const modelId = params.modelId ?? "glm-5.1";
  const payload: Record<string, unknown> = {};
  const streamFn: StreamFn = (model, _context, options) => {
    options?.onPayload?.(payload, model);
    return {} as ReturnType<StreamFn>;
  };
  const wrapped = provider.wrapStreamFn?.({
    provider: "zai",
    modelId,
    extraParams: {},
    ...params,
    streamFn,
  });
  if (!wrapped) {
    throw new Error("Expected Z.AI stream wrapper");
  }
  void wrapped({ ...createGlm47Template(), id: modelId }, { messages: [] }, {});
  return payload;
}

describe("zai provider plugin", () => {
  it("preserves all regional auth choices and the exact manifest-owned static catalog", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.aliases).toEqual(["z-ai", "z.ai"]);
    expect(provider.envVars).toEqual(["ZAI_API_KEY", "Z_AI_API_KEY"]);
    expect(provider.auth.map((method) => method.id)).toEqual([
      "api-key",
      "coding-global",
      "coding-cn",
      "global",
      "cn",
    ]);
    expect(await provider.staticCatalog?.run({} as never)).toEqual({
      provider: buildManifestModelProviderConfig({
        providerId: "zai",
        catalog: manifest.modelCatalog.providers.zai,
      }),
    });
  });

  it("owns replay policy for OpenAI-compatible Z.ai transports", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expectFields(
      provider.buildReplayPolicy?.({
        provider: "zai",
        modelApi: "openai-completions",
        modelId: "glm-5.1",
      } as never) as Record<string, unknown> | undefined,
      {
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
        applyAssistantFirstOrderingFix: true,
        validateGeminiTurns: true,
        validateAnthropicTurns: true,
      },
    );

    expectFields(
      provider.buildReplayPolicy?.({
        provider: "zai",
        modelApi: "openai-responses",
        modelId: "glm-5.1",
      } as never) as Record<string, unknown> | undefined,
      {
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
        applyAssistantFirstOrderingFix: false,
        validateGeminiTurns: false,
        validateAnthropicTurns: false,
      },
    );
  });

  it("resolves persisted GLM-5 metadata through selected provider endpoints", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const template = createGlm47Template();
    const global = "https://api.z.ai/api/paas/v4";
    const coding = "https://api.z.ai/api/coding/paas/v4";
    const billedCost = { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 };
    const turboCost = { input: 1.2, output: 4, cacheRead: 0.24, cacheWrite: 0 };
    const cases = [
      [
        "glm-5.3",
        coding,
        ["text"],
        1_048_576,
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ],
      [
        "glm-5.3-flash",
        "https://open.bigmodel.cn/api/coding/paas/v4",
        ["text", "image"],
        1_048_576,
        { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
      ],
      ["glm-5.2", "https://proxy.example.test/zai", ["text"], 1_000_000, billedCost],
      ["glm-5.1", global, ["text"], 200_000, billedCost],
      ["glm-5v-turbo", global, ["text", "image"], 200_000, turboCost],
      ["glm-5-turbo", global, ["text"], 200_000, turboCost],
    ] as const;

    for (const [modelId, baseUrl, input, contextWindow, cost] of cases) {
      const resolved = provider.resolveDynamicModel?.({
        provider: "zai",
        modelId,
        modelRegistry: {
          find: (_provider: string, id: string) => (id === "glm-4.7" ? template : null),
        },
        providerConfig: { baseUrl },
      } as never) as Record<string, unknown> | undefined;
      expectFields(resolved, {
        provider: "zai",
        api: "openai-completions",
        id: modelId,
        baseUrl,
        input,
        reasoning: true,
        contextWindow,
        maxTokens: 131_072,
        cost,
      });
    }
  });

  it("returns an already-registered GLM-5 variant as-is", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const registered = {
      ...createGlm47Template(),
      id: "glm-5-turbo",
      name: "GLM-5-Turbo",
      reasoning: false,
      input: ["text"],
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 123456,
      maxTokens: 54321,
    };
    const template = createGlm47Template();

    expect(
      provider.resolveDynamicModel?.({
        provider: "zai",
        modelId: "glm-5-turbo",
        modelRegistry: {
          find: (_provider: string, modelId: string) =>
            modelId === "glm-5-turbo" ? registered : modelId === "glm-4.7" ? template : null,
        },
      } as never),
    ).toEqual(registered);
  });

  it("falls back to manifest baseUrl when both providerConfig and template model are unavailable", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const resolved = provider.resolveDynamicModel?.({
      provider: "zai",
      modelId: "glm-5.3",
      modelRegistry: {
        find: () => null,
      },
    } as never) as Record<string, unknown> | undefined;
    expectFields(resolved, {
      id: "glm-5.3",
      provider: "zai",
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: true,
      input: ["text"],
    });
  });

  it("still synthesizes unknown GLM-5 variants from the GLM-4.7 template", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const template = createGlm47Template();

    const resolved = provider.resolveDynamicModel?.({
      provider: "zai",
      modelId: "glm-5.4-preview",
      modelRegistry: {
        find: (_provider: string, modelId: string) => (modelId === "glm-4.7" ? template : null),
      },
    } as never) as Record<string, unknown> | undefined;
    expectFields(resolved, {
      id: "glm-5.4-preview",
      provider: "zai",
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: true,
      input: ["text"],
    });
  });

  it("wires tool-stream defaults through the shared stream family hook", async () => {
    expect((await captureStreamPayload()).tool_stream).toBe(true);
    expect(await captureStreamPayload({ extraParams: { tool_stream: false } })).not.toHaveProperty(
      "tool_stream",
    );
  });

  it("exposes GLM-5.3 thinking levels while keeping older GLM models binary", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "zai",
        modelId: "glm-5.3",
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [
        { id: "low", label: "low" },
        { id: "high", label: "high" },
        { id: "max", label: "max" },
      ],
      defaultLevel: "max",
    });

    expect(
      provider.resolveThinkingProfile?.({
        provider: "zai",
        modelId: "glm-5.1",
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
      defaultLevel: "off",
    });
  });

  it("maps thinking off to Z.AI thinking disabled", async () => {
    const payload = await captureStreamPayload({ thinkingLevel: "off" });
    expect(payload.tool_stream).toBe(true);
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("keeps minimal thinking enabled for binary GLM models", async () => {
    expect(await captureStreamPayload({ thinkingLevel: "minimal" })).not.toHaveProperty("thinking");
  });

  it("maps GLM-5.3 thinking levels to Z.AI reasoning effort", async () => {
    for (const [modelId, thinkingLevel, expectedEffort] of [
      ["glm-5.3", "off", "low"],
      ["glm-5.3", "low", "low"],
      ["glm-5.3", "high", "high"],
      ["glm-5.3", "max", "max"],
      ["glm-5.3-flash", "off", "low"],
      ["glm-5.3-flash", "low", "low"],
      ["glm-5.3-flash", "high", "high"],
      ["glm-5.3-flash", "max", "max"],
    ] as const) {
      const payload = await captureStreamPayload({ modelId, thinkingLevel });
      expect(payload.reasoning_effort).toBe(expectedEffort);
      expect(payload).not.toHaveProperty("thinking");
      expect(payload.tool_stream).toBe(true);
    }
  });

  it("enables Z.AI preserved thinking only when requested", async () => {
    const withoutPreserve = await captureStreamPayload({ thinkingLevel: "low" });
    expect(withoutPreserve.tool_stream).toBe(true);
    expect(withoutPreserve).not.toHaveProperty("thinking");
    const withPreserve = await captureStreamPayload({
      extraParams: { preserveThinking: true },
      thinkingLevel: "low",
    });
    expect(withPreserve.tool_stream).toBe(true);
    expect(withPreserve.thinking).toEqual({ type: "enabled", clear_thinking: false });
  });

  it("preserves replayed reasoning_content for Z.AI preserved thinking", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const model = {
      ...createGlm47Template(),
      id: "glm-5.1",
      name: "GLM 5.1",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 131_072,
    } as Model<"openai-completions">;
    const context = {
      messages: [
        { role: "user", content: "hi", timestamp: 1 },
        {
          role: "assistant",
          api: "openai-completions",
          provider: "zai",
          model: "glm-5.1",
          content: [
            {
              type: "thinking",
              thinking: "prior reasoning",
              thinkingSignature: "reasoning_content",
            },
            { type: "text", text: "visible reply" },
          ],
          usage: createZeroUsageFixture(),
          stopReason: "stop",
          timestamp: 2,
        },
        { role: "user", content: "continue", timestamp: 3 },
      ],
    } as Context;
    const baseStreamFn: StreamFn = (streamModel, streamContext, options) => {
      const payload = buildOpenAICompletionsParams(streamModel as never, streamContext, {
        reasoning: "high",
      } as never);
      options?.onPayload?.(payload as never, streamModel as never);
      capturedPayload = payload;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = provider.wrapStreamFn?.({
      provider: "zai",
      modelId: "glm-5.1",
      extraParams: { preserve_thinking: true },
      thinkingLevel: "low",
      streamFn: baseStreamFn,
    } as never);

    void wrapped?.(model, context, {});

    expect(capturedPayload?.thinking).toEqual({ type: "enabled", clear_thinking: false });
    const assistantMessage = (capturedPayload!.messages as Array<Record<string, unknown>>)[1];
    expect(assistantMessage?.role).toBe("assistant");
    expect(assistantMessage?.content).toBe("visible reply");
    expect(assistantMessage?.reasoning_content).toBe("prior reasoning");
  });

  it("defaults tool_stream extra params but preserves explicit values", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.prepareExtraParams?.({
        provider: "zai",
        modelId: "glm-4.7",
        extraParams: { endpoint: "global" },
      } as never),
    ).toEqual({
      endpoint: "global",
      tool_stream: true,
    });

    const explicit = { endpoint: "global", tool_stream: false };
    expect(
      provider.prepareExtraParams?.({
        provider: "zai",
        modelId: "glm-4.7",
        extraParams: explicit,
      } as never),
    ).toBe(explicit);
  });

  it("uses deprecated pi agent auth.json for usage auth when modern sources are empty", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-zai-legacy-auth-"));
    try {
      const authDir = path.join(home, ".pi", "agent");
      await fs.mkdir(authDir, { recursive: true });
      await fs.writeFile(
        path.join(authDir, "auth.json"),
        `${JSON.stringify({ "z-ai": { access: "legacy-zai-token" } }, null, 2)}\n`,
        "utf-8",
      );
      const provider = await registerSingleProviderPlugin(plugin);

      await expect(
        provider.resolveUsageAuth?.({
          env: { HOME: home },
          resolveApiKeyFromConfigAndStore: () => undefined,
        } as never),
      ).resolves.toEqual({ token: "legacy-zai-token" });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
