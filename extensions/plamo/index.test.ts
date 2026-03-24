import { once } from "node:events";
import { createServer } from "node:http";
import { streamSimple } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-wizard.js";
import { registerSingleProviderPlugin } from "../../test/helpers/extensions/plugin-registration.js";
import plamoPlugin from "./index.js";

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
  const provider = registerSingleProviderPlugin(plamoPlugin);
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
  provider: ReturnType<typeof registerSingleProviderPlugin>,
  extraParams?: Record<string, unknown>,
) {
  const wrapped = provider.wrapStreamFn?.({
    provider: "plamo",
    modelId: "plamo-3.0-prime-beta",
    streamFn: streamSimple as never,
    extraParams: extraParams ?? {},
  } as never);
  if (!wrapped) {
    throw new Error("expected wrapped stream function");
  }
  return wrapped;
}

describe("plamo provider plugin", () => {
  it("registers PLaMo with api-key auth wizard metadata", () => {
    const provider = registerSingleProviderPlugin(plamoPlugin);
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
    expect(catalog.provider.models).toMatchObject([
      {
        id: "plamo-3.0-prime-beta",
        reasoning: false,
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

  it("repackages non-stream completions with reasoning_content into assistant events", async () => {
    const { provider, catalog } = await loadPlamoCatalog();

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          model: "plamo-3.0-prime-beta",
          choices: [
            {
              message: {
                role: "assistant",
                reasoning_content: "内部で考えています。",
                content: "最終回答です。",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 2,
            total_tokens: 3,
          },
        }),
      );
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

    expect(eventTypes).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(result).toMatchObject({
      role: "assistant",
      stopReason: "stop",
      content: [
        {
          type: "thinking",
          thinking: "内部で考えています。",
          thinkingSignature: "reasoning_content",
        },
        {
          type: "text",
          text: "最終回答です。",
        },
      ],
    });
  });

  it("builds PLaMo-compatible non-stream payloads that match the documented request shape", async () => {
    const { provider, catalog } = await loadPlamoCatalog();

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          model: "plamo-3.0-prime-beta",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    let payload: Record<string, unknown> | undefined;
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
        reasoning: "low",
        onPayload: (nextPayload: unknown) => {
          payload = nextPayload as Record<string, unknown>;
          return nextPayload;
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

    expect(payload).toMatchObject({
      model: "plamo-3.0-prime-beta",
      max_tokens: 20_000,
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "こんにちは" },
      ],
      stream: false,
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
    expect(payload).not.toHaveProperty("max_completion_tokens");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("store");
    expect(payload).not.toHaveProperty("stream_options");
    expect(
      (payload?.tools as Array<{ function?: { strict?: unknown } }> | undefined)?.[0]?.function,
    ).not.toHaveProperty("strict");
  });

  it("sends the documented payload and auth headers on the wire", async () => {
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            model: "plamo-3.0-prime-beta",
            choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
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
        reasoning: "low",
        toolChoice: {
          type: "function",
          function: { name: "read" },
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
      tool_choice: {
        type: "function",
        function: { name: "read" },
      },
      stream: false,
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
    expect(request.body).not.toHaveProperty("max_completion_tokens");
    expect(request.body).not.toHaveProperty("reasoning_effort");
    expect(request.body).not.toHaveProperty("store");
    expect(request.body).not.toHaveProperty("stream_options");
    expect(
      (request.body.tools as Array<{ function?: { strict?: unknown } }> | undefined)?.[0]?.function,
    ).not.toHaveProperty("strict");
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            model: "plamo-3.0-prime-beta",
            choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
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
        reasoning: "low",
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

  it("extracts inline PLaMo tool markup from non-stream completions", async () => {
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
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-tool",
          model: "plamo-3.0-prime-beta",
          choices: [
            {
              message: {
                role: "assistant",
                reasoning_content: "Thinking...",
                content: `I will inspect the file.\n${toolMarkup}`,
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      );
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

    expect(eventTypes).toContain("toolcall_start");
    expect(eventTypes).toContain("toolcall_delta");
    expect(eventTypes).toContain("toolcall_end");
    expect(result).toMatchObject({
      stopReason: "toolUse",
      content: [
        {
          type: "thinking",
          thinking: "Thinking...",
        },
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

  it("normalizes inline PLaMo tool markup into tool calls", async () => {
    const provider = registerSingleProviderPlugin(plamoPlugin);
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
      extraParams: {
        plamoSyntheticStream: false,
      },
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
});
