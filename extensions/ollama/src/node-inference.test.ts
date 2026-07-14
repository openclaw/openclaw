// Ollama node inference tests cover local discovery, chat, and agent tool routing.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import {
  __testing,
  createOllamaNodeHostCommands,
  createOllamaNodeInferenceTool,
  createOllamaNodeInvokePolicy,
} from "./node-inference.js";

const [OLLAMA_MODELS_COMMAND, OLLAMA_CHAT_COMMAND] = createOllamaNodeInvokePolicy().commands;
if (!OLLAMA_MODELS_COMMAND || !OLLAMA_CHAT_COMMAND) {
  throw new Error("Ollama node inference policy must register models and chat commands");
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function withOllamaServer<T>(
  run: (
    baseUrl: string,
    chatRequests: Record<string, unknown>[],
    showRequests: string[],
  ) => Promise<T>,
): Promise<T> {
  const chatRequests: Record<string, unknown>[] = [];
  const showRequests: string[] = [];
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/tags") {
      response.end(
        JSON.stringify({
          models: [
            {
              name: "remote:cloud",
              size: 1,
              remote_host: "https://ollama.com",
              details: {},
            },
            {
              name: "chat:small",
              size: 500,
              modified_at: "2026-07-01T00:00:00Z",
              details: {
                family: "small",
                parameter_size: "0.5B",
                quantization_level: "Q4_K_M",
              },
            },
            { name: "chat:large", size: 5000, details: { family: "large" } },
            { name: "embedding:latest", size: 100, details: { family: "embed" } },
            { name: "unknown:latest", size: 50, details: { family: "unknown" } },
          ],
        }),
      );
      return;
    }
    if (request.url === "/api/ps") {
      response.end(JSON.stringify({ models: [{ name: "chat:large" }] }));
      return;
    }
    if (request.url === "/api/show") {
      const body = (await readBody(request)) as { name?: string };
      if (body.name) {
        showRequests.push(body.name);
      }
      if (body.name === "unknown:latest") {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "show failed" }));
        return;
      }
      const embedding = body.name === "embedding:latest";
      response.end(
        JSON.stringify({
          capabilities: embedding ? ["embedding"] : ["completion", "tools"],
          model_info: embedding ? {} : { "test.context_length": 32768 },
        }),
      );
      return;
    }
    if (request.url === "/api/chat") {
      const body = (await readBody(request)) as Record<string, unknown>;
      chatRequests.push(body);
      response.end(
        JSON.stringify({
          model: body.model,
          message: { content: "local answer" },
          done_reason:
            (body.options as { num_predict?: unknown } | undefined)?.num_predict === 1
              ? "length"
              : "stop",
          prompt_eval_count: 8,
          eval_count: 3,
          load_duration: 2_500_000,
          total_duration: 12_750_000,
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(request, response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP address");
  }
  try {
    return await run(`http://127.0.0.1:${address.port}`, chatRequests, showRequests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function commandByName(baseUrl: string, command: string) {
  const entry = createOllamaNodeHostCommands({ baseUrl }).find(
    (candidate) => candidate.command === command,
  );
  if (!entry) {
    throw new Error(`missing ${command} test command`);
  }
  return entry;
}

describe("Ollama node host inference", () => {
  it("discovers local chat models and ranks loaded models first", async () => {
    await withOllamaServer(async (baseUrl) => {
      const result = JSON.parse(await commandByName(baseUrl, OLLAMA_MODELS_COMMAND).handle()) as {
        provider: string;
        models: Array<Record<string, unknown>>;
      };

      expect(result.provider).toBe("ollama");
      expect(result.models.map((model) => model.name)).toEqual(["chat:large", "chat:small"]);
      expect(result.models[0]).toMatchObject({ loaded: true, contextWindow: 32768 });
      expect(result.models[1]).toMatchObject({
        loaded: false,
        family: "small",
        parameterSize: "0.5B",
        quantization: "Q4_K_M",
      });
    });
  });

  it("runs bounded chat and returns compact usage", async () => {
    await withOllamaServer(async (baseUrl, chatRequests, showRequests) => {
      const result = JSON.parse(
        await commandByName(baseUrl, OLLAMA_CHAT_COMMAND).handle(
          JSON.stringify({
            model: "chat:small",
            prompt: "Summarize this",
            system: "Be concise",
            maxTokens: 64,
            temperature: 0.2,
          }),
        ),
      );

      expect(chatRequests).toEqual([
        {
          model: "chat:small",
          messages: [
            { role: "system", content: "Be concise" },
            { role: "user", content: "Summarize this" },
          ],
          stream: false,
          think: false,
          options: { num_predict: 64, temperature: 0.2 },
        },
      ]);
      expect(showRequests).toEqual(["chat:small"]);
      expect(result).toEqual({
        provider: "ollama",
        model: "chat:small",
        response: "local answer",
        usage: { promptTokens: 8, completionTokens: 3 },
        timings: { loadMs: 2.5, totalMs: 12.75 },
      });
    });
  });

  it("rejects remote and non-chat models before inference", async () => {
    await withOllamaServer(async (baseUrl, chatRequests) => {
      await expect(
        commandByName(baseUrl, OLLAMA_CHAT_COMMAND).handle(
          JSON.stringify({ model: "remote:cloud", prompt: "hello" }),
        ),
      ).rejects.toThrow("is not a local chat model");
      await expect(
        commandByName(baseUrl, OLLAMA_CHAT_COMMAND).handle(
          JSON.stringify({ model: "embedding:latest", prompt: "hello" }),
        ),
      ).rejects.toThrow("is not a local chat model");
      expect(chatRequests).toHaveLength(0);
    });
  });

  it("rejects a token-limited partial answer", async () => {
    await withOllamaServer(async (baseUrl) => {
      await expect(
        commandByName(baseUrl, OLLAMA_CHAT_COMMAND).handle(
          JSON.stringify({ model: "chat:small", prompt: "long answer", maxTokens: 1 }),
        ),
      ).rejects.toThrow("reaching maxTokens (1)");
    });
  });

  it("registers a desktop and server pass-through policy", async () => {
    const policy = createOllamaNodeInvokePolicy();
    const invokeNode = vi.fn(async () => ({ ok: true as const, payload: { ok: true } }));

    expect(policy.commands).toEqual(["ollama.models", "ollama.chat"]);
    expect(policy.defaultPlatforms).toEqual(["macos", "linux", "windows"]);
    await expect(policy.handle({ invokeNode } as never)).resolves.toEqual({
      ok: true,
      payload: { ok: true },
    });
  });
});

describe("Ollama node chat controlled runtime", () => {
  type Mode = "normal" | "caller-abort" | "timeout";

  async function withOllamaLoopback(
    mode: Mode,
    run: (params: {
      baseUrl: string;
      mode: Mode;
      requestClosedAt: () => number | undefined;
      serverGotChatRequest: Promise<void>;
    }) => Promise<void>,
  ): Promise<void> {
    let chatRequestClosedAt: number | undefined;
    let resolveServerGotChatRequest: () => void = () => undefined;
    const serverGotChatRequest = new Promise<void>((resolve) => {
      resolveServerGotChatRequest = resolve;
    });
    const respondJson = (response: ServerResponse, payload: unknown) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(payload));
    };
    const server = createServer((request, response) => {
      const url = request.url ?? "";
      // /api/tags: respond normally so fetchOllamaModels discovers chat:small
      if (url === "/api/tags" || url.startsWith("/api/tags?")) {
        respondJson(response, {
          models: [
            {
              name: "chat:small",
              size: 500,
              modified_at: "2026-07-01T00:00:00Z",
              details: { family: "small" },
            },
          ],
        });
        return;
      }
      // /api/show: respond normally so enrichOllamaModelsWithContext marks it completion-capable
      if (url === "/api/show" || url.startsWith("/api/show?")) {
        respondJson(response, {
          capabilities: ["completion"],
          details: { family: "small" },
        });
        return;
      }
      // /api/chat: apply the test mode
      resolveServerGotChatRequest();
      if (mode === "normal") {
        respondJson(response, {
          model: "chat:small",
          message: { content: "local answer" },
          done_reason: "stop",
          prompt_eval_count: 8,
          eval_count: 3,
          load_duration: 2_500_000,
          total_duration: 12_750_000,
        });
        return;
      }
      // caller-abort and timeout: never call response.end()
      response.on("close", () => {
        chatRequestClosedAt = Date.now();
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    try {
      await run({
        baseUrl: `http://127.0.0.1:${port}`,
        mode,
        requestClosedAt: () => chatRequestClosedAt,
        serverGotChatRequest,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  it("normal mode: caller signal honored, server returns chat payload", async () => {
    await withOllamaLoopback("normal", async ({ baseUrl, serverGotChatRequest }) => {
      const caller = new AbortController();
      const callStart = Date.now();
      const task = __testing.runOllamaNodeChat({
        baseUrl,
        model: "chat:small",
        prompt: "hello",
        maxTokens: 50,
        timeoutMs: 5_000,
        callerSignal: caller.signal,
      });
      const result = await task;
      const elapsedMs = Date.now() - callStart;
      expect(result.response).toBe("local answer");
      expect(elapsedMs).toBeLessThan(2_000);
      await serverGotChatRequest;
    });
  });

  it("caller-abort mode: caller abort closes the /api/chat request within 1s", async () => {
    await withOllamaLoopback(
      "caller-abort",
      async ({ baseUrl, requestClosedAt, serverGotChatRequest }) => {
        const caller = new AbortController();
        const callStart = Date.now();
        const task = __testing.runOllamaNodeChat({
          baseUrl,
          model: "chat:small",
          prompt: "long prompt",
          maxTokens: 50,
          timeoutMs: 10_000,
          callerSignal: caller.signal,
        });
        await serverGotChatRequest;
        setTimeout(() => caller.abort(), 200);
        await expect(task).rejects.toThrow();
        const elapsedMs = Date.now() - callStart;
        const closedAt = requestClosedAt();
        expect(closedAt).toBeDefined();
        const serverElapsed = closedAt! - callStart;
        expect(elapsedMs).toBeLessThan(2_000);
        expect(serverElapsed).toBeLessThan(2_000);
      },
    );
  });

  it("timeout mode: 100ms timeout aborts a hanging /api/chat request", async () => {
    await withOllamaLoopback(
      "timeout",
      async ({ baseUrl, requestClosedAt, serverGotChatRequest }) => {
        const callStart = Date.now();
        const task = __testing.runOllamaNodeChat({
          baseUrl,
          model: "chat:small",
          prompt: "long prompt",
          maxTokens: 50,
          timeoutMs: 100,
        });
        await serverGotChatRequest;
        await expect(task).rejects.toThrow();
        const elapsedMs = Date.now() - callStart;
        const closedAt = requestClosedAt();
        expect(closedAt).toBeDefined();
        const serverElapsed = closedAt! - callStart;
        expect(elapsedMs).toBeGreaterThanOrEqual(80);
        expect(elapsedMs).toBeLessThan(2_000);
        expect(serverElapsed).toBeLessThan(2_000);
      },
    );
  });
});

describe("node_inference agent tool", () => {
  it("discovers models through the connected node runtime", async () => {
    const invoke = vi.fn(async () => ({
      payload: { provider: "ollama", models: [{ name: "chat:small", loaded: true }] },
    }));
    const api = createTestPluginApi({
      runtime: {
        nodes: {
          list: async () => ({
            nodes: [
              {
                nodeId: "node-1",
                displayName: "Desk",
                connected: true,
                commands: [OLLAMA_MODELS_COMMAND, OLLAMA_CHAT_COMMAND],
              },
            ],
          }),
          invoke,
        },
      } as never,
    });

    const result = await createOllamaNodeInferenceTool(api).execute("call-1", {
      action: "discover",
    });

    expect(invoke).toHaveBeenCalledWith({
      nodeId: "node-1",
      command: OLLAMA_MODELS_COMMAND,
      params: {},
      timeoutMs: 90_000,
      scopes: ["operator.write"],
    });
    expect(result.details).toEqual({
      nodes: [
        {
          nodeId: "node-1",
          displayName: "Desk",
          ok: true,
          provider: "ollama",
          models: [{ name: "chat:small", loaded: true }],
        },
      ],
    });
  });

  it("routes a run to the sole capable node", async () => {
    const invoke = vi.fn(async () => ({
      payload: { provider: "ollama", model: "chat:small", response: "done" },
    }));
    const api = createTestPluginApi({
      runtime: {
        nodes: {
          list: async () => ({
            nodes: [
              {
                nodeId: "node-1",
                connected: true,
                commands: [OLLAMA_MODELS_COMMAND, OLLAMA_CHAT_COMMAND],
              },
            ],
          }),
          invoke,
        },
      } as never,
    });

    const result = await createOllamaNodeInferenceTool(api).execute("call-2", {
      action: "run",
      model: "chat:small",
      prompt: "answer fast",
      maxTokens: 32,
    });

    expect(invoke).toHaveBeenCalledWith({
      nodeId: "node-1",
      command: OLLAMA_CHAT_COMMAND,
      params: {
        model: "chat:small",
        prompt: "answer fast",
        maxTokens: 32,
        timeoutMs: 120_000,
      },
      timeoutMs: 130_000,
      scopes: ["operator.write"],
    });
    expect(result.details).toMatchObject({
      nodeId: "node-1",
      provider: "ollama",
      model: "chat:small",
      response: "done",
    });
  });
});
