import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createCapturedPluginRegistration } from "../../src/plugins/captured-registration.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import aimlapiPlugin from "./index.js";
import { __testing as aimlapiWebSearchTesting } from "./src/aimlapi-web-search-provider.js";

describe("AIMLAPI provider plugin", () => {
  it("normalizes tool schemas before sending the payload", async () => {
    const provider = registerSingleProviderPlugin(aimlapiPlugin);
    const wrapStreamFn = provider.wrapStreamFn;
    expect(wrapStreamFn).toBeTypeOf("function");

    const payload = {
      tools: [
        {
          name: "example_tool",
          description: "Example",
          parameters: {
            anyOf: [
              {
                type: "object",
                properties: {
                  action: {
                    const: "run",
                  },
                },
                required: ["action"],
              },
              {
                type: "object",
                properties: {
                  action: {
                    const: "stop",
                  },
                },
                required: ["action"],
              },
            ],
          },
        },
      ],
    };

    const baseStreamFn = vi.fn(async (_model, _context, options) => {
      options?.onPayload?.(payload, _model);
      return {} as never;
    });

    const wrapped = wrapStreamFn?.({
      provider: "aimlapi",
      modelId: "openai/gpt-5-nano-2025-08-07",
      extraParams: {},
      streamFn: baseStreamFn,
    });

    await wrapped?.(
      {
        id: "openai/gpt-5-nano-2025-08-07",
        provider: "aimlapi",
      } as never,
      {} as never,
      {},
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
    expect(payload.tools[0]?.parameters).toMatchObject({
      type: "object",
      properties: {
        action: {
          enum: ["run", "stop"],
        },
      },
      required: ["action"],
    });
    expect(payload.tools[0]?.parameters).not.toHaveProperty("additionalProperties");
  });

  it("broadens unsupported tool_choice payloads before sending", async () => {
    const provider = registerSingleProviderPlugin(aimlapiPlugin);
    const wrapStreamFn = provider.wrapStreamFn;
    expect(wrapStreamFn).toBeTypeOf("function");

    const payload: Record<string, unknown> = {
      tool_choice: "required",
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      ],
    };

    const baseStreamFn = vi.fn(async (_model, _context, options) => {
      options?.onPayload?.(payload, _model);
      return {} as never;
    });

    const wrapped = wrapStreamFn?.({
      provider: "aimlapi",
      modelId: "openai/gpt-5-nano-2025-08-07",
      extraParams: {},
      streamFn: baseStreamFn,
    });

    await wrapped?.(
      {
        id: "openai/gpt-5-nano-2025-08-07",
        provider: "aimlapi",
      } as never,
      {} as never,
      {},
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
    expect(payload.tool_choice).toBe("auto");
  });

  it("converts pinned tool_choice payloads to OpenAI function format", async () => {
    const provider = registerSingleProviderPlugin(aimlapiPlugin);
    const wrapStreamFn = provider.wrapStreamFn;
    expect(wrapStreamFn).toBeTypeOf("function");

    const payload: Record<string, unknown> = {
      tool_choice: { type: "tool", name: "read" },
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      ],
    };

    const baseStreamFn = vi.fn(async (_model, _context, options) => {
      options?.onPayload?.(payload, _model);
      return {} as never;
    });

    const wrapped = wrapStreamFn?.({
      provider: "aimlapi",
      modelId: "openai/gpt-5-nano-2025-08-07",
      extraParams: {},
      streamFn: baseStreamFn,
    });

    await wrapped?.(
      {
        id: "openai/gpt-5-nano-2025-08-07",
        provider: "aimlapi",
      } as never,
      {} as never,
      {},
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
    expect(payload.tool_choice).toEqual({
      type: "function",
      function: { name: "read" },
    });
  });

  it("removes AIMLAPI-unsupported schema keywords before sending", async () => {
    const provider = registerSingleProviderPlugin(aimlapiPlugin);
    const wrapStreamFn = provider.wrapStreamFn;
    expect(wrapStreamFn).toBeTypeOf("function");

    const payload = {
      tools: [
        {
          name: "example_tool",
          description: "Example",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: ["string", "null"],
                format: "email",
                minLength: 3,
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    };

    const baseStreamFn = vi.fn(async (_model, _context, options) => {
      options?.onPayload?.(payload, _model);
      return {} as never;
    });

    const wrapped = wrapStreamFn?.({
      provider: "aimlapi",
      modelId: "openai/gpt-5-nano-2025-08-07",
      extraParams: {},
      streamFn: baseStreamFn,
    });

    await wrapped?.(
      {
        id: "openai/gpt-5-nano-2025-08-07",
        provider: "aimlapi",
      } as never,
      {} as never,
      {},
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
    expect(payload.tools[0]?.parameters).toEqual({
      type: "object",
      properties: {
        query: {
          type: "string",
        },
      },
      required: ["query"],
    });
  });

  it("rewrites assistant null content in outbound messages", async () => {
    const provider = registerSingleProviderPlugin(aimlapiPlugin);
    const wrapStreamFn = provider.wrapStreamFn;
    expect(wrapStreamFn).toBeTypeOf("function");

    const payload: Record<string, unknown> = {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1" }] },
      ],
    };

    const baseStreamFn = vi.fn(async (_model, _context, options) => {
      options?.onPayload?.(payload, _model);
      return {} as never;
    });

    const wrapped = wrapStreamFn?.({
      provider: "aimlapi",
      modelId: "openai/gpt-5-nano-2025-08-07",
      extraParams: {},
      streamFn: baseStreamFn,
    });

    await wrapped?.(
      {
        id: "openai/gpt-5-nano-2025-08-07",
        provider: "aimlapi",
      } as never,
      {} as never,
      {},
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
    expect((payload.messages as Array<Record<string, unknown>>)[1]?.content).toBe("");
  });

  it("augments the model catalog from models.json without duplicating existing entries", async () => {
    const provider = registerSingleProviderPlugin(aimlapiPlugin);
    const augmentModelCatalog = provider.augmentModelCatalog;
    expect(augmentModelCatalog).toBeTypeOf("function");

    vi.spyOn(fs, "readFile").mockResolvedValue(
      JSON.stringify({
        providers: {
          aimlapi: {
            models: [
              {
                id: "openai/gpt-5-nano-2025-08-07",
                name: "GPT-5 Nano",
                reasoning: false,
                input: ["text", "image"],
                contextWindow: 128000,
              },
              {
                id: "openai/gpt-4.1-mini",
                name: "GPT-4.1 Mini",
                reasoning: false,
                input: ["text"],
              },
            ],
          },
        },
      }),
    );

    const entries = await augmentModelCatalog?.({
      agentDir: "/tmp/openclaw",
      env: process.env,
      entries: [
        {
          provider: "aimlapi",
          id: "openai/gpt-5-nano-2025-08-07",
          name: "GPT-5 Nano",
        },
      ],
    });

    expect(entries).toEqual([
      {
        provider: "aimlapi",
        id: "openai/gpt-4.1-mini",
        name: "GPT-4.1 Mini",
        reasoning: false,
        input: ["text"],
      },
    ]);
  });

  it("registers the AIMLAPI web search provider with plugin-owned config paths", () => {
    const captured = createCapturedPluginRegistration();
    aimlapiPlugin.register(captured.api);
    const webSearchProvider = captured.webSearchProviders[0];

    expect(webSearchProvider).toMatchObject({
      id: "aimlapi",
      credentialPath: "plugins.entries.aimlapi.config.webSearch.apiKey",
      envVars: ["AIMLAPI_API_KEY"],
      autoDetectOrder: 15,
    });
  });

  it("merges plugin web-search config with legacy AIMLAPI fallback fields", () => {
    const config = {
      plugins: {
        entries: {
          aimlapi: {
            config: {
              webSearch: {
                apiKey: "plugin-key",
              },
            },
          },
        },
      },
    };
    const searchConfig = {
      aimlapi: {
        baseUrl: "https://legacy.example/v1",
        model: "perplexity/sonar",
      },
    };

    expect(aimlapiWebSearchTesting.resolveAimlapiConfig(config, searchConfig)).toEqual({
      apiKey: "plugin-key",
      baseUrl: "https://legacy.example/v1",
      model: "perplexity/sonar",
    });
  });

  it("fails soft when the aimlapi catalog supplement is invalid", async () => {
    const provider = registerSingleProviderPlugin(aimlapiPlugin);
    const augmentModelCatalog = provider.augmentModelCatalog;
    expect(augmentModelCatalog).toBeTypeOf("function");

    vi.spyOn(fs, "readFile").mockResolvedValue("{invalid-json");

    const entries = await augmentModelCatalog?.({
      agentDir: "/tmp/openclaw",
      env: process.env,
      entries: [],
    });

    expect(entries).toEqual([]);
  });
});
