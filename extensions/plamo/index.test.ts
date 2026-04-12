import { once } from "node:events";
import { createServer } from "node:http";
import { streamSimple } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-wizard.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plamoPlugin from "./index.js";
import { normalizePlamoToolMarkupInMessage } from "./stream.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: (params: unknown) => fetchWithSsrFGuardMock(params),
}));

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
    extraParams?: Record<string, unknown>;
    modelId?: string;
  },
) {
  const wrapped = provider.wrapStreamFn?.({
    provider: "plamo",
    modelId: options?.modelId ?? "plamo-3.0-prime-beta",
    streamFn: streamSimple as never,
    extraParams: options?.extraParams ?? {},
  } as never);
  if (!wrapped) {
    throw new Error("expected wrapped stream function");
  }
  return wrapped;
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
    expect(provider.capabilities).toMatchObject({
      dropThinkingBlockModelHints: ["plamo"],
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("plamo");
    expect(resolved?.method.id).toBe("api-key");
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

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-tool-midstream",
          choices: [{ index: 0, delta: { content: `Checking...${toolMarkup}` } }],
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
          type: "text",
          text: "Checking... Done.",
        },
        {
          type: "toolCall",
          name: "read",
          arguments: { path: "README.md" },
        },
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

  it("defaults to native streaming and normalizes inline PLaMo tool markup into tool calls", async () => {
    const provider = await registerSingleProviderPlugin(plamoPlugin);
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

    const wrapped = provider.wrapStreamFn?.({
      provider: "plamo",
      modelId: "plamo-3.0-prime-beta",
      streamFn: baseFn as never,
      extraParams: {},
    } as never);
    if (!wrapped) {
      throw new Error("expected wrapped stream function");
    }

    const stream = await wrapped(
      {
        api: "openai-completions",
        provider: "plamo",
        id: "plamo-3.0-prime-beta",
      } as never,
      { messages: [] } as never,
      {} as never,
    );

    for await (const _event of stream) {
      // Drain the wrapped stream so live partial mutations run.
    }
    const result = await stream.result();

    expect(baseFn).toHaveBeenCalledTimes(1);
    expect(partialMessage.content).toMatchObject([
      { type: "text", text: "Checking..." },
      { type: "toolCall", name: "read", arguments: { path: "README.md" } },
    ]);
    expect(streamedMessage.content).toMatchObject([
      { type: "text", text: "Reading now." },
      { type: "toolCall", name: "read", arguments: { path: "README.md" } },
    ]);
    expect(finalMessage.content).toMatchObject([
      { type: "text", text: "I will inspect the file." },
      { type: "toolCall", name: "read", arguments: { path: "README.md" } },
    ]);
    expect(finalMessage).toMatchObject({ stopReason: "toolUse" });
    expect(result).toBe(finalMessage);
  });

  it("keeps done reason synchronized with normalized tool-use stopReason on wrapped streams", async () => {
    const provider = await registerSingleProviderPlugin(plamoPlugin);
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

    const wrapped = provider.wrapStreamFn?.({
      provider: "plamo",
      modelId: "plamo-3.0-prime-beta",
      streamFn: baseFn as never,
      extraParams: {},
    } as never);
    if (!wrapped) {
      throw new Error("expected wrapped stream function");
    }

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
    expect(result).toBe(doneMessage);
    expect(doneMessage).toMatchObject({ stopReason: "toolUse" });
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
          id: "existing_call",
          name: "read",
          arguments: { path: "README.md" },
        },
        {
          type: "toolCall",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
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
        { type: "text", text: "Before " },
        { type: "text", text: " after" },
        {
          type: "toolCall",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
      ],
    });
  });

  it("removes split inline tool markup from continuation text blocks", () => {
    const splitInlineToolMarkup = [
      "<|plamo:begin_tool_request:plamo|>" +
        "<|plamo:begin_tool_name:plamo|>write<|plamo:end_tool_name:plamo|>" +
        '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"notes.txt"',
      ',"content":"ok"}<|plamo:end_tool_arguments:plamo|>' + "<|plamo:end_tool_request:plamo|>",
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
        { type: "text", text: "Before " },
        { type: "text", text: " after" },
        {
          type: "toolCall",
          name: "write",
          arguments: { path: "notes.txt", content: "ok" },
        },
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

  it("resets toolUse stop reason when no tool-call blocks are produced", () => {
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
      stopReason: "stop",
      content: [],
    });
  });
});
