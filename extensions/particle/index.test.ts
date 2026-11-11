import assert from "node:assert/strict";
import type { Model } from "openclaw/plugin-sdk/llm";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import {
  createRuntimeEnv,
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { expect, it, vi } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import plugin from "./index.js";

async function particleModel(): Promise<Model<"openai-completions">> {
  const provider = await registerSingleProviderPlugin(plugin);
  const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
  const model = catalog.models.find((entry) => entry.id === "particle-ai/particle-1");
  assert(model, "Particle-1 must be discoverable before credentials are configured");
  return {
    ...model,
    provider: "particle",
    api: "openai-completions",
    baseUrl: catalog.baseUrl,
    input: model.input.filter((input) => input === "text" || input === "image"),
  };
}

it("onboards an existing API-key profile without losing other provider configuration", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  const method = resolveProviderPluginChoice({
    providers: [provider],
    choice: "particle-api-key",
  })?.method;
  assert(method?.runNonInteractive, "Missing Particle API-key onboarding");
  const config = {
    models: {
      mode: "replace" as const,
      providers: { existing: { baseUrl: "https://example.com/v1", models: [] } },
    },
  };
  const resolveApiKey = vi.fn(async () => ({ key: "synthetic-key", source: "profile" as const }));
  const result = await method.runNonInteractive({
    authChoice: "particle-api-key",
    opts: { particleApiKey: "synthetic-key" },
    config,
    baseConfig: config,
    runtime: createRuntimeEnv(),
    resolveApiKey,
    toApiKeyCredential: () => null,
  });
  expect(resolveApiKey).toHaveBeenCalledWith({
    provider: "particle",
    flagValue: "synthetic-key",
    flagName: "--particle-api-key",
    envVar: "PARTICLE_API_KEY",
  });
  expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
    "particle/particle-ai/particle-1",
  );
  expect(result?.models?.mode).toBe("replace");
  expect(result?.models?.providers?.existing).toEqual(config.models.providers.existing);
  expect(result?.models?.providers?.particle).toMatchObject({
    api: "openai-completions",
    baseUrl: "https://api.particle.ai/v1",
    models: [
      {
        id: "particle-ai/particle-1",
        input: ["text", "image"],
        contextWindow: 1_048_576,
        maxTokens: 131_072,
      },
    ],
  });
});

it("serializes Particle reasoning levels and cache affinity without unsupported retention or strict tools", async () => {
  const model = await particleModel();
  for (const [reasoning, effort] of [
    ["off", "none"],
    ["minimal", "low"],
    ["low", "low"],
    ["medium", "high"],
    ["high", "high"],
    ["xhigh", "high"],
    ["max", "max"],
  ] as const) {
    const payload = buildOpenAICompletionsParams(
      model,
      {
        messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        tools: [
          {
            name: "lookup",
            description: "Look up a value",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      { reasoning, maxTokens: 1024, sessionId: "synthetic-session", cacheRetention: "long" },
    );
    expect(payload).toMatchObject({
      model: "particle-ai/particle-1",
      reasoning_effort: effort,
      max_tokens: 1024,
      prompt_cache_key: "synthetic-session",
    });
    expect(payload).not.toHaveProperty("prompt_cache_retention");
    expect(payload).toMatchObject({ tools: [{ type: "function", function: { name: "lookup" } }] });
    expect(payload).not.toHaveProperty("tools.0.function.strict", true);
  }
});

it("routes a streaming tool call to the Particle endpoint with bearer auth and parses usage", async () => {
  const model = await particleModel();
  let request: Request | undefined;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    request = new Request(input, init);
    const chunk = {
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "particle-ai/particle-1",
    };
    const frames = [
      {
        ...chunk,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", reasoning_content: "Need a lookup." },
            finish_reason: null,
          },
        ],
      },
      {
        ...chunk,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_fixture",
                  type: "function",
                  function: { name: "lookup", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      {
        ...chunk,
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 40 },
          completion_tokens_details: { reasoning_tokens: 10 },
        },
      },
    ];
    return new Response(
      frames
        .map(
          (frame) => `data: ${JSON.stringify(frame)}

`,
        )
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  try {
    const result = await streamSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Look it up" },
              { type: "image", data: "c3ludGhldGljLWltYWdl", mimeType: "image/png" },
            ],
            timestamp: 1,
          },
        ],
        tools: [
          {
            name: "lookup",
            description: "Look up a value",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      { apiKey: "synthetic-particle-key", reasoning: "high", maxTokens: 128 },
    ).result();
    expect(fetchMock).toHaveBeenCalledOnce();
    assert(request);
    expect(request.url).toBe("https://api.particle.ai/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe("Bearer synthetic-particle-key");
    expect(await request.json()).toMatchObject({
      model: "particle-ai/particle-1",
      stream: true,
      reasoning_effort: "high",
      max_tokens: 128,
      stream_options: { include_usage: true },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look it up" },
            { type: "image_url", image_url: { url: "data:image/png;base64,c3ludGhldGljLWltYWdl" } },
          ],
        },
      ],
    });
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "thinking", thinking: "Need a lookup." }),
    );
    expect(result.content).toContainEqual({
      type: "toolCall",
      id: "call_fixture",
      name: "lookup",
      arguments: {},
    });
    expect(result.usage).toMatchObject({ input: 60, output: 20, cacheRead: 40, totalTokens: 120 });
  } finally {
    fetchMock.mockRestore();
  }
});

it("lists the account's models, folding Particle-1's listed id onto its catalog row", async () => {
  // Shape of GET https://api.particle.ai/v1/models (2026-10-30): prefixed ids, each listed twice.
  const listed = [
    "deepseek-ai/deepseek-v41-flash-1017",
    "particle-ai/particle-1",
    "z-ai/glm-5.3-flash",
  ];
  const guardedFetch = vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockResolvedValue({
    response: Response.json({ data: [...listed, ...listed].map((id) => ({ id })) }),
    finalUrl: "https://api.particle.ai/v1/models",
    release: vi.fn(async () => undefined),
  });
  try {
    const provider = await registerSingleProviderPlugin(plugin);
    const catalog = await runSingleProviderCatalog(provider);
    expect(catalog.models.map((model) => model.id).toSorted()).toEqual([
      "deepseek-ai/deepseek-v41-flash-1017",
      "particle-ai/particle-1",
      "z-ai/glm-5.3-flash",
    ]);
    expect(catalog.models.find((model) => model.id === "particle-ai/particle-1")).toMatchObject({
      contextWindow: 1048576,
      compat: { defaultThinkingLevel: "high" },
    });
    expect(guardedFetch.mock.calls[0]?.[0]?.url).toBe("https://api.particle.ai/v1/models");
  } finally {
    guardedFetch.mockRestore();
  }
});
