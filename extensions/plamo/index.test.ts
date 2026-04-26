import { once } from "node:events";
import { createServer } from "node:http";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachModelProviderRequestTransport } from "../../src/agents/provider-request-config.js";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-wizard.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plamoPlugin from "./index.js";
import { PLAMO_REQUEST_AUTH_MARKER } from "./provider-catalog.js";
import { createPlamoToolCallWrapper, normalizePlamoToolMarkupInMessage } from "./stream.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-http-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-http-runtime")>(
    "openclaw/plugin-sdk/provider-http-runtime",
  );
  return {
    ...actual,
    buildGuardedModelFetch:
      (_model: unknown, options?: { auditContext?: string }) =>
      async (input: Request | URL | string, init?: RequestInit) => {
        const request = input instanceof Request ? new Request(input, init) : undefined;
        const url =
          request?.url ??
          (input instanceof URL
            ? input.toString()
            : typeof input === "string"
              ? input
              : (() => {
                  throw new Error("unsupported fetch input for PLaMo transport test");
                })());
        const requestInit =
          request &&
          ({
            method: request.method,
            headers: request.headers,
            body: request.body ?? undefined,
            redirect: request.redirect,
            signal: request.signal,
            ...(request.body ? ({ duplex: "half" } as const) : {}),
          } satisfies RequestInit & { duplex?: "half" });
        const result = await fetchWithSsrFGuardMock({
          url,
          init: requestInit ?? init,
          ...(options?.auditContext ? { auditContext: options.auditContext } : {}),
        });
        return result.response as Response;
      },
  };
});

type FakeWrappedStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

function createFakeStream(params: {
  events: unknown[];
  resultMessage: unknown;
}): FakeWrappedStream {
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events) {
          yield event;
        }
      })();
    },
  };
}

async function loadPlamoCatalog() {
  const provider = await registerSingleProviderPlugin(plamoPlugin);
  const catalog = await provider.catalog!.run({
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: "test-key" }),
    resolveProviderAuth: () => ({
      apiKey: "test-key",
      mode: "api_key",
      source: "env",
    }),
  } as never);

  if (!catalog || !("provider" in catalog)) {
    throw new Error("expected single-provider catalog");
  }

  return { provider, catalog };
}

function createWrappedPlamoStream(
  provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>,
  options?: {
    modelId?: string;
  },
) {
  const modelId = options?.modelId ?? "plamo-3.0-prime-beta";
  const wrapped = provider.createStreamFn?.({
    config: {},
    provider: "plamo",
    modelId,
    model: {
      api: "openai-completions",
      provider: "plamo",
      id: modelId,
    } as never,
  } as never);
  if (!wrapped) {
    throw new Error("expected wrapped stream function");
  }
  return wrapped;
}

function createDynamicContext(params: {
  provider: string;
  modelId: string;
  models: ProviderRuntimeModel[];
  providerConfig?: ProviderResolveDynamicModelContext["providerConfig"];
}): ProviderResolveDynamicModelContext {
  return {
    provider: params.provider,
    modelId: params.modelId,
    providerConfig: params.providerConfig,
    modelRegistry: {
      find(providerId: string, modelId: string) {
        return (
          params.models.find(
            (model) =>
              model.provider === providerId && model.id.toLowerCase() === modelId.toLowerCase(),
          ) ?? null
        );
      },
    } as ModelRegistry,
  };
}

beforeEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  fetchWithSsrFGuardMock.mockImplementation(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as {
      url: string;
      init?: RequestInit;
    };
    return {
      response: await fetch(params.url, params.init),
      release: async () => {},
    };
  });
});

describe("plamo provider plugin", () => {
  it("registers PLaMo with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(plamoPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "plamo-api-key",
    });

    expect(provider.id).toBe("plamo");
    expect(provider.label).toBe("PLaMo");
    expect(provider.envVars).toEqual(["PLAMO_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(provider.buildReplayPolicy).toBeTypeOf("function");
    expect(provider.sanitizeReplayHistory).toBeTypeOf("function");
    expect(provider.createStreamFn).toBeTypeOf("function");
    expect(provider.wrapStreamFn).toBeUndefined();
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("plamo");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("advertises PLaMo refs as modern models", async () => {
    const provider = await registerSingleProviderPlugin(plamoPlugin);

    expect(
      provider.isModernModelRef?.({
        provider: "plamo",
        modelId: "plamo-3.0-prime-beta",
      } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({
        provider: "plamo",
        modelId: " PLaMo-next-preview ",
      } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({
        provider: "plamo",
        modelId: "gpt-5.4",
      } as never),
    ).toBe(false);
  });

  it("exposes synthetic auth for request-authenticated PLaMo configs", async () => {
    const provider = await registerSingleProviderPlugin(plamoPlugin);

    expect(
      provider.resolveSyntheticAuth?.({
        provider: "plamo",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://proxy.example.test/v1",
          request: {
            auth: {
              mode: "header",
              headerName: "X-Proxy-Token",
              value: {
                source: "env",
                provider: "default",
                id: "PLAMO_PROXY_TOKEN",
              },
            },
          },
          models: [],
        },
      } as never),
    ).toEqual({
      apiKey: PLAMO_REQUEST_AUTH_MARKER,
      source: "models.providers.plamo.request (synthetic request auth)",
      mode: "api-key",
    });

    expect(
      provider.resolveSyntheticAuth?.({
        provider: "plamo",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://proxy.example.test/v1",
          headers: {
            Authorization: {
              source: "env",
              provider: "default",
              id: "PLAMO_PROXY_TOKEN",
            },
          },
          models: [],
        },
      } as never),
    ).toEqual({
      apiKey: PLAMO_REQUEST_AUTH_MARKER,
      source: "models.providers.plamo.request (synthetic request auth)",
      mode: "api-key",
    });

    expect(
      provider.resolveSyntheticAuth?.({
        provider: "plamo",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://proxy.example.test/v1",
          request: {
            headers: {
              "X-Proxy-Token": {
                source: "env",
                provider: "default",
                id: "PLAMO_PROXY_TOKEN",
              },
            },
          },
          models: [],
        },
      } as never),
    ).toEqual({
      apiKey: PLAMO_REQUEST_AUTH_MARKER,
      source: "models.providers.plamo.request (synthetic request auth)",
      mode: "api-key",
    });

    expect(
      provider.resolveSyntheticAuth?.({
        provider: "plamo",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://proxy.example.test/v1",
          request: {
            headers: {
              "X-Tenant": {
                source: "env",
                provider: "default",
                id: "PLAMO_TENANT",
              },
            },
          },
          models: [],
        },
      } as never),
    ).toBeUndefined();
  });

  it("builds the static PLaMo model catalog", async () => {
    const { provider, catalog } = await loadPlamoCatalog();
    expect(provider.catalog).toBeDefined();

    expect(catalog.provider.api).toBe("openai-completions");
    expect(catalog.provider.baseUrl).toBe("https://api.platform.preferredai.jp/v1");
    expect(catalog.provider.models).toEqual([
      {
        id: "plamo-3.0-prime-beta",
        name: "PLaMo 3.0 Prime Beta",
        reasoning: false,
        input: ["text"],
        cost: { input: 0.375, output: 1.5625, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 65_536,
        maxTokens: 20_000,
        compat: {
          maxTokensField: "max_tokens",
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsStore: false,
          supportsStrictMode: false,
        },
      },
    ]);
  });

  it("keeps the PLaMo catalog available for header-authenticated setups without an api key", async () => {
    const provider = await registerSingleProviderPlugin(plamoPlugin);
    const catalog = await provider.catalog!.run({
      config: {
        models: {
          providers: {
            plamo: {
              baseUrl: "https://proxy.example.test/v1",
              request: {
                auth: {
                  mode: "header",
                  headerName: "X-Proxy-Token",
                  value: {
                    source: "env",
                    provider: "default",
                    id: "PLAMO_PROXY_TOKEN",
                  },
                },
              },
              models: [],
            },
          },
        },
      },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({
        apiKey: undefined,
        mode: "none",
        source: "none",
      }),
    } as never);

    expect(catalog).toMatchObject({
      provider: {
        api: "openai-completions",
        baseUrl: "https://proxy.example.test/v1",
      },
    });
  });

  it("keeps the PLaMo catalog available when proxy auth is supplied via request headers", async () => {
    const provider = await registerSingleProviderPlugin(plamoPlugin);
    const catalog = await provider.catalog!.run({
      config: {
        models: {
          providers: {
            plamo: {
              baseUrl: "https://proxy.example.test/v1",
              request: {
                headers: {
                  "X-Proxy-Token": {
                    source: "env",
                    provider: "default",
                    id: "PLAMO_PROXY_TOKEN",
                  },
                },
              },
              models: [],
            },
          },
        },
      },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({
        apiKey: undefined,
        mode: "none",
        source: "none",
      }),
    } as never);

    expect(catalog).toMatchObject({
      provider: {
        api: "openai-completions",
        baseUrl: "https://proxy.example.test/v1",
      },
    });
  });

  it("keeps the PLaMo catalog available when auth is supplied via top-level provider headers", async () => {
    const provider = await registerSingleProviderPlugin(plamoPlugin);
    const catalog = await provider.catalog!.run({
      config: {
        models: {
          providers: {
            plamo: {
              baseUrl: "https://proxy.example.test/v1",
              headers: {
                Authorization: {
                  source: "env",
                  provider: "default",
                  id: "PLAMO_PROXY_TOKEN",
                },
              },
              models: [],
            },
          },
        },
      },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({
        apiKey: undefined,
        mode: "none",
        source: "none",
      }),
    } as never);

    expect(catalog).toMatchObject({
      provider: {
        api: "openai-completions",
        baseUrl: "https://proxy.example.test/v1",
      },
    });
  });

  it("does not keep the PLaMo catalog available for non-auth request headers alone", async () => {
    const provider = await registerSingleProviderPlugin(plamoPlugin);
    const catalog = await provider.catalog!.run({
      config: {
        models: {
          providers: {
            plamo: {
              baseUrl: "https://proxy.example.test/v1",
              request: {
                headers: {
                  "X-Tenant": {
                    source: "env",
                    provider: "default",
                    id: "PLAMO_TENANT",
                  },
                },
              },
              models: [],
            },
          },
        },
      },
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({
        apiKey: undefined,
        mode: "none",
        source: "none",
      }),
    } as never);

    expect(catalog).toBeNull();
  });

  it("resolves forward-compat PLaMo model ids even when the local catalog has no template row", async () => {
    const provider = await registerSingleProviderPlugin(plamoPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createDynamicContext({
        provider: "plamo",
        modelId: "plamo-next-preview",
        models: [],
      }),
    );

    expect(resolved).toMatchObject({
      provider: "plamo",
      id: "plamo-next-preview",
      api: "openai-completions",
      baseUrl: "https://api.platform.preferredai.jp/v1",
      reasoning: false,
      input: ["text"],
      contextWindow: 65_536,
      maxTokens: 20_000,
      compat: {
        maxTokensField: "max_tokens",
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStore: false,
        supportsStrictMode: false,
      },
    });
  });

  it("inherits the resolved template baseUrl for forward-compat PLaMo models", async () => {
    const provider = await registerSingleProviderPlugin(plamoPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createDynamicContext({
        provider: "plamo",
        modelId: "plamo-next-preview",
        models: [
          {
            provider: "plamo",
            api: "openai-completions",
            id: "plamo-3.0-prime-beta",
            name: "PLaMo 3.0 Prime Beta",
            baseUrl: "https://proxy.example.test/v1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0.375, output: 1.5625, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 65_536,
            maxTokens: 20_000,
            compat: {
              maxTokensField: "max_tokens",
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              supportsStore: false,
              supportsStrictMode: false,
            },
          } as ProviderRuntimeModel,
        ],
      }),
    );

    expect(resolved).toMatchObject({
      provider: "plamo",
      id: "plamo-next-preview",
      api: "openai-completions",
      baseUrl: "https://proxy.example.test/v1",
      reasoning: false,
    });
  });

  it("inherits configured provider baseUrl when forward-compat fallback has no template row", async () => {
    const provider = await registerSingleProviderPlugin(plamoPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createDynamicContext({
        provider: "plamo",
        modelId: "plamo-next-preview",
        models: [],
        providerConfig: {
          baseUrl: "https://proxy.example.test/v1",
        },
      }),
    );

    expect(resolved).toMatchObject({
      provider: "plamo",
      id: "plamo-next-preview",
      api: "openai-completions",
      baseUrl: "https://proxy.example.test/v1",
      reasoning: false,
    });
  });

  it("drops replayed assistant thinking blocks before sending follow-up turns", async () => {
    const { provider, catalog } = await loadPlamoCatalog();

    let resolveRequest: ((value: { body: Record<string, unknown> }) => void) | null = null;
    const requestSeen = new Promise<{
      body: Record<string, unknown>;
    }>((resolve) => {
      resolveRequest = resolve;
    });

    const server = createServer((req, res) => {
      const chunks: string[] = [];
      req.setEncoding("utf8");
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        resolveRequest?.({
          body: JSON.parse(chunks.join("")) as Record<string, unknown>,
        });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-stream-test",
            choices: [{ index: 0, delta: { content: "ok" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-stream-test",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);

    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "internal reasoning that must not be replayed",
                thinkingSignature: "reasoning_content",
              },
              {
                type: "redacted_thinking",
                data: "encrypted reasoning that must not be replayed",
              },
              { type: "text", text: "前回の回答です。" },
            ],
          },
          { role: "user", content: "続けて" },
        ],
      } as never,
      {
        apiKey: "test-key",
        reasoningEffort: "low",
      } as never,
    );

    try {
      for await (const _event of stream) {
        // Drain the stream so the request completes.
      }
      await stream.result();
    } finally {
      server.close();
    }

    const request = await requestSeen;
    expect(request.body.max_tokens).toBe(20_000);
    expect(request.body.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "assistant", content: "前回の回答です。" },
      { role: "user", content: "続けて" },
    ]);
    expect((request.body.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty(
      "reasoning_content",
    );
  });

  it("owns replay cleanup through provider replay hooks", async () => {
    const provider = await registerSingleProviderPlugin(plamoPlugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "plamo",
        modelId: "plamo-3.0-prime-beta",
        modelApi: "openai-completions",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });

    const sanitized = await provider.sanitizeReplayHistory?.({
      provider: "plamo",
      modelId: "plamo-3.0-prime-beta",
      modelApi: "openai-completions",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "reasoning that should not be replayed",
              thinkingSignature: "reasoning_content",
            },
            {
              type: "redacted_thinking",
              data: "encrypted reasoning that should not be replayed",
            },
            { type: "toolUse", id: "call_1", name: "read", input: { path: "README.md" } },
            { type: "functionCall", id: "call_2", name: "exec", arguments: { cmd: "pwd" } },
            { type: "text", text: "Answer" },
          ],
        },
      ],
      sessionId: "session-1",
    } as never);

    expect(sanitized).toEqual([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
          { type: "toolCall", id: "call_2", name: "exec", arguments: { cmd: "pwd" } },
          { type: "text", text: "Answer" },
        ],
      },
    ]);
  });

  it("sends the documented streaming payload and auth headers on the wire", async () => {
    const { provider, catalog } = await loadPlamoCatalog();

    let resolveRequest:
      | ((value: {
          method: string | undefined;
          url: string | undefined;
          headers: Record<string, string | string[] | undefined>;
          body: Record<string, unknown>;
        }) => void)
      | null = null;
    const requestSeen = new Promise<{
      method: string | undefined;
      url: string | undefined;
      headers: Record<string, string | string[] | undefined>;
      body: Record<string, unknown>;
    }>((resolve) => {
      resolveRequest = resolve;
    });

    const server = createServer((req, res) => {
      const chunks: string[] = [];
      req.setEncoding("utf8");
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        resolveRequest?.({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: JSON.parse(chunks.join("")) as Record<string, unknown>,
        });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-stream-test",
            choices: [{ index: 0, delta: { content: "ok" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-stream-test",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      } as never,
      {
        apiKey: "test-key",
        maxTokens: 512,
        reasoningEffort: "low",
        onPayload: async (payload: unknown) => ({
          ...(payload as Record<string, unknown>),
          stream_options: { include_usage: true },
          store: false,
          reasoning_effort: "low",
        }),
      } as never,
    );

    let result: Awaited<ReturnType<typeof stream.result>> | undefined;
    try {
      for await (const _event of stream) {
        // Drain the stream so the request completes.
      }
      result = await stream.result();
    } finally {
      server.close();
    }

    expect(result).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
    });

    const request = await requestSeen;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer test-key");
    expect(String(request.headers["content-type"] ?? "")).toContain("application/json");
    expect(request.body).toMatchObject({
      model: "plamo-3.0-prime-beta",
      max_tokens: 512,
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "こんにちは" },
      ],
      stream: true,
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        },
      ],
    });
    expect(request.body).not.toHaveProperty("stream_options");
    expect(request.body).not.toHaveProperty("store");
    expect(request.body).not.toHaveProperty("reasoning_effort");
    expect(
      (request.body.tools as Array<{ function?: { strict?: unknown } }> | undefined)?.[0]?.function,
    ).not.toHaveProperty("strict");
  });

  it("allows header-authenticated native transport requests without an explicit api key", async () => {
    const { provider, catalog } = await loadPlamoCatalog();

    let resolveRequest:
      | ((value: {
          headers: Record<string, string | string[] | undefined>;
          body: Record<string, unknown>;
        }) => void)
      | null = null;
    const requestSeen = new Promise<{
      headers: Record<string, string | string[] | undefined>;
      body: Record<string, unknown>;
    }>((resolve) => {
      resolveRequest = resolve;
    });

    const server = createServer((req, res) => {
      const chunks: string[] = [];
      req.setEncoding("utf8");
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        resolveRequest?.({
          headers: req.headers,
          body: JSON.parse(chunks.join("")) as Record<string, unknown>,
        });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-proxy-auth",
            choices: [{ index: 0, delta: { content: "ok" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-proxy-auth",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        headers: {
          "X-Proxy-Token": "proxy-token",
        },
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
      } as never,
      {} as never,
    );

    let result: Awaited<ReturnType<typeof stream.result>> | undefined;
    try {
      for await (const _event of stream) {
        // Drain the stream so the request completes.
      }
      result = await stream.result();
    } finally {
      server.close();
    }

    expect(result).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
    });

    const request = await requestSeen;
    expect(request.headers["x-proxy-token"]).toBe("proxy-token");
    expect(request.headers.authorization).toBeUndefined();
    expect(request.body).toMatchObject({
      model: "plamo-3.0-prime-beta",
      stream: true,
    });
  });

  it("keeps top-level auth headers while still injecting bearer auth when api key is available", async () => {
    const { provider, catalog } = await loadPlamoCatalog();

    let resolveRequest:
      | ((value: {
          headers: Record<string, string | string[] | undefined>;
          body: Record<string, unknown>;
        }) => void)
      | null = null;
    const requestSeen = new Promise<{
      headers: Record<string, string | string[] | undefined>;
      body: Record<string, unknown>;
    }>((resolve) => {
      resolveRequest = resolve;
    });

    const server = createServer((req, res) => {
      const chunks: string[] = [];
      req.setEncoding("utf8");
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        resolveRequest?.({
          headers: req.headers,
          body: JSON.parse(chunks.join("")) as Record<string, unknown>,
        });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-top-level-proxy-auth",
            choices: [{ index: 0, delta: { content: "ok" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-top-level-proxy-auth",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        headers: {
          "X-Proxy-Token": "proxy-token",
        },
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
      } as never,
      {
        apiKey: "test-key",
      } as never,
    );

    let result: Awaited<ReturnType<typeof stream.result>> | undefined;
    try {
      for await (const _event of stream) {
        // Drain the stream so the request completes.
      }
      result = await stream.result();
    } finally {
      server.close();
    }

    expect(result).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
    });

    const request = await requestSeen;
    expect(request.headers["x-proxy-token"]).toBe("proxy-token");
    expect(request.headers.authorization).toBe("Bearer test-key");
  });

  it("uses PLAMO_API_KEY for native transport requests when options.apiKey is absent", async () => {
    const { provider, catalog } = await loadPlamoCatalog();
    const previousApiKey = process.env.PLAMO_API_KEY;
    process.env.PLAMO_API_KEY = "env-test-key";

    let resolveRequest:
      | ((value: {
          headers: Record<string, string | string[] | undefined>;
          body: Record<string, unknown>;
        }) => void)
      | null = null;
    const requestSeen = new Promise<{
      headers: Record<string, string | string[] | undefined>;
      body: Record<string, unknown>;
    }>((resolve) => {
      resolveRequest = resolve;
    });

    const server = createServer((req, res) => {
      const chunks: string[] = [];
      req.setEncoding("utf8");
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        resolveRequest?.({
          headers: req.headers,
          body: JSON.parse(chunks.join("")) as Record<string, unknown>,
        });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-env-auth",
            choices: [{ index: 0, delta: { content: "ok" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-env-auth",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
      } as never,
      {} as never,
    );

    let result: Awaited<ReturnType<typeof stream.result>> | undefined;
    try {
      for await (const _event of stream) {
        // Drain the stream so the request completes.
      }
      result = await stream.result();
    } finally {
      server.close();
      if (previousApiKey === undefined) {
        delete process.env.PLAMO_API_KEY;
      } else {
        process.env.PLAMO_API_KEY = previousApiKey;
      }
    }

    expect(result).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
    });

    const request = await requestSeen;
    expect(request.headers.authorization).toBe("Bearer env-test-key");
    expect(request.body).toMatchObject({
      model: "plamo-3.0-prime-beta",
      stream: true,
    });
  });

  it("replaces blank authorization headers with bearer auth when an api key is available", async () => {
    const { provider, catalog } = await loadPlamoCatalog();

    let resolveRequest:
      | ((value: {
          headers: Record<string, string | string[] | undefined>;
          body: Record<string, unknown>;
        }) => void)
      | null = null;
    const requestSeen = new Promise<{
      headers: Record<string, string | string[] | undefined>;
      body: Record<string, unknown>;
    }>((resolve) => {
      resolveRequest = resolve;
    });

    const server = createServer((req, res) => {
      const chunks: string[] = [];
      req.setEncoding("utf8");
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        resolveRequest?.({
          headers: req.headers,
          body: JSON.parse(chunks.join("")) as Record<string, unknown>,
        });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-blank-auth-header",
            choices: [{ index: 0, delta: { content: "ok" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-blank-auth-header",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        headers: {
          Authorization: "   ",
        },
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
      } as never,
      {
        apiKey: "test-key",
      } as never,
    );

    let result: Awaited<ReturnType<typeof stream.result>> | undefined;
    try {
      for await (const _event of stream) {
        // Drain the stream so the request completes.
      }
      result = await stream.result();
    } finally {
      server.close();
    }

    expect(result).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
    });

    const request = await requestSeen;
    expect(request.headers.authorization).toBe("Bearer test-key");
    expect(request.body).toMatchObject({
      model: "plamo-3.0-prime-beta",
      stream: true,
    });
  });

  it("does not inject bearer auth when request auth overrides use a custom header", async () => {
    const { provider, catalog } = await loadPlamoCatalog();

    let resolveRequest:
      | ((value: {
          headers: Record<string, string | string[] | undefined>;
          body: Record<string, unknown>;
        }) => void)
      | null = null;
    const requestSeen = new Promise<{
      headers: Record<string, string | string[] | undefined>;
      body: Record<string, unknown>;
    }>((resolve) => {
      resolveRequest = resolve;
    });

    const server = createServer((req, res) => {
      const chunks: string[] = [];
      req.setEncoding("utf8");
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        resolveRequest?.({
          headers: req.headers,
          body: JSON.parse(chunks.join("")) as Record<string, unknown>,
        });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-proxy-auth-override",
            choices: [{ index: 0, delta: { content: "ok" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-proxy-auth-override",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      attachModelProviderRequestTransport(
        {
          ...model,
          provider: "plamo",
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          headers: {
            "X-Proxy-Token": "proxy-token",
          },
        },
        {
          auth: {
            mode: "header",
            headerName: "X-Proxy-Token",
            value: "proxy-token",
          },
        },
      ) as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
      } as never,
      {
        apiKey: "test-key",
      } as never,
    );

    let result: Awaited<ReturnType<typeof stream.result>> | undefined;
    try {
      for await (const _event of stream) {
        // Drain the stream so the request completes.
      }
      result = await stream.result();
    } finally {
      server.close();
    }

    expect(result).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
    });

    const request = await requestSeen;
    expect(request.headers["x-proxy-token"]).toBe("proxy-token");
    expect(request.headers.authorization).toBeUndefined();
    expect(request.body).toMatchObject({
      model: "plamo-3.0-prime-beta",
      stream: true,
    });
  });

  it("does not inject bearer auth for synthetic request-auth markers", async () => {
    const { provider, catalog } = await loadPlamoCatalog();
    const previousApiKey = process.env.PLAMO_API_KEY;
    process.env.PLAMO_API_KEY = "env-test-key";

    let resolveRequest:
      | ((value: {
          headers: Record<string, string | string[] | undefined>;
          body: Record<string, unknown>;
        }) => void)
      | null = null;
    const requestSeen = new Promise<{
      headers: Record<string, string | string[] | undefined>;
      body: Record<string, unknown>;
    }>((resolve) => {
      resolveRequest = resolve;
    });

    const server = createServer((req, res) => {
      const chunks: string[] = [];
      req.setEncoding("utf8");
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        resolveRequest?.({
          headers: req.headers,
          body: JSON.parse(chunks.join("")) as Record<string, unknown>,
        });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-synthetic-request-auth",
            choices: [{ index: 0, delta: { content: "ok" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-synthetic-request-auth",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        headers: {
          "X-Proxy-Token": "proxy-token",
        },
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
      } as never,
      {
        apiKey: PLAMO_REQUEST_AUTH_MARKER,
      } as never,
    );

    let result: Awaited<ReturnType<typeof stream.result>> | undefined;
    try {
      for await (const _event of stream) {
        // Drain the stream so the request completes.
      }
      result = await stream.result();
    } finally {
      server.close();
      if (previousApiKey === undefined) {
        delete process.env.PLAMO_API_KEY;
      } else {
        process.env.PLAMO_API_KEY = previousApiKey;
      }
    }

    expect(result).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
    });

    const request = await requestSeen;
    expect(request.headers["x-proxy-token"]).toBe("proxy-token");
    expect(request.headers.authorization).toBeUndefined();
  });

  it("normalizes zero-argument tool schemas on the native transport path", async () => {
    const { provider, catalog } = await loadPlamoCatalog();

    let resolveRequest: ((value: { body: Record<string, unknown> }) => void) | null = null;
    const requestSeen = new Promise<{
      body: Record<string, unknown>;
    }>((resolve) => {
      resolveRequest = resolve;
    });

    const server = createServer((req, res) => {
      const chunks: string[] = [];
      req.setEncoding("utf8");
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        resolveRequest?.({
          body: JSON.parse(chunks.join("")) as Record<string, unknown>,
        });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-stream-test",
            choices: [{ index: 0, delta: { content: "ok" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-stream-test",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
        tools: [
          {
            name: "ping",
            description: "No-arg tool",
            parameters: {},
          },
        ],
      } as never,
      {
        apiKey: "test-key",
      } as never,
    );

    try {
      for await (const _event of stream) {
        // Drain the stream so the request completes.
      }
      await stream.result();
    } finally {
      server.close();
    }

    const request = await requestSeen;
    expect(request.body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "ping",
          description: "No-arg tool",
          parameters: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      },
    ]);
  });

  it("uses PLaMo-safe compat defaults for uncataloged models without explicit compat", async () => {
    const { provider } = await loadPlamoCatalog();

    let resolveRequest: ((value: { body: Record<string, unknown> }) => void) | null = null;
    const requestSeen = new Promise<{
      body: Record<string, unknown>;
    }>((resolve) => {
      resolveRequest = resolve;
    });

    const server = createServer((req, res) => {
      const chunks: string[] = [];
      req.setEncoding("utf8");
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        resolveRequest?.({
          body: JSON.parse(chunks.join("")) as Record<string, unknown>,
        });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-stream-test",
            choices: [{ index: 0, delta: { content: "ok" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-stream-test",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const wrapped = createWrappedPlamoStream(provider, {
      modelId: "plamo-next-preview",
    });
    const stream = await wrapped(
      {
        provider: "plamo",
        api: "openai-completions",
        id: "plamo-next-preview",
        name: "PLaMo Next Preview",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 65_536,
        maxTokens: 1_024,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      } as never,
      {
        apiKey: "test-key",
        reasoningEffort: "high",
        onPayload: async (payload: unknown) => ({
          ...(payload as Record<string, unknown>),
          store: true,
          reasoning_effort: "high",
          stream_options: { include_usage: true },
        }),
      } as never,
    );

    try {
      for await (const _event of stream) {
        // Drain the stream so the request completes.
      }
      await stream.result();
    } finally {
      server.close();
    }

    const request = await requestSeen;
    expect(request.body).toMatchObject({
      model: "plamo-next-preview",
      max_tokens: 1_024,
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "こんにちは" },
      ],
      stream: true,
    });
    expect(request.body).not.toHaveProperty("max_completion_tokens");
    expect(request.body).not.toHaveProperty("store");
    expect(request.body).not.toHaveProperty("reasoning_effort");
    expect(request.body).not.toHaveProperty("stream_options");
    expect(
      (request.body.tools as Array<{ function?: { strict?: unknown } }> | undefined)?.[0]?.function,
    ).not.toHaveProperty("strict");
  });

  it("re-normalizes payload after mutation-style onPayload hooks that return undefined", async () => {
    const { provider } = await loadPlamoCatalog();

    let resolveRequest: ((value: { body: Record<string, unknown> }) => void) | null = null;
    const requestSeen = new Promise<{
      body: Record<string, unknown>;
    }>((resolve) => {
      resolveRequest = resolve;
    });

    const server = createServer((req, res) => {
      const chunks: string[] = [];
      req.setEncoding("utf8");
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        resolveRequest?.({
          body: JSON.parse(chunks.join("")) as Record<string, unknown>,
        });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-stream-test",
            choices: [{ index: 0, delta: { content: "ok" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-stream-test",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const wrapped = createWrappedPlamoStream(provider, {
      modelId: "plamo-next-preview",
    });
    const stream = await wrapped(
      {
        provider: "plamo",
        api: "openai-completions",
        id: "plamo-next-preview",
        name: "PLaMo Next Preview",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 65_536,
        maxTokens: 1_024,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      } as never,
      {
        apiKey: "test-key",
        reasoningEffort: "high",
        onPayload: async (payload: unknown) => {
          const payloadRecord = payload as Record<string, unknown>;
          payloadRecord.store = true;
          payloadRecord.reasoning_effort = "high";
          payloadRecord.stream_options = { include_usage: true };
          const tools = payloadRecord.tools as
            | Array<{ function?: Record<string, unknown> }>
            | undefined;
          if (tools?.[0]?.function) {
            tools[0].function.strict = true;
          }
          return undefined;
        },
      } as never,
    );

    try {
      for await (const _event of stream) {
        // Drain the stream so the request completes.
      }
      await stream.result();
    } finally {
      server.close();
    }

    const request = await requestSeen;
    expect(request.body).toMatchObject({
      model: "plamo-next-preview",
      max_tokens: 1_024,
      stream: true,
    });
    expect(request.body).not.toHaveProperty("max_completion_tokens");
    expect(request.body).not.toHaveProperty("store");
    expect(request.body).not.toHaveProperty("reasoning_effort");
    expect(request.body).not.toHaveProperty("stream_options");
    expect(
      (request.body.tools as Array<{ function?: { strict?: unknown } }> | undefined)?.[0]?.function,
    ).not.toHaveProperty("strict");
  });

  it("reassembles fragmented native SSE chunks without truncating the final text", async () => {
    const { provider, catalog } = await loadPlamoCatalog();

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });

      const writeFragmented = (text: string) => {
        for (let index = 0; index < text.length; index += 7) {
          res.write(text.slice(index, index + 7));
        }
      };
      const writeEvent = (event: Record<string, unknown>) => {
        writeFragmented(`data: ${JSON.stringify(event)}\n\n`);
      };

      writeEvent({
        id: "chatcmpl-stream-fragmented",
        choices: [{ index: 0, delta: { reasoning_content: "thinking " } }],
      });
      writeEvent({
        id: "chatcmpl-stream-fragmented",
        choices: [{ index: 0, delta: { content: "明日" } }],
      });
      writeEvent({
        id: "chatcmpl-stream-fragmented",
        choices: [{ index: 0, delta: { content: "は晴れ" } }],
      });
      writeEvent({
        id: "chatcmpl-stream-fragmented",
        choices: [{ index: 0, delta: { content: "です。" }, finish_reason: "stop" }],
      });
      writeEvent({
        id: "chatcmpl-stream-fragmented",
        usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
        choices: [],
      });
      writeFragmented("data: [DONE]\n\n");
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
      } as never,
      {
        apiKey: "test-key",
      } as never,
    );

    const deltas: string[] = [];
    let result: Awaited<ReturnType<typeof stream.result>> | undefined;
    try {
      for await (const event of stream) {
        if (event.type === "text_delta") {
          deltas.push(event.delta);
        }
      }
      result = await stream.result();
    } finally {
      server.close();
    }

    expect(deltas.join("")).toBe("明日は晴れです。");
    expect(result).toMatchObject({
      stopReason: "stop",
      usage: { input: 11, output: 5, totalTokens: 16 },
      content: [
        { type: "thinking", thinking: "thinking " },
        { type: "text", text: "明日は晴れです。" },
      ],
    });
  });

  it("clamps uncached prompt usage to zero when cached_tokens exceeds prompt_tokens", async () => {
    const { provider, catalog } = await loadPlamoCatalog();

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-stream-usage-clamp",
          choices: [{ index: 0, delta: { content: "ok" } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-stream-usage-clamp",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 2,
            completion_tokens: 5,
            total_tokens: 7,
            prompt_tokens_details: { cached_tokens: 4 },
          },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
      } as never,
      {
        apiKey: "test-key",
      } as never,
    );

    let result: Awaited<ReturnType<typeof stream.result>> | undefined;
    try {
      for await (const _event of stream) {
        // Drain the stream so the final usage is available.
      }
      result = await stream.result();
    } finally {
      server.close();
    }

    expect(result).toMatchObject({
      stopReason: "stop",
      usage: {
        input: 0,
        output: 5,
        cacheRead: 4,
        totalTokens: 9,
      },
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("does not double-count reasoning tokens in streamed usage", async () => {
    const { provider, catalog } = await loadPlamoCatalog();

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-stream-usage-reasoning",
          choices: [{ index: 0, delta: { content: "ok" } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-stream-usage-reasoning",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
            prompt_tokens_details: { cached_tokens: 3 },
            completion_tokens_details: { reasoning_tokens: 7 },
          },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
      } as never,
      {
        apiKey: "test-key",
      } as never,
    );

    let result: Awaited<ReturnType<typeof stream.result>> | undefined;
    try {
      for await (const _event of stream) {
        // Drain the stream so the final usage is available.
      }
      result = await stream.result();
    } finally {
      server.close();
    }

    expect(result).toMatchObject({
      stopReason: "stop",
      usage: {
        input: 7,
        output: 20,
        cacheRead: 3,
        totalTokens: 30,
      },
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("treats native SSE EOF without finish_reason as an error", async () => {
    const { provider, catalog } = await loadPlamoCatalog();

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-stream-truncated",
          choices: [{ index: 0, delta: { content: "partial" } }],
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
      } as never,
      {
        apiKey: "test-key",
      } as never,
    );

    const events: unknown[] = [];
    try {
      for await (const event of stream) {
        events.push(event);
      }
    } finally {
      server.close();
    }

    expect(events.some((event) => (event as { type?: unknown }).type === "done")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      error: expect.objectContaining({
        stopReason: "error",
        errorMessage: expect.stringContaining("finish_reason"),
      }),
    });
  });

  it("normalizes inline PLaMo tool markup in native stream results without synthetic toolcall events", async () => {
    const { provider, catalog } = await loadPlamoCatalog();
    const toolMarkup =
      "<|plamo:begin_tool_requests:plamo|>" +
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>read<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"README.md"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>" +
      "<|plamo:end_tool_requests:plamo|>";

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-tool",
          choices: [{ index: 0, delta: { content: `I will inspect the file.\n${toolMarkup}` } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-tool",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
      } as never,
      {
        apiKey: "test-key",
      } as never,
    );

    const eventTypes: string[] = [];
    let result: Awaited<ReturnType<typeof stream.result>> | undefined;
    try {
      for await (const event of stream) {
        eventTypes.push(event.type);
      }
      result = await stream.result();
    } finally {
      server.close();
    }

    expect(eventTypes).not.toContain("toolcall_start");
    expect(eventTypes).not.toContain("toolcall_delta");
    expect(eventTypes).not.toContain("toolcall_end");
    expect(result).toMatchObject({
      stopReason: "toolUse",
      content: [
        {
          type: "text",
          text: "I will inspect the file.",
        },
        {
          type: "toolCall",
          name: "read",
          arguments: { path: "README.md" },
        },
      ],
    });
  });

  it("preserves later native text deltas after inline tool markup closes mid-stream", async () => {
    const { provider, catalog } = await loadPlamoCatalog();
    const toolMarkup =
      "<|plamo:begin_tool_requests:plamo|>" +
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>read<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"README.md"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>" +
      "<|plamo:end_tool_requests:plamo|>";
    const splitToolMarkupIndex = 5;

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-tool-midstream",
          choices: [
            {
              index: 0,
              delta: { content: `Checking...${toolMarkup.slice(0, splitToolMarkupIndex)}` },
            },
          ],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-tool-midstream",
          choices: [
            {
              index: 0,
              delta: { content: toolMarkup.slice(splitToolMarkupIndex) },
            },
          ],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-tool-midstream",
          choices: [{ index: 0, delta: { content: " Done." } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-tool-midstream",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
      } as never,
      {
        apiKey: "test-key",
      } as never,
    );

    const textDeltas: string[] = [];
    let result: Awaited<ReturnType<typeof stream.result>> | undefined;
    try {
      for await (const event of stream) {
        if (event.type === "text_delta") {
          textDeltas.push(event.delta);
        }
      }
      result = await stream.result();
    } finally {
      server.close();
    }

    expect(textDeltas.join("")).toBe("Checking... Done.");
    expect(textDeltas.some((delta) => delta.includes("<|plamo:"))).toBe(false);
    expect(result).toMatchObject({
      stopReason: "toolUse",
      content: [
        {
          type: "text",
          text: "Checking...",
        },
        {
          type: "toolCall",
          name: "read",
          arguments: { path: "README.md" },
        },
        {
          type: "text",
          text: "Done.",
        },
      ],
    });
  });

  it("preserves trailing plain-text markup prefixes on the final native stream flush", async () => {
    const { provider, catalog } = await loadPlamoCatalog();

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-trailing-prefix",
          choices: [{ index: 0, delta: { content: "Ends with <|" } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-trailing-prefix",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "Return a literal suffix." }],
      } as never,
      {
        apiKey: "test-key",
      } as never,
    );

    let result: Awaited<ReturnType<typeof stream.result>> | undefined;
    try {
      for await (const _event of stream) {
        // Drain the stream so the final message is assembled.
      }
      result = await stream.result();
    } finally {
      server.close();
    }

    expect(result).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "Ends with <|" }],
    });
  });

  it("strips parser-only fields from native partial stream snapshots", async () => {
    const { provider, catalog } = await loadPlamoCatalog();

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-native-partials",
          choices: [{ index: 0, delta: { content: "Checking..." } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-native-partials",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { name: "read", arguments: '{"path":"README' },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-native-partials",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '.md"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
      } as never,
      {
        apiKey: "test-key",
      } as never,
    );

    const events: Array<Record<string, unknown>> = [];
    let result: Awaited<ReturnType<typeof stream.result>> | undefined;
    try {
      for await (const event of stream) {
        events.push(event as Record<string, unknown>);
      }
      result = await stream.result();
    } finally {
      server.close();
    }

    const textStartEvent = events.find((event) => event.type === "text_start");
    expect(textStartEvent).toMatchObject({
      partial: {
        content: expect.arrayContaining([{ type: "text", text: "Checking..." }]),
      },
    });
    expect(
      (
        textStartEvent as {
          partial?: {
            content?: Array<Record<string, unknown>>;
          };
        }
      ).partial?.content?.[0],
    ).not.toHaveProperty("rawText");
    expect(
      (
        textStartEvent as {
          partial?: {
            content?: Array<Record<string, unknown>>;
          };
        }
      ).partial?.content?.[0],
    ).not.toHaveProperty("streamStarted");

    const toolCallDeltaEvent = events.find((event) => event.type === "toolcall_delta");
    expect(toolCallDeltaEvent).toMatchObject({
      partial: {
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "toolCall",
            name: "read",
            arguments: {},
          }),
        ]),
      },
    });
    const streamedToolCallBlock = (
      (
        toolCallDeltaEvent as {
          partial?: {
            content?: Array<Record<string, unknown>>;
          };
        }
      ).partial?.content ?? []
    ).find((block) => block.type === "toolCall");
    expect(streamedToolCallBlock).not.toHaveProperty("partialArgs");

    expect(result).toMatchObject({
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Checking..." },
        { type: "toolCall", name: "read", arguments: { path: "README.md" } },
      ],
    });
  });

  it("splits interleaved tool-call deltas by index when ids are omitted", async () => {
    const { provider, catalog } = await loadPlamoCatalog();

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-tool-indexed",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { name: "read", arguments: '{"path":"README' },
                  },
                  {
                    index: 1,
                    function: { name: "write", arguments: '{"path":"notes.txt","content":"he' },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-tool-indexed",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '.md"}' },
                  },
                  {
                    index: 1,
                    function: { arguments: 'llo"}' },
                  },
                ],
                content: "",
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
      } as never,
      {
        apiKey: "test-key",
      } as never,
    );

    let result: Awaited<ReturnType<typeof stream.result>> | undefined;
    try {
      for await (const _event of stream) {
        // Drain the stream so the final message is assembled.
      }
      result = await stream.result();
    } finally {
      server.close();
    }

    expect(result).toMatchObject({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          name: "read",
          arguments: { path: "README.md" },
        },
        {
          type: "toolCall",
          name: "write",
          arguments: { path: "notes.txt", content: "hello" },
        },
      ],
    });
  });

  it("normalizes inline PLaMo tool markup into cloned wrapped-stream snapshots", async () => {
    const toolMarkup =
      "<|plamo:begin_tool_requests:plamo|>" +
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>read<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"README.md"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>" +
      "<|plamo:end_tool_requests:plamo|>";
    const partialMessage = {
      role: "assistant",
      content: [{ type: "text", text: `Checking...${toolMarkup}` }],
    };
    const streamedMessage = {
      role: "assistant",
      content: [{ type: "text", text: `Reading now.${toolMarkup}` }],
    };
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: `I will inspect the file.\n${toolMarkup}` }],
    };

    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [{ partial: partialMessage, message: streamedMessage }],
        resultMessage: finalMessage,
      }),
    );

    const wrapped = createPlamoToolCallWrapper(baseFn as never);

    const stream = await wrapped(
      {
        api: "openai-completions",
        provider: "plamo",
        id: "plamo-3.0-prime-beta",
      } as never,
      { messages: [] } as never,
      {} as never,
    );

    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    const result = await stream.result();
    const wrappedToolCallId = (
      (
        events[0] as {
          partial?: { content?: Array<{ type?: string; id?: string }> };
          message?: { content?: Array<{ type?: string; id?: string }> };
        }
      ).message?.content ?? []
    ).find((block) => block.type === "toolCall")?.id;
    const partialToolCallId = (
      (
        events[0] as {
          partial?: { content?: Array<{ type?: string; id?: string }> };
        }
      ).partial?.content ?? []
    ).find((block) => block.type === "toolCall")?.id;
    const resultToolCallId = (
      (result as { content?: Array<{ type?: string; id?: string }> }).content ?? []
    ).find((block) => block.type === "toolCall")?.id;

    expect(baseFn).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        partial: expect.objectContaining({
          content: [
            { type: "text", text: "Checking..." },
            expect.objectContaining({
              type: "toolCall",
              name: "read",
              arguments: { path: "README.md" },
            }),
          ],
          stopReason: "toolUse",
        }),
        message: expect.objectContaining({
          content: [
            { type: "text", text: "Reading now." },
            expect.objectContaining({
              type: "toolCall",
              name: "read",
              arguments: { path: "README.md" },
            }),
          ],
          stopReason: "toolUse",
        }),
      }),
    );
    expect(partialMessage.content).toEqual([{ type: "text", text: `Checking...${toolMarkup}` }]);
    expect(streamedMessage.content).toEqual([{ type: "text", text: `Reading now.${toolMarkup}` }]);
    expect(finalMessage.content).toEqual([
      { type: "text", text: `I will inspect the file.\n${toolMarkup}` },
    ]);
    expect(finalMessage).toMatchObject({ role: "assistant" });
    expect(result).toEqual({
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "I will inspect the file." },
        expect.objectContaining({
          type: "toolCall",
          name: "read",
          arguments: { path: "README.md" },
        }),
      ],
    });
    expect(partialToolCallId).toBeTypeOf("string");
    expect(wrappedToolCallId).toBe(partialToolCallId);
    expect(resultToolCallId).toBe(partialToolCallId);
    expect(result).not.toBe(finalMessage);
  });

  it("keeps done reason synchronized with normalized tool-use stopReason on wrapped streams", async () => {
    const toolMarkup =
      "<|plamo:begin_tool_requests:plamo|>" +
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>read<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"README.md"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>" +
      "<|plamo:end_tool_requests:plamo|>";
    const doneMessage = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: `I will inspect the file.\n${toolMarkup}` }],
    };

    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [{ type: "done", reason: "stop", message: doneMessage }],
        resultMessage: doneMessage,
      }),
    );

    const wrapped = createPlamoToolCallWrapper(baseFn as never);

    const stream = await wrapped(
      {
        api: "openai-completions",
        provider: "plamo",
        id: "plamo-3.0-prime-beta",
      } as never,
      { messages: [] } as never,
      {} as never,
    );

    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    const result = await stream.result();

    expect(baseFn).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "done",
        reason: "toolUse",
        message: expect.objectContaining({
          stopReason: "toolUse",
          content: [
            { type: "text", text: "I will inspect the file." },
            expect.objectContaining({
              type: "toolCall",
              name: "read",
              arguments: { path: "README.md" },
            }),
          ],
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        stopReason: "toolUse",
        content: [
          { type: "text", text: "I will inspect the file." },
          expect.objectContaining({
            type: "toolCall",
            name: "read",
            arguments: { path: "README.md" },
          }),
        ],
      }),
    );
    expect(result).not.toBe(doneMessage);
    expect(doneMessage).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: `I will inspect the file.\n${toolMarkup}` }],
    });
  });

  it("preserves later text deltas after wrapped-stream inline tool normalization", async () => {
    const toolMarkup =
      "<|plamo:begin_tool_requests:plamo|>" +
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>read<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"README.md"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>" +
      "<|plamo:end_tool_requests:plamo|>";
    const liveMessage = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: `Checking...${toolMarkup}` }],
    };

    const baseFn = vi.fn(() => ({
      async result() {
        return liveMessage;
      },
      [Symbol.asyncIterator]() {
        let step = 0;
        return {
          async next() {
            if (step === 0) {
              step += 1;
              return { done: false as const, value: { partial: liveMessage } };
            }
            if (step === 1) {
              const firstBlock = liveMessage.content[0];
              if (!firstBlock || typeof firstBlock !== "object" || firstBlock.type !== "text") {
                throw new Error("expected live wrapped stream to keep a text block");
              }
              firstBlock.text += " Done.";
              step += 1;
              return {
                done: false as const,
                value: { type: "done", reason: "stop", message: liveMessage },
              };
            }
            return { done: true as const, value: undefined };
          },
          async return(value?: unknown) {
            return { done: true as const, value };
          },
          async throw(error?: unknown) {
            throw error;
          },
        };
      },
    }));

    const wrapped = createPlamoToolCallWrapper(baseFn as never);
    const stream = await wrapped(
      {
        api: "openai-completions",
        provider: "plamo",
        id: "plamo-3.0-prime-beta",
      } as never,
      { messages: [] } as never,
      {} as never,
    );

    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    const result = await stream.result();

    expect(baseFn).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      expect.objectContaining({
        partial: expect.objectContaining({
          stopReason: "toolUse",
          content: [
            { type: "text", text: "Checking..." },
            expect.objectContaining({
              type: "toolCall",
              name: "read",
              arguments: { path: "README.md" },
            }),
          ],
        }),
      }),
      expect.objectContaining({
        type: "done",
        reason: "toolUse",
        message: expect.objectContaining({
          stopReason: "toolUse",
          content: [
            { type: "text", text: "Checking..." },
            expect.objectContaining({
              type: "toolCall",
              name: "read",
              arguments: { path: "README.md" },
            }),
            { type: "text", text: "Done." },
          ],
        }),
      }),
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        stopReason: "toolUse",
        content: [
          { type: "text", text: "Checking..." },
          expect.objectContaining({
            type: "toolCall",
            name: "read",
            arguments: { path: "README.md" },
          }),
          { type: "text", text: "Done." },
        ],
      }),
    );
    expect(liveMessage).toEqual({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: `Checking...${toolMarkup} Done.` }],
    });
  });

  it("treats toolUse and functionCall blocks as prior tool history on the native transport path", async () => {
    const { provider, catalog } = await loadPlamoCatalog();
    let capturedPayload: Record<string, unknown> | undefined;
    fetchWithSsrFGuardMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        init?: RequestInit;
      };
      const requestBody = params.init?.body;
      if (typeof requestBody !== "string") {
        throw new Error("expected native PLaMo transport to send a string request body");
      }
      capturedPayload = JSON.parse(requestBody) as Record<string, unknown>;
      return {
        response: new Response(
          [
            `data: ${JSON.stringify({
              id: "chatcmpl-tool-history",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })}`,
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          },
        ),
        release: async () => {},
      };
    });

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: "https://api.platform.preferredai.jp/v1",
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "toolUse", id: "call_1", name: "read", input: { path: "README.md" } },
              { type: "functionCall", id: "call_2", name: "exec", arguments: { cmd: "pwd" } },
            ],
          },
        ],
      } as never,
      {
        apiKey: "test-key",
      } as never,
    );

    for await (const _event of stream) {
      // Drain the stream so the request completes.
    }
    await stream.result();

    expect(capturedPayload).toMatchObject({
      model: "plamo-3.0-prime-beta",
      stream: true,
      max_tokens: 20_000,
      tools: [],
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "read",
                arguments: '{"path":"README.md"}',
              },
            },
            {
              id: "call_2",
              type: "function",
              function: {
                name: "exec",
                arguments: '{"cmd":"pwd"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "No result provided",
        },
        {
          role: "tool",
          tool_call_id: "call_2",
          content: "No result provided",
        },
      ],
    });
  });

  it("keeps replayed assistant tool calls ahead of tool results on the native transport path", async () => {
    const { provider, catalog } = await loadPlamoCatalog();
    let capturedPayload: Record<string, unknown> | undefined;
    fetchWithSsrFGuardMock.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        init?: RequestInit;
      };
      const requestBody = params.init?.body;
      if (typeof requestBody !== "string") {
        throw new Error("expected native PLaMo transport to send a string request body");
      }
      capturedPayload = JSON.parse(requestBody) as Record<string, unknown>;
      return {
        response: new Response(
          [
            `data: ${JSON.stringify({
              id: "chatcmpl-tool-result-history",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })}`,
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          },
        ),
        release: async () => {},
      };
    });

    const [model] = catalog.provider.models;
    const wrapped = createWrappedPlamoStream(provider);
    const stream = await wrapped(
      {
        ...model,
        provider: "plamo",
        api: "openai-completions",
        baseUrl: "https://api.platform.preferredai.jp/v1",
      } as never,
      {
        systemPrompt: "system prompt",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "toolUse", id: "call_1", name: "read", input: { path: "README.md" } },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read",
            content: [{ type: "text", text: "README contents here" }],
          },
          { role: "user", content: "Continue from the tool result in one sentence." },
        ],
      } as never,
      {
        apiKey: "test-key",
      } as never,
    );

    for await (const _event of stream) {
      // Drain the stream so the request completes.
    }
    await stream.result();

    expect(capturedPayload).toMatchObject({
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "read",
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "README contents here",
        },
        {
          role: "user",
          content: "Continue from the tool result in one sentence.",
        },
      ],
      tools: [],
    });
  });

  it("parses tool calls from every tool_requests wrapper in assistant text", () => {
    const firstToolMarkup =
      "<|plamo:begin_tool_requests:plamo|>" +
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>read<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"README.md"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>" +
      "<|plamo:end_tool_requests:plamo|>";
    const secondToolMarkup =
      "<|plamo:begin_tool_requests:plamo|>" +
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>write<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"notes.txt","content":"ok"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>" +
      "<|plamo:end_tool_requests:plamo|>";

    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: `${firstToolMarkup}${secondToolMarkup}` }],
    };

    normalizePlamoToolMarkupInMessage(message);

    expect(message).toMatchObject({
      stopReason: "toolUse",
      content: [
        { type: "toolCall", name: "read", arguments: { path: "README.md" } },
        {
          type: "toolCall",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
      ],
    });
  });

  it("parses standalone tool_request blocks even when wrapped tool_requests blocks are present", () => {
    const wrappedToolMarkup =
      "<|plamo:begin_tool_requests:plamo|>" +
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>read<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"README.md"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>" +
      "<|plamo:end_tool_requests:plamo|>";
    const standaloneToolMarkup =
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>write<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"notes.txt","content":"ok"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>";

    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: `${wrappedToolMarkup}${standaloneToolMarkup}` }],
    };

    normalizePlamoToolMarkupInMessage(message);

    expect(message).toMatchObject({
      stopReason: "toolUse",
      content: [
        { type: "toolCall", name: "read", arguments: { path: "README.md" } },
        {
          type: "toolCall",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
      ],
    });
  });

  it("keeps existing toolCall blocks and adds extra inline-only tool calls", () => {
    const inlineToolMarkup =
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>write<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"notes.txt","content":"ok"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>";

    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "text", text: `Checking...${inlineToolMarkup}` },
        {
          type: "toolCall",
          id: "existing_call",
          name: "read",
          arguments: { path: "README.md" },
        },
      ],
    };

    normalizePlamoToolMarkupInMessage(message);

    expect(message).toMatchObject({
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Checking..." },
        {
          type: "toolCall",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
        {
          type: "toolCall",
          id: "existing_call",
          name: "read",
          arguments: { path: "README.md" },
        },
      ],
    });
  });

  it("deduplicates inline tool calls even when argument key order differs", () => {
    const inlineToolMarkup =
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>write<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"content":"ok","path":"notes.txt"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>";

    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "text", text: `Checking...${inlineToolMarkup}` },
        {
          type: "toolCall",
          id: "existing_call",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
      ],
    };

    normalizePlamoToolMarkupInMessage(message);

    expect(message).toMatchObject({
      stopReason: "stop",
      content: [
        { type: "text", text: "Checking..." },
        {
          type: "toolCall",
          id: "existing_call",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
      ],
    });
  });

  it("deduplicates inline tool markup against existing toolUse and functionCall blocks", () => {
    const inlineToolMarkup =
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>write<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"notes.txt","content":"ok"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>";

    const toolUseMessage = {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "text", text: `Checking...${inlineToolMarkup}` },
        {
          type: "toolUse",
          id: "existing_tool_use",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
      ],
    };
    normalizePlamoToolMarkupInMessage(toolUseMessage);
    expect(toolUseMessage).toMatchObject({
      stopReason: "stop",
      content: [
        { type: "text", text: "Checking..." },
        {
          type: "toolUse",
          id: "existing_tool_use",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
      ],
    });

    const functionCallMessage = {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "text", text: `Checking...${inlineToolMarkup}` },
        {
          type: "functionCall",
          id: "existing_function_call",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
      ],
    };
    normalizePlamoToolMarkupInMessage(functionCallMessage);
    expect(functionCallMessage).toMatchObject({
      stopReason: "stop",
      content: [
        { type: "text", text: "Checking..." },
        {
          type: "functionCall",
          id: "existing_function_call",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
      ],
    });

    const toolUseInputMessage = {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "text", text: `Checking...${inlineToolMarkup}` },
        {
          type: "toolUse",
          id: "existing_tool_use_input",
          name: "write",
          input: { path: "notes.txt", content: "ok" },
        },
      ],
    };
    normalizePlamoToolMarkupInMessage(toolUseInputMessage);
    expect(toolUseInputMessage).toMatchObject({
      stopReason: "stop",
      content: [
        { type: "text", text: "Checking..." },
        {
          type: "toolUse",
          id: "existing_tool_use_input",
          name: "write",
          input: { path: "notes.txt", content: "ok" },
        },
      ],
    });
  });

  it("preserves later inline tool markup when the same structured tool call already appeared", () => {
    const inlineToolMarkup =
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>write<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"notes.txt","content":"ok"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>";

    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [
        {
          type: "toolCall",
          id: "existing_call",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
        { type: "text", text: `Checking again...${inlineToolMarkup}` },
      ],
    };

    normalizePlamoToolMarkupInMessage(message);

    expect(message).toMatchObject({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "existing_call",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
        { type: "text", text: "Checking again..." },
        {
          type: "toolCall",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
      ],
    });
    expect((message.content[2] as { id?: unknown }).id).toBeTypeOf("string");
    expect((message.content[2] as { id?: unknown }).id).not.toBe("existing_call");
  });

  it("preserves multiple text blocks around non-text blocks when normalizing inline tool markup", () => {
    const inlineToolMarkup =
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>write<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"notes.txt","content":"ok"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>";

    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "text", text: "Before" },
        {
          type: "toolCall",
          id: "existing_call",
          name: "read",
          arguments: { path: "README.md" },
        },
        { type: "text", text: `After${inlineToolMarkup}` },
      ],
    };

    normalizePlamoToolMarkupInMessage(message);

    expect(message).toMatchObject({
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Before" },
        {
          type: "toolCall",
          id: "existing_call",
          name: "read",
          arguments: { path: "README.md" },
        },
        { type: "text", text: "After" },
        {
          type: "toolCall",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
      ],
    });
  });

  it("preserves surrounding whitespace in text blocks when removing inline tool markup", () => {
    const inlineToolMarkup =
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>write<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"notes.txt","content":"ok"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>";

    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "text", text: "Before " },
        { type: "text", text: inlineToolMarkup },
        { type: "text", text: " after" },
      ],
    };

    normalizePlamoToolMarkupInMessage(message);

    expect(message).toMatchObject({
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Before" },
        {
          type: "toolCall",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
        { type: "text", text: "after" },
      ],
    });
  });

  it("removes split inline tool markup from continuation text blocks", () => {
    const splitInlineToolMarkup = [
      "<|plamo:begin_tool_request:plamo|>" +
        "<|plamo:begin_tool_name:plamo|>write<|plamo:end_tool_name:plamo|>" +
        '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"notes.txt"',
      ',"content":"ok"}<|plamo:end_tool_arguments:plamo|><|plamo:end_tool_request:plamo|>',
    ] as const;

    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "text", text: `Before ${splitInlineToolMarkup[0]}` },
        { type: "text", text: `${splitInlineToolMarkup[1]} after` },
      ],
    };

    normalizePlamoToolMarkupInMessage(message);

    expect(message).toMatchObject({
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Before" },
        {
          type: "toolCall",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
        { type: "text", text: "after" },
      ],
    });
  });

  it("preserves non-stop terminal reasons when inline tool markup is normalized", () => {
    const inlineToolMarkup =
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>write<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"notes.txt","content":"ok"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>";

    const message = {
      role: "assistant",
      stopReason: "length",
      content: [{ type: "text", text: `Checking...${inlineToolMarkup}` }],
    };

    normalizePlamoToolMarkupInMessage(message);

    expect(message).toMatchObject({
      stopReason: "length",
      content: [
        { type: "text", text: "Checking..." },
        {
          type: "toolCall",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
      ],
    });
  });

  it("preserves malformed inline tool requests while normalizing valid ones", () => {
    const validToolMarkup =
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>read<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"README.md"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>";
    const invalidToolMarkup =
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>write<|plamo:end_tool_name:plamo|>" +
      "<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>not-json" +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>";

    const message = {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        {
          type: "text",
          text: `before ${validToolMarkup} middle ${invalidToolMarkup} after`,
        },
      ],
    };

    normalizePlamoToolMarkupInMessage(message);

    expect(message).toMatchObject({
      stopReason: "toolUse",
      content: [
        {
          type: "text",
          text: "before",
        },
        {
          type: "toolCall",
          name: "read",
          arguments: { path: "README.md" },
        },
        {
          type: "text",
          text: `middle ${invalidToolMarkup} after`,
        },
      ],
    });
  });

  it("parses inline tool arguments when PLAMO_MSG appears inside a JSON string", () => {
    const inlineToolMarkup =
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>write<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|>{"path":"notes.txt","content":"literal <|plamo:msg|> token"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>";

    const message = {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "text", text: `before ${inlineToolMarkup} after` }],
    };

    normalizePlamoToolMarkupInMessage(message);

    expect(message).toMatchObject({
      stopReason: "toolUse",
      content: [
        { type: "text", text: "before" },
        {
          type: "toolCall",
          name: "write",
          arguments: {
            path: "notes.txt",
            content: "literal <|plamo:msg|> token",
          },
        },
        { type: "text", text: "after" },
      ],
    });
  });

  it("keeps synthesized inline tool-call ids stable across cloned normalization passes", () => {
    const inlineToolMarkup =
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>write<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"notes.txt","content":"ok"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>";

    const firstMessage = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: `Checking...${inlineToolMarkup}` }],
    };
    const secondMessage = structuredClone(firstMessage);

    normalizePlamoToolMarkupInMessage(firstMessage);
    normalizePlamoToolMarkupInMessage(secondMessage);

    const firstToolCallId = (firstMessage.content as Array<{ type?: string; id?: string }>).find(
      (block) => block.type === "toolCall",
    )?.id;
    const secondToolCallId = (secondMessage.content as Array<{ type?: string; id?: string }>).find(
      (block) => block.type === "toolCall",
    )?.id;

    expect(firstToolCallId).toBeTypeOf("string");
    expect(secondToolCallId).toBe(firstToolCallId);
  });

  it("generates different synthetic tool-call ids for identical inline calls in later assistant turns", () => {
    const inlineToolMarkup =
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>write<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"notes.txt","content":"ok"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>";

    const firstMessage = {
      role: "assistant",
      stopReason: "stop",
      timestamp: 1_700_000_000_000,
      content: [{ type: "text", text: `Checking...${inlineToolMarkup}` }],
    };
    const secondMessage = {
      role: "assistant",
      stopReason: "stop",
      timestamp: 1_700_000_000_001,
      content: [{ type: "text", text: `Checking...${inlineToolMarkup}` }],
    };

    normalizePlamoToolMarkupInMessage(firstMessage);
    normalizePlamoToolMarkupInMessage(secondMessage);

    const firstToolCallId = (firstMessage.content as Array<{ type?: string; id?: string }>).find(
      (block) => block.type === "toolCall",
    )?.id;
    const secondToolCallId = (secondMessage.content as Array<{ type?: string; id?: string }>).find(
      (block) => block.type === "toolCall",
    )?.id;

    expect(firstToolCallId).toBeTypeOf("string");
    expect(secondToolCallId).toBeTypeOf("string");
    expect(secondToolCallId).not.toBe(firstToolCallId);
  });

  it("preserves raw inline tool markup when no valid tool-call blocks are produced", () => {
    const message = {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        {
          type: "text",
          text:
            "<|plamo:begin_tool_request:plamo|>" +
            "<|plamo:begin_tool_name:plamo|>write<|plamo:end_tool_name:plamo|>" +
            "<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>not-json" +
            "<|plamo:end_tool_arguments:plamo|>" +
            "<|plamo:end_tool_request:plamo|>",
        },
      ],
    };

    normalizePlamoToolMarkupInMessage(message);

    expect(message).toMatchObject({
      stopReason: "toolUse",
      content: [
        {
          type: "text",
          text:
            "<|plamo:begin_tool_request:plamo|>" +
            "<|plamo:begin_tool_name:plamo|>write<|plamo:end_tool_name:plamo|>" +
            "<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>not-json" +
            "<|plamo:end_tool_arguments:plamo|>" +
            "<|plamo:end_tool_request:plamo|>",
        },
      ],
    });
  });
});
