import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  streamSimple,
  resolveOpenAIRequestReasoning,
  type Model,
  type SimpleStreamOptions,
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

  it("recovers only matching implicit-budget rejections without changing normal tools", async () => {
    const [provider] = capturePluginRegistration(plugin).providers;

    const capturePayloads = async ({
      extraParams,
      firstError,
      initialMaxTokens = 32_768,
      onPayload,
      streamMaxTokens,
      withTools = true,
      modelParams,
      maxTokensSource = "discovered",
    }: {
      extraParams?: Record<string, unknown>;
      firstError?: string;
      initialMaxTokens?: number;
      onPayload?: SimpleStreamOptions["onPayload"];
      streamMaxTokens?: number;
      withTools?: boolean;
      modelParams?: Record<string, unknown>;
      maxTokensSource?: "configured" | "discovered" | null;
    } = {}) => {
      const model: Model<"openai-completions"> = {
        provider: "groq",
        api: "openai-completions",
        id: "llama-3.3-70b-versatile",
        name: "Llama 3.3 70B Versatile",
        reasoning: false,
        baseUrl: "https://api.groq.com/openai/v1",
        input: ["text"],
        maxTokens: initialMaxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...(modelParams ? { params: modelParams } : {}),
      };
      const payloads: Array<Record<string, unknown>> = [];
      const baseStreamFn: StreamFn = async (streamModel, _context, options) => {
        const payload: Record<string, unknown> = {
          max_completion_tokens: initialMaxTokens,
        };
        if (withTools) {
          payload.tools = [{ type: "function", function: { name: "read" } }];
          payload.tool_choice = "auto";
        }
        const replacement = await options?.onPayload?.(payload, streamModel);
        const finalPayload =
          replacement && typeof replacement === "object"
            ? (replacement as Record<string, unknown>)
            : payload;
        payloads.push(finalPayload);
        const stream = createAssistantMessageEventStream();
        if (payloads.length === 1 && firstError) {
          stream.push({
            type: "error",
            reason: "error",
            error: { stopReason: "error", errorMessage: firstError } as never,
          });
        } else {
          stream.push({
            type: "done",
            reason: "stop",
            message: { stopReason: "stop" } as never,
          });
        }
        stream.end();
        return stream;
      };
      const streamFn = provider?.wrapStreamFn?.({
        provider: "groq",
        modelId: "llama-3.3-70b-versatile",
        extraParams,
        model: {
          ...model,
          ...(maxTokensSource ? { maxTokensSource } : {}),
        },
        streamFn: baseStreamFn,
      });
      const stream = streamFn?.(
        model,
        { messages: [], ...(withTools ? { tools: [{ name: "read" }] } : {}) } as never,
        { onPayload, maxTokens: streamMaxTokens },
      );
      // Drain the wrapper so a matching error can trigger its fallback attempt.
      for await (const event of (await stream) ?? []) {
        void event;
      }
      return payloads;
    };

    const successfulDefault = await capturePayloads();
    expect(successfulDefault).toHaveLength(1);
    expect(successfulDefault[0]).toMatchObject({
      max_completion_tokens: 32_768,
      tools: [{ type: "function", function: { name: "read" } }],
    });

    const matchingError =
      "413 Request too large for model `llama-3.3-70b-versatile` on tokens per minute (TPM): Limit 12000, Requested 30000";
    let payloadHookCalls = 0;
    const recovered = await capturePayloads({
      firstError: matchingError,
      onPayload(payload) {
        const record = payload as Record<string, unknown>;
        payloadHookCalls += 1;
        return payloadHookCalls === 1
          ? payload
          : {
              ...record,
              max_tokens: 65_536,
              max_completion_tokens: 32_768,
              tools: [{ type: "function", function: { name: "restored" } }],
              tool_choice: "required",
              parallel_tool_calls: true,
              parallelToolCalls: false,
            };
      },
    });
    expect(payloadHookCalls).toBe(2);
    expect(recovered).toHaveLength(2);
    expect(recovered[0]).toMatchObject({
      max_completion_tokens: 32_768,
      tools: [{ type: "function", function: { name: "read" } }],
    });
    expect(recovered[1]).toEqual({ max_completion_tokens: 1_024 });

    const noTools = await capturePayloads({ firstError: matchingError, withTools: false });
    expect(noTools).toEqual([{ max_completion_tokens: 32_768 }, { max_completion_tokens: 1_024 }]);

    for (const unrelatedMessage of [
      "413 context length exceeded",
      "429 Rate limit reached on tokens per minute (TPM)",
    ]) {
      const unrelatedError = await capturePayloads({ firstError: unrelatedMessage });
      expect(unrelatedError).toHaveLength(1);
      expect(unrelatedError[0]).toHaveProperty("tools");
    }

    for (const budget of [
      { extraParams: { max_completion_tokens: 4_096 } },
      { modelParams: { maxTokens: 4_096 } },
      { modelParams: { max_completion_tokens: 4_096 } },
      { modelParams: { max_tokens: 4_096 } },
      { modelParams: { extra_body: { max_completion_tokens: 4_096 } } },
      { modelParams: { extra_body: { max_tokens: 4_096 } } },
      { modelParams: { extraBody: { max_completion_tokens: 4_096 } } },
      { modelParams: { extraBody: { max_tokens: 4_096 } } },
      { maxTokensSource: "configured" },
      { maxTokensSource: null },
      { streamMaxTokens: 4_096 },
    ] as const) {
      const payloads = await capturePayloads({
        firstError: matchingError,
        initialMaxTokens: 4_096,
        ...budget,
      });
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({
        max_completion_tokens: 4_096,
        tools: [{ type: "function", function: { name: "read" } }],
        tool_choice: "auto",
      });
    }
  });

  it("preserves synchronous throws and complete asynchronous error metadata", async () => {
    const [provider] = capturePluginRegistration(plugin).providers;
    if (!provider) {
      throw new Error("expected Groq provider registration");
    }
    const model = {
      api: "openai-completions",
      provider: "groq",
      id: "llama-3.3-70b-versatile",
    } as never;
    const context = { messages: [], tools: [{ name: "read" }] } as never;
    const wrap = (streamFn: StreamFn) =>
      provider.wrapStreamFn?.({
        provider: "groq",
        modelId: "llama-3.3-70b-versatile",
        model: { maxTokensSource: "discovered" } as never,
        streamFn,
      } as never);

    const synchronous = wrap(() => {
      throw new Error("synchronous failure");
    });
    expect(() => synchronous?.(model, context, {})).toThrow("synchronous failure");

    const asynchronous = wrap(async () => {
      throw new Error("asynchronous failure");
    });
    const events = [];
    for await (const event of (await asynchronous?.(model, context, {})) ?? []) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        type: "error",
        reason: "error",
        error: expect.objectContaining({
          api: "openai-completions",
          provider: "groq",
          model: "llama-3.3-70b-versatile",
          stopReason: "error",
          errorMessage: "asynchronous failure",
          timestamp: expect.any(Number),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      },
    ]);
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
