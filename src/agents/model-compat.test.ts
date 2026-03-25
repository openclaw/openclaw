import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import { streamSimpleOpenAICompletions } from "@mariozechner/pi-ai/openai-completions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerRuntimeMocks = vi.hoisted(() => ({
  resolveProviderModernModelRef: vi.fn(),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderModernModelRef: providerRuntimeMocks.resolveProviderModernModelRef,
}));

import { isHighSignalLiveModelRef, isModernModelRef } from "./live-model-filter.js";
import { normalizeModelCompat } from "./model-compat.js";

const baseModel = (): Model<Api> =>
  ({
    id: "glm-4.7",
    name: "GLM-4.7",
    api: "openai-completions",
    provider: "zai",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  }) as Model<Api>;

function supportsDeveloperRole(model: Model<Api>): boolean | undefined {
  return (model.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole;
}

function supportsUsageInStreaming(model: Model<Api>): boolean | undefined {
  return (model.compat as { supportsUsageInStreaming?: boolean } | undefined)
    ?.supportsUsageInStreaming;
}

function supportsStrictMode(model: Model<Api>): boolean | undefined {
  return (model.compat as { supportsStrictMode?: boolean } | undefined)?.supportsStrictMode;
}

function expectSupportsDeveloperRoleForcedOff(overrides?: Partial<Model<Api>>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model<Api>);
  expect(supportsDeveloperRole(normalized)).toBe(false);
}

function expectSupportsUsageInStreamingForcedOff(overrides?: Partial<Model<Api>>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model<Api>);
  expect(supportsUsageInStreaming(normalized)).toBe(false);
}

function expectSupportsUsageInStreamingForcedOn(overrides?: Partial<Model<Api>>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model<Api>);
  expect(supportsUsageInStreaming(normalized)).toBe(true);
}

function expectSupportsStrictModeForcedOff(overrides?: Partial<Model<Api>>): void {
  const model = { ...baseModel(), ...overrides };
  delete (model as { compat?: unknown }).compat;
  const normalized = normalizeModelCompat(model as Model<Api>);
  expect(supportsStrictMode(normalized)).toBe(false);
}

function decodeBodyText(body: unknown): string {
  if (!body) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString("utf8");
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(body)).toString("utf8");
  }
  return "";
}

function buildSseResponse(events: unknown[]): Response {
  const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sse));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function installOpenAiCompletionsStreamMock(params: {
  baseUrl: string;
  onRequest: (body: Record<string, unknown>) => void;
}): { restore: () => void } {
  const originalFetch = globalThis.fetch;
  const completionsUrl = `${params.baseUrl}/chat/completions`;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === completionsUrl) {
      const bodyText =
        typeof (init as { body?: unknown } | undefined)?.body !== "undefined"
          ? decodeBodyText((init as { body?: unknown }).body)
          : input instanceof Request
            ? await input.clone().text()
            : "";
      const parsed = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
      params.onRequest(parsed);
      return buildSseResponse([
        {
          id: "chatcmpl_test",
          object: "chat.completion.chunk",
          created: 0,
          model: "custom-model",
          choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
        },
        {
          id: "chatcmpl_test",
          object: "chat.completion.chunk",
          created: 0,
          model: "custom-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
        {
          id: "chatcmpl_test",
          object: "chat.completion.chunk",
          created: 0,
          model: "custom-model",
          choices: [],
          usage: { prompt_tokens: 72, completion_tokens: 8, total_tokens: 80 },
        },
      ]);
    }

    if (!originalFetch) {
      throw new Error(`fetch is not available (url=${url})`);
    }
    return await originalFetch(input, init);
  };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchImpl;
  return {
    restore: () => {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    },
  };
}

async function collectDoneMessage(
  stream: ReturnType<typeof streamSimpleOpenAICompletions>,
): Promise<AssistantMessage> {
  for await (const event of stream) {
    if (event.type === "done") {
      return event.message;
    }
    if (event.type === "error") {
      throw new Error(event.error.errorMessage ?? "stream failed");
    }
  }
  throw new Error("stream ended without done");
}

let restoreFetch: (() => void) | undefined;

beforeEach(() => {
  providerRuntimeMocks.resolveProviderModernModelRef.mockReset();
  providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(undefined);
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

describe("normalizeModelCompat — Anthropic baseUrl", () => {
  const anthropicBase = (): Model<Api> =>
    ({
      id: "claude-opus-4-6",
      name: "claude-opus-4-6",
      api: "anthropic-messages",
      provider: "anthropic",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    }) as Model<Api>;

  it("strips /v1 suffix from anthropic-messages baseUrl", () => {
    const model = { ...anthropicBase(), baseUrl: "https://api.anthropic.com/v1" };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://api.anthropic.com");
  });

  it("strips trailing /v1/ (with slash) from anthropic-messages baseUrl", () => {
    const model = { ...anthropicBase(), baseUrl: "https://api.anthropic.com/v1/" };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://api.anthropic.com");
  });

  it("leaves anthropic-messages baseUrl without /v1 unchanged", () => {
    const model = { ...anthropicBase(), baseUrl: "https://api.anthropic.com" };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://api.anthropic.com");
  });

  it("leaves baseUrl undefined unchanged for anthropic-messages", () => {
    const model = anthropicBase();
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBeUndefined();
  });

  it("does not strip /v1 from non-anthropic-messages models", () => {
    const model = {
      ...baseModel(),
      provider: "openai",
      api: "openai-responses" as Api,
      baseUrl: "https://api.openai.com/v1",
    };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("strips /v1 from custom Anthropic proxy baseUrl", () => {
    const model = {
      ...anthropicBase(),
      baseUrl: "https://my-proxy.example.com/anthropic/v1",
    };
    const normalized = normalizeModelCompat(model);
    expect(normalized.baseUrl).toBe("https://my-proxy.example.com/anthropic");
  });
});

describe("normalizeModelCompat", () => {
  it("forces supportsDeveloperRole off for z.ai models", () => {
    expectSupportsDeveloperRoleForcedOff();
  });

  it("forces supportsDeveloperRole off for moonshot models", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "moonshot",
      baseUrl: "https://api.moonshot.ai/v1",
    });
  });

  it("forces supportsDeveloperRole off for custom moonshot-compatible endpoints", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "custom-kimi",
      baseUrl: "https://api.moonshot.cn/v1",
    });
  });

  it("forces supportsDeveloperRole off for DashScope provider ids", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
  });

  it("forces supportsDeveloperRole off for DashScope-compatible endpoints", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "custom-qwen",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    });
  });

  it("leaves native api.openai.com model untouched", () => {
    const model = {
      ...baseModel(),
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized.compat).toBeUndefined();
  });

  it("forces supportsDeveloperRole off for Azure OpenAI (Chat Completions, not Responses API)", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "azure-openai",
      baseUrl: "https://my-deployment.openai.azure.com/openai",
    });
  });
  it("forces supportsDeveloperRole off for generic custom openai-completions provider", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "custom-cpa",
      baseUrl: "https://cpa.example.com/v1",
    });
  });

  it("forces supportsUsageInStreaming off for generic custom openai-completions provider", () => {
    expectSupportsUsageInStreamingForcedOff({
      provider: "custom-cpa",
      baseUrl: "https://cpa.example.com/v1",
    });
  });

  it("defaults supportsUsageInStreaming on for Scaleway AI compatible endpoints", () => {
    expectSupportsUsageInStreamingForcedOn({
      provider: "custom-scaleway",
      baseUrl: "https://api.scaleway.ai/v1",
    });
  });

  it("defaults supportsUsageInStreaming on for DashScope compatible-mode endpoints", () => {
    expectSupportsUsageInStreamingForcedOn({
      provider: "custom-bailian",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
  });

  it.each([
    {
      label: "LM Studio",
      provider: "custom-lmstudio",
      baseUrl: "http://127.0.0.1:1234/v1",
    },
    {
      label: "LocalAI",
      provider: "localai",
      baseUrl: "http://localhost:8080/v1",
    },
    {
      label: "TGI",
      provider: "custom-tgi",
      baseUrl: "http://localhost:3000/v1",
    },
    {
      label: "Ollama /v1",
      provider: "custom-ollama",
      baseUrl: "http://localhost:11434/v1",
    },
    {
      label: "Mistral API",
      provider: "mistral",
      baseUrl: "https://api.mistral.ai/v1",
    },
  ])("keeps supportsUsageInStreaming off for $label", ({ provider, baseUrl }) => {
    expectSupportsUsageInStreamingForcedOff({ provider, baseUrl });
  });

  it("forces supportsStrictMode off for z.ai models", () => {
    expectSupportsStrictModeForcedOff();
  });

  it("forces supportsStrictMode off for custom openai-completions provider", () => {
    expectSupportsStrictModeForcedOff({
      provider: "custom-cpa",
      baseUrl: "https://cpa.example.com/v1",
    });
  });

  it("forces supportsDeveloperRole off for Qwen proxy via openai-completions", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "qwen-proxy",
      baseUrl: "https://qwen-api.example.org/compatible-mode/v1",
    });
  });

  it("leaves openai-completions model with empty baseUrl untouched", () => {
    const model = {
      ...baseModel(),
      provider: "openai",
    };
    delete (model as { baseUrl?: unknown }).baseUrl;
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model as Model<Api>);
    expect(normalized.compat).toBeUndefined();
  });

  it("forces supportsDeveloperRole off for malformed baseUrl values", () => {
    expectSupportsDeveloperRoleForcedOff({
      provider: "custom-cpa",
      baseUrl: "://api.openai.com malformed",
    });
  });

  it("respects explicit supportsDeveloperRole true on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsDeveloperRole: true },
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(true);
  });

  it("respects explicit supportsUsageInStreaming true on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsUsageInStreaming: true },
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsUsageInStreaming(normalized)).toBe(true);
  });

  it("preserves explicit supportsUsageInStreaming false on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsUsageInStreaming: false },
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
  });

  it("still forces flags off when not explicitly set by user", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
    expect(supportsStrictMode(normalized)).toBe(false);
  });

  it("respects explicit supportsStrictMode true on non-native endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
      compat: { supportsStrictMode: true },
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsStrictMode(normalized)).toBe(true);
  });

  it("does not mutate caller model when forcing supportsDeveloperRole off", () => {
    const model = {
      ...baseModel(),
      provider: "custom-cpa",
      baseUrl: "https://proxy.example.com/v1",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized).not.toBe(model);
    expect(supportsDeveloperRole(model)).toBeUndefined();
    expect(supportsUsageInStreaming(model)).toBeUndefined();
    expect(supportsStrictMode(model)).toBeUndefined();
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
    expect(supportsStrictMode(normalized)).toBe(false);
  });

  it("does not override explicit compat false", () => {
    const model = baseModel();
    model.compat = {
      supportsDeveloperRole: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(false);
    expect(supportsUsageInStreaming(normalized)).toBe(false);
    expect(supportsStrictMode(normalized)).toBe(false);
  });

  it("leaves fully explicit non-native compat untouched", () => {
    const model = baseModel();
    model.baseUrl = "https://proxy.example.com/v1";
    model.compat = {
      supportsDeveloperRole: false,
      supportsUsageInStreaming: true,
      supportsStrictMode: true,
    };
    const normalized = normalizeModelCompat(model);
    expect(normalized).toBe(model);
  });

  it("preserves explicit usage compat when developer role is explicitly enabled", () => {
    const model = baseModel();
    model.baseUrl = "https://proxy.example.com/v1";
    model.compat = {
      supportsDeveloperRole: true,
      supportsUsageInStreaming: true,
      supportsStrictMode: true,
    };
    const normalized = normalizeModelCompat(model);
    expect(supportsDeveloperRole(normalized)).toBe(true);
    expect(supportsUsageInStreaming(normalized)).toBe(true);
    expect(supportsStrictMode(normalized)).toBe(true);
  });

  it("requests streaming usage and records the final usage-only chunk for allowlisted endpoints", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const baseUrl = "https://api.scaleway.ai/v1";
    restoreFetch = installOpenAiCompletionsStreamMock({
      baseUrl,
      onRequest: (body) => {
        requestBody = body;
      },
    }).restore;

    const model = normalizeModelCompat({
      id: "scw-test",
      name: "Scaleway Test",
      api: "openai-completions",
      provider: "custom-scaleway",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    }) as Model<"openai-completions">;

    const stream = streamSimpleOpenAICompletions(
      model,
      {
        systemPrompt: "",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
        tools: undefined,
      },
      {
        apiKey: "test-key",
      },
    );

    const message = await collectDoneMessage(stream);

    expect(requestBody?.stream).toBe(true);
    expect(requestBody?.stream_options).toEqual({ include_usage: true });
    expect(message.usage).toMatchObject({
      input: 72,
      output: 8,
      totalTokens: 80,
    });
  });
});

describe("isModernModelRef", () => {
  it("uses provider runtime hooks before fallback heuristics", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(false);

    expect(isModernModelRef({ provider: "openrouter", id: "claude-opus-4-6" })).toBe(false);
  });

  it("includes plugin-advertised modern models", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockImplementation(({ provider, context }) =>
      provider === "openai" &&
      ["gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano"].includes(context.modelId)
        ? true
        : provider === "openai-codex" && context.modelId === "gpt-5.4"
          ? true
          : provider === "opencode" && ["claude-opus-4-6", "gemini-3-pro"].includes(context.modelId)
            ? true
            : provider === "opencode-go"
              ? true
              : undefined,
    );

    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4" })).toBe(true);
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4-pro" })).toBe(true);
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4-mini" })).toBe(true);
    expect(isModernModelRef({ provider: "openai", id: "gpt-5.4-nano" })).toBe(true);
    expect(isModernModelRef({ provider: "openai-codex", id: "gpt-5.4" })).toBe(true);
    expect(isModernModelRef({ provider: "opencode", id: "claude-opus-4-6" })).toBe(true);
    expect(isModernModelRef({ provider: "opencode", id: "gemini-3-pro" })).toBe(true);
    expect(isModernModelRef({ provider: "opencode-go", id: "kimi-k2.5" })).toBe(true);
    expect(isModernModelRef({ provider: "opencode-go", id: "glm-5" })).toBe(true);
    expect(isModernModelRef({ provider: "opencode-go", id: "minimax-m2.7" })).toBe(true);
  });

  it("excludes provider-declined modern models", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockImplementation(({ provider, context }) =>
      provider === "opencode" && context.modelId === "minimax-m2.7" ? false : undefined,
    );

    expect(isModernModelRef({ provider: "opencode", id: "minimax-m2.7" })).toBe(false);
  });
});

describe("isHighSignalLiveModelRef", () => {
  it("keeps modern higher-signal Claude families", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockImplementation(({ provider, context }) =>
      provider === "anthropic" && ["claude-sonnet-4-5", "claude-opus-4-5"].includes(context.modelId)
        ? true
        : undefined,
    );

    expect(isHighSignalLiveModelRef({ provider: "anthropic", id: "claude-sonnet-4-5" })).toBe(true);
    expect(isHighSignalLiveModelRef({ provider: "anthropic", id: "claude-opus-4-5" })).toBe(true);
  });

  it("drops low-signal or old Claude variants even when provider marks them modern", () => {
    providerRuntimeMocks.resolveProviderModernModelRef.mockReturnValue(true);

    expect(
      isHighSignalLiveModelRef({ provider: "anthropic", id: "claude-haiku-4-5-20251001" }),
    ).toBe(false);
    expect(
      isHighSignalLiveModelRef({ provider: "opencode", id: "claude-3-5-haiku-20241022" }),
    ).toBe(false);
  });
});
