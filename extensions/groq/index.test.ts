import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  streamSimple,
  resolveOpenAIRequestReasoning,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-model-metadata";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("groq provider compat", () => {
  it("requests parsed reasoning only for enabled Groq Qwen reasoning models", async () => {
    const [provider] = capturePluginRegistration(plugin).providers;
    for (const [id, reasoning, effort, parsed] of [
      ["qwen/qwen3.6-27b", true, "default", true],
      ["qwen/future-reasoner", true, "default", true],
      ["qwen/qwen3.6-27b", true, "none", false],
      ["qwen/future-text-model", false, "default", false],
      ["openai/gpt-oss-120b", true, "high", false],
      ["openai/gpt-oss-20b", true, "medium", false],
    ] as const) {
      const model: Model<"openai-completions"> = {
        provider: "groq",
        api: "openai-completions",
        id,
        name: id,
        reasoning,
        baseUrl: "https://api.groq.com/openai/v1",
        input: ["text"],
        contextWindow: 131_072,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      for (const wrap of [provider?.wrapStreamFn, provider?.wrapSimpleCompletionStreamFn]) {
        if (!wrap) {
          throw new Error("Expected Groq completion wrapper");
        }
        const payload = { reasoning_effort: effort };
        const streamFn: StreamFn = async (streamModel, _context, options) => {
          await options?.onPayload?.(payload, streamModel);
          const stream = createAssistantMessageEventStream();
          stream.end();
          return stream;
        };
        const wrapped = wrap({ provider: "groq", modelId: id, model, streamFn });
        if (!wrapped) {
          throw new Error("Expected wrapped Groq stream");
        }
        await wrapped(model, { messages: [] });
        expect(payload).toEqual({
          reasoning_effort: effort,
          ...(parsed ? { reasoning_format: "parsed" } : {}),
        });
      }
    }
  });

  it("clamps GPT OSS thinking levels to Groq's low, medium, and high efforts", () => {
    const catalog = buildManifestModelProviderConfig({
      providerId: "groq",
      catalog: manifest.modelCatalog.providers.groq,
    });
    const rows = catalog.models.filter((model) => model.id.includes("gpt-oss"));
    expect(rows.map((row) => row.id)).toEqual([
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "openai/gpt-oss-safeguard-20b",
    ]);
    for (const row of rows) {
      const model: Model<"openai-completions"> = {
        ...row,
        input: ["text"],
        provider: "groq",
        api: "openai-completions",
        baseUrl: catalog.baseUrl,
      };
      // Groq rejects `minimal` for GPT OSS with a 400.
      for (const [reasoning, effort] of [
        ["minimal", "low"],
        ["medium", "medium"],
        ["xhigh", "high"],
      ] as const) {
        expect(buildOpenAICompletionsParams(model, { messages: [] }, { reasoning })).toHaveProperty(
          "reasoning_effort",
          effort,
        );
      }
    }
  });

  it("maps every Qwen thinking level to Groq's binary wire contract on both completion paths", async () => {
    const [provider] = capturePluginRegistration(plugin).providers;
    const catalog = buildManifestModelProviderConfig({
      providerId: "groq",
      catalog: manifest.modelCatalog.providers.groq,
    });
    const row = catalog.models.find((model) => model.id === "qwen/qwen3.6-27b");
    if (!provider || !row) {
      throw new Error("Expected Groq Qwen catalog and provider");
    }
    const input: Model<"openai-completions">["input"] = ["text"];
    expect(row.input).toEqual(input);
    expect(row.compat).toMatchObject({
      supportedReasoningEfforts: ["none", "default"],
      reasoningEffortMap: {
        off: "none",
        none: "none",
        minimal: "default",
        low: "default",
        medium: "default",
        high: "default",
        xhigh: "default",
        adaptive: "default",
        max: "default",
      },
    });
    const model: Model<"openai-completions"> = {
      ...row,
      input,
      provider: "groq",
      api: "openai-completions",
      baseUrl: catalog.baseUrl,
    };
    for (const [level, effort] of [
      ["none", "none"],
      ["adaptive", "default"],
    ] as const) {
      expect(resolveOpenAIRequestReasoning(model, level).effort).toBe(effort);
    }
    expect(
      buildOpenAICompletionsParams(model, { messages: [] }, { reasoningEffort: "none" }),
    ).toHaveProperty("reasoning_effort", "none");
    for (const wrap of [provider.wrapStreamFn, provider.wrapSimpleCompletionStreamFn]) {
      if (!wrap) {
        throw new Error("Expected Groq completion wrapper");
      }
      const streamFn = wrap({ provider: "groq", modelId: model.id, model, streamFn: streamSimple });
      if (!streamFn) {
        throw new Error("Expected wrapped Groq stream");
      }
      for (const reasoning of [
        undefined,
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ] as const) {
        let payload: unknown;
        const stream = await streamFn(
          model,
          { messages: [] },
          {
            apiKey: "synthetic-unused-key",
            reasoning,
            onPayload(value) {
              payload = value;
              throw new Error("captured before request");
            },
          },
        );
        expect((await stream.result()).errorMessage).toBe("captured before request");
        const enabled = reasoning !== undefined && reasoning !== "off";
        expect(payload).toMatchObject({ reasoning_effort: enabled ? "default" : "none" });
        if (enabled) {
          expect(payload).toHaveProperty("reasoning_format", "parsed");
        } else {
          expect(payload).not.toHaveProperty("reasoning_format");
        }
      }
    }
  });

  it("registers Groq model and media providers", () => {
    const captured = capturePluginRegistration(plugin);
    const [provider] = captured.providers;
    if (!provider) {
      throw new Error("Expected Groq provider");
    }
    expect(provider).toMatchObject({
      docsPath: "/providers/groq",
      envVars: ["GROQ_API_KEY"],
      id: "groq",
      label: "Groq",
    });
    expect(provider.auth).toHaveLength(1);
    expect(provider.auth[0]).toMatchObject({
      id: "api-key",
      kind: "api_key",
      label: "Groq API key",
      starterModel: `groq/${manifest.modelCatalog.providers.groq.defaultModel}`,
      wizard: {
        choiceId: "groq-api-key",
        groupId: "groq",
      },
    });
    expect(captured.modelCatalogProviders.map((entry) => entry.kinds)).toEqual([["text"]]);
    expect(captured.mediaUnderstandingProviders).toHaveLength(1);
    const [mediaProvider] = captured.mediaUnderstandingProviders;
    expect(mediaProvider).toEqual({
      autoPriority: { audio: 20 },
      capabilities: ["audio"],
      defaultModels: { audio: "whisper-large-v3-turbo" },
      id: "groq",
      transcribeAudio: expect.any(Function),
    });
  });
});
