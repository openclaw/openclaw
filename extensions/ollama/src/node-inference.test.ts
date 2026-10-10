// Ollama node inference tests cover local discovery, chat, and agent tool routing.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createOllamaNodeInvokePolicy } from "./node-inference-registration.js";
import { createOllamaNodeHostCommands, createOllamaNodeInferenceTool } from "./node-inference.js";

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
  options?: {
    models: Array<Record<string, unknown>>;
    loadedModels?: Array<Record<string, unknown>>;
  },
): Promise<T> {
  const chatRequests: Record<string, unknown>[] = [];
  const showRequests: string[] = [];
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/tags") {
      response.end(
        JSON.stringify({
          models: options?.models ?? [
            {
              name: "remote:cloud",
              size: 1,
              remote_host: "https://ollama.com",
              details: {},
            },
            {
              name: "remote-model-only:latest",
              size: 1,
              remote_model: "upstream-chat",
              details: {},
            },
            {
              name: "tagged-only:cloud",
              size: 1,
              details: {},
            },
            {
              name: "tagged-only:120b-cloud",
              size: 1,
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
      response.end(JSON.stringify({ models: options?.loadedModels ?? [{ name: "chat:large" }] }));
      return;
    }
    if (request.url === "/api/show") {
      const body = (await readBody(request)) as { model?: string };
      if (body.model) {
        showRequests.push(body.model);
      }
      if (body.model === "unknown:latest") {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "show failed" }));
        return;
      }
      const embedding = body.model?.startsWith("embedding") === true;
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

  it("discovers a loaded local model beyond the completion model limit", async () => {
    const models = [
      ...Array.from({ length: 200 }, (_, index) => ({ name: `chat-${index}:latest` })),
      { name: "chat:loaded", size: 500 },
    ];

    await withOllamaServer(
      async (baseUrl, _chatRequests, showRequests) => {
        const result = JSON.parse(await commandByName(baseUrl, OLLAMA_MODELS_COMMAND).handle()) as {
          provider: string;
          models: Array<{ name: string; loaded: boolean }>;
        };

        expect(result.provider).toBe("ollama");
        expect(result.models).toHaveLength(200);
        expect(result.models[0]).toMatchObject({ name: "chat:loaded", loaded: true });
        expect(showRequests[0]).toBe("chat:loaded");
        expect(showRequests).toHaveLength(200);
      },
      { models, loadedModels: [{ name: "chat:loaded" }] },
    );
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
      for (const model of [
        "remote:cloud",
        "remote-model-only:latest",
        "tagged-only:cloud",
        "tagged-only:120b-cloud",
        "embedding:latest",
      ]) {
        await expect(
          commandByName(baseUrl, OLLAMA_CHAT_COMMAND).handle(
            JSON.stringify({ model, prompt: "hello" }),
          ),
        ).rejects.toThrow("is not a local chat model");
      }
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

describe("node_inference agent tool", () => {
  it("uses a flat action enum supported by local model providers", () => {
    const tool = createOllamaNodeInferenceTool(createTestPluginApi());
    const action = (tool.parameters as { properties: { action: unknown } }).properties.action;

    expect(action).toMatchObject({ type: "string", enum: ["discover", "run"] });
    expect(action).not.toHaveProperty("anyOf");
    expect(action).not.toHaveProperty("oneOf");
  });

  it("discovers only nodes authorized for local model discovery", async () => {
    const invoke = vi.fn(async () => ({
      payload: { provider: "ollama", models: [{ name: "chat:small", loaded: true }] },
    }));
    const api = createTestPluginApi({
      runtime: {
        nodes: {
          list: async () => ({
            nodes: [
              {
                nodeId: "denied-node",
                connected: true,
                commands: [OLLAMA_MODELS_COMMAND, OLLAMA_CHAT_COMMAND],
                invocableCommands: [],
              },
              {
                nodeId: "allowed-node",
                displayName: "Desk",
                connected: true,
                commands: [OLLAMA_MODELS_COMMAND, OLLAMA_CHAT_COMMAND],
                invocableCommands: [OLLAMA_MODELS_COMMAND],
              },
            ],
          }),
          invoke,
        },
      } as never,
    });

    const result = await createOllamaNodeInferenceTool(api).execute("call-discover", {
      action: "discover",
    });

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith({
      nodeId: "allowed-node",
      command: OLLAMA_MODELS_COMMAND,
      params: {},
      timeoutMs: 90_000,
      scopes: ["operator.write"],
    });
    expect(result.details).toEqual({
      nodes: [
        {
          nodeId: "allowed-node",
          displayName: "Desk",
          ok: true,
          provider: "ollama",
          models: [{ name: "chat:small", loaded: true }],
        },
      ],
    });
  });

  it("routes inference to the node authorized for model discovery and chat", async () => {
    const invoke = vi.fn(async () => ({
      payload: { provider: "ollama", model: "chat:small", response: "done" },
    }));
    const api = createTestPluginApi({
      runtime: {
        nodes: {
          list: async () => ({
            nodes: [
              {
                nodeId: "denied-node",
                connected: true,
                commands: [OLLAMA_MODELS_COMMAND, OLLAMA_CHAT_COMMAND],
                invocableCommands: [OLLAMA_MODELS_COMMAND],
              },
              {
                nodeId: "allowed-node",
                connected: true,
                commands: [OLLAMA_MODELS_COMMAND, OLLAMA_CHAT_COMMAND],
                invocableCommands: [OLLAMA_MODELS_COMMAND, OLLAMA_CHAT_COMMAND],
              },
            ],
          }),
          invoke,
        },
      } as never,
    });

    const result = await createOllamaNodeInferenceTool(api).execute("call-authorized", {
      action: "run",
      model: "chat:small",
      prompt: "answer fast",
      maxTokens: 32,
    });

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith({
      nodeId: "allowed-node",
      command: OLLAMA_CHAT_COMMAND,
      params: {
        model: "chat:small",
        prompt: "answer fast",
        maxTokens: 32,
        timeoutMs: 120_000,
      },
      timeoutMs: 120_000,
      scopes: ["operator.write"],
    });
    expect(result.details).toMatchObject({
      nodeId: "allowed-node",
      provider: "ollama",
      model: "chat:small",
      response: "done",
    });
  });
});

type AbortTestServer = {
  baseUrl: string;
  requests: string[];
  canceled: string[];
};

async function withAbortTestServer(
  stallPath: string,
  run: (server: AbortTestServer) => Promise<void>,
  options?: { stallCount?: number },
): Promise<void> {
  const requests: string[] = [];
  const canceled: string[] = [];
  let stalls = 0;
  await withServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      requests.push(requestPath);
      if (requestPath === stallPath && stalls < (options?.stallCount ?? Number.POSITIVE_INFINITY)) {
        stalls += 1;
        response.once("close", () => {
          if (!response.writableFinished) {
            canceled.push(requestPath);
          }
        });
        return;
      }

      response.setHeader("Content-Type", "application/json");
      if (requestPath === "/api/tags") {
        response.end(
          JSON.stringify({
            models: [{ name: "node-local:small", digest: "sha256:node-local-small", size: 512 }],
          }),
        );
        return;
      }
      if (requestPath === "/api/show") {
        response.end(
          JSON.stringify({
            capabilities: ["completion", "tools"],
            model_info: { "test.context_length": 8192 },
          }),
        );
        return;
      }
      if (requestPath === "/api/chat") {
        response.end(
          JSON.stringify({
            model: "node-local:small",
            message: { content: "node-only inference" },
            done_reason: "stop",
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    },
    async (baseUrl) => {
      await run({
        baseUrl,
        requests,
        canceled,
      });
    },
  );
}

describe("node-local Ollama inference cancellation", () => {
  it.each([
    { phase: "model discovery", path: "/api/tags" },
    { phase: "model capability verification", path: "/api/show" },
  ])("closes the node-local request when $phase is canceled", async ({ path }) => {
    await withAbortTestServer(path, async ({ baseUrl, requests, canceled }) => {
      const controller = new AbortController();
      const inference = commandByName(baseUrl, OLLAMA_CHAT_COMMAND).handle(
        JSON.stringify({ model: "node-local:small", prompt: "answer locally" }),
        undefined,
        { sendNodeEvent: async () => undefined, signal: controller.signal },
      );
      await vi.waitFor(() => expect(requests).toContain(path));

      controller.abort(new Error("node inference canceled"));

      await expect(inference).rejects.toThrow("node inference canceled");
      await vi.waitFor(() => expect(canceled).toContain(path));
    });
  });

  it("forwards an agent-tool cancellation through its paired node runtime", async () => {
    await withAbortTestServer("/api/chat", async ({ baseUrl, requests, canceled }) => {
      const controller = new AbortController();
      const invoke = vi.fn(
        async (params: { command: string; params?: unknown; signal?: AbortSignal }) => ({
          payloadJSON: await commandByName(baseUrl, OLLAMA_CHAT_COMMAND).handle(
            JSON.stringify(params.params),
            undefined,
            { sendNodeEvent: async () => undefined, signal: params.signal },
          ),
        }),
      );
      const api = createTestPluginApi({
        runtime: {
          nodes: {
            list: async () => ({
              nodes: [
                {
                  nodeId: "paired-node",
                  connected: true,
                  commands: ["ollama.models", "ollama.chat"],
                },
              ],
            }),
            invoke,
          },
        } as never,
      });

      const inference = createOllamaNodeInferenceTool(api).execute(
        "paired-node-inference",
        {
          action: "run",
          model: "node-local:small",
          prompt: "answer only from the paired node",
        },
        controller.signal,
      );
      await vi.waitFor(() => expect(requests).toContain("/api/chat"));

      controller.abort(new Error("agent inference canceled"));

      await expect(inference).rejects.toThrow("agent inference canceled");
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: "paired-node",
          command: "ollama.chat",
          signal: controller.signal,
        }),
      );
      await vi.waitFor(() => expect(canceled).toContain("/api/chat"));
    });
  });

  it("normalizes a pre-aborted agent-tool string reason before listing nodes", async () => {
    const list = vi.fn(async () => ({ nodes: [] }));
    const api = createTestPluginApi({
      runtime: { nodes: { list, invoke: vi.fn() } } as never,
    });

    const inference = createOllamaNodeInferenceTool(api).execute(
      "paired-node-inference",
      { action: "discover" },
      AbortSignal.abort("agent inference canceled"),
    );

    await expect(inference).rejects.toBeInstanceOf(Error);
    await expect(inference).rejects.toMatchObject({ message: "agent inference canceled" });
    expect(list).not.toHaveBeenCalled();
  });

  it("does not poison shared model metadata after a canceled show request", async () => {
    await withAbortTestServer(
      "/api/show",
      async ({ baseUrl, requests, canceled }) => {
        const controller = new AbortController();
        const command = commandByName(baseUrl, OLLAMA_MODELS_COMMAND);
        const canceledDiscovery = command.handle(undefined, undefined, {
          sendNodeEvent: async () => undefined,
          signal: controller.signal,
        });
        await vi.waitFor(() => expect(requests).toContain("/api/show"));

        controller.abort(new Error("first discovery canceled"));
        await expect(canceledDiscovery).rejects.toThrow("first discovery canceled");
        await vi.waitFor(() => expect(canceled).toContain("/api/show"));

        const discovered: unknown = JSON.parse(await command.handle());
        expect(discovered).toMatchObject({
          provider: "ollama",
          models: [
            {
              name: "node-local:small",
              contextWindow: 8192,
              capabilities: ["completion", "tools"],
            },
          ],
        });
        expect(requests.filter((request) => request === "/api/show")).toHaveLength(2);
        expect(JSON.parse(await command.handle())).toEqual(discovered);
        expect(requests.filter((request) => request === "/api/show")).toHaveLength(2);
      },
      { stallCount: 1 },
    );
  });
});

const CHAT_MODEL = "deadline-model:latest";

async function withDelayedOllamaServer<T>(
  delays: Partial<Record<"/api/tags" | "/api/show" | "/api/chat", number>>,
  run: (baseUrl: string, requestedPaths: string[]) => Promise<T>,
): Promise<T> {
  const requestedPaths: string[] = [];
  const sockets = new Set<Socket>();
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const requestPath = request.url;
    if (requestPath !== "/api/tags" && requestPath !== "/api/show" && requestPath !== "/api/chat") {
      response.writeHead(404).end();
      return;
    }
    requestedPaths.push(requestPath);
    const bodyChunks: Buffer[] = [];
    for await (const chunk of request) {
      bodyChunks.push(Buffer.from(chunk));
    }
    if (requestPath !== "/api/tags" && Buffer.concat(bodyChunks).length === 0) {
      throw new Error("Ollama deadline test received an empty POST body");
    }
    const delayMs = delays[requestPath];
    if (delayMs !== undefined) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
    if (response.destroyed) {
      return;
    }
    response.setHeader("Content-Type", "application/json");
    if (requestPath === "/api/tags") {
      response.end(JSON.stringify({ models: [{ name: CHAT_MODEL }] }));
      return;
    }
    if (requestPath === "/api/show") {
      response.end(
        JSON.stringify({
          capabilities: ["completion", "tools"],
          model_info: { "test.context_length": 32_768 },
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        model: CHAT_MODEL,
        message: { content: "within the requested deadline" },
        done_reason: "stop",
      }),
    );
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Ollama deadline test server did not expose a TCP address");
  }
  try {
    return await run(`http://127.0.0.1:${address.port}`, requestedPaths);
  } finally {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    for (const socket of sockets) {
      socket.destroy();
    }
    await closed;
  }
}

function runNodeChat(baseUrl: string, timeoutMs: number): Promise<string> {
  return commandByName(baseUrl, "ollama.chat").handle(
    JSON.stringify({ model: CHAT_MODEL, prompt: "answer within the deadline", timeoutMs }),
  );
}

describe("Ollama node inference deadline", () => {
  it.each([
    ["/api/tags", ["/api/tags"]],
    ["/api/show", ["/api/tags", "/api/show"]],
    ["/api/chat", ["/api/tags", "/api/show", "/api/chat"]],
  ] as const)("bounds a stalled %s request by the inference deadline", async (slowPath, paths) => {
    await withDelayedOllamaServer({ [slowPath]: 900 }, async (baseUrl, requestedPaths) => {
      const startedAtMs = performance.now();

      await expect(runNodeChat(baseUrl, 250)).rejects.toThrow(/timed out|unavailable/);

      expect(performance.now() - startedAtMs).toBeLessThan(2_000);
      expect(requestedPaths).toEqual(paths);
    });
  });

  it("shares one deadline across successful catalog and model preflight", async () => {
    await withDelayedOllamaServer(
      { "/api/tags": 160, "/api/show": 160, "/api/chat": 160 },
      async (baseUrl, requestedPaths) => {
        const startedAtMs = performance.now();

        await expect(runNodeChat(baseUrl, 400)).rejects.toThrow(/timed out|unavailable/);

        expect(performance.now() - startedAtMs).toBeLessThan(2_000);
        expect(requestedPaths.slice(0, 2)).toEqual(["/api/tags", "/api/show"]);
      },
    );
  });
});
