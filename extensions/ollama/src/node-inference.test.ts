import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createOllamaNodeInvokePolicy } from "./node-inference-registration.js";
import { createOllamaNodeHostCommands, createOllamaNodeInferenceTool } from "./node-inference.js";

const MODELS = "ollama.models";
const CHAT = "ollama.chat";

type NodeRuntime = OpenClawPluginApi["runtime"]["nodes"];
type NodeRow = Awaited<ReturnType<NodeRuntime["list"]>>["nodes"][number];
function nodeApi(nodes: NodeRow[], invoke: NodeRuntime["invoke"]) {
  return createTestPluginApi({
    runtime: { nodes: { list: async () => ({ nodes }), invoke } } as never,
  });
}

function nodeRow(nodeId: string, allowed?: string[], displayName?: string): NodeRow {
  return {
    nodeId,
    connected: true,
    commands: ["ollama.models", "ollama.chat"],
    ...(allowed ? { invocableCommands: allowed } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage, body?: string): Promise<unknown> {
  return JSON.parse(body ?? (await text(request)));
}

const LOCAL_CATALOG = [
  { name: "remote:cloud", size: 1, remote_host: "https://ollama.com", details: {} },
  { name: "remote-model-only:latest", size: 1, remote_model: "upstream-chat", details: {} },
  { name: "tagged-only:cloud", size: 1, details: {} },
  { name: "tagged-only:120b-cloud", size: 1, details: {} },
  {
    name: "chat:small",
    size: 500,
    modified_at: "2026-07-01T00:00:00Z",
    details: { family: "small", parameter_size: "0.5B", quantization_level: "Q4_K_M" },
  },
  { name: "embedding:latest", size: 100, details: { family: "embed" } },
  { name: "unknown:latest", size: 50, details: { family: "unknown" } },
  { name: "chat:large", size: 5000, details: { family: "large" } },
];

async function withOllamaServer(
  run: (
    baseUrl: string,
    chatRequests: Record<string, unknown>[],
    requests: string[],
    canceled: string[],
  ) => Promise<void>,
  options?: {
    models: Array<Record<string, unknown>>;
    loadedModels?: Array<Record<string, unknown>> | false;
    stallPath?: string;
    stallCount?: number;
    delays?: Partial<Record<string, number>>;
    showContextWindow?: number;
    chatContent?: string;
  },
): Promise<void> {
  const chatRequests: Record<string, unknown>[] = [];
  const requests: string[] = [];
  const canceled: string[] = [];
  let stalls = 0;
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? "/";
    if (path !== "/api/ps") {
      requests.push(path);
    }
    if (path === options?.stallPath && stalls < (options?.stallCount ?? Infinity)) {
      stalls++;
      response.once("close", () => {
        if (!response.writableFinished) {
          canceled.push(path);
        }
      });
      return;
    }
    const bodyText = options?.delays && path !== "/api/tags" ? await text(request) : undefined;
    if (bodyText === "") {
      throw new Error("Ollama deadline test received an empty POST body");
    }
    const delay = options?.delays?.[path];
    if (delay !== undefined) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay);
      });
      if (response.destroyed) {
        return;
      }
    }
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/tags") {
      return sendJson(response, { models: options?.models ?? LOCAL_CATALOG });
    }
    if (request.url === "/api/ps" && options?.loadedModels !== false) {
      return sendJson(response, { models: options?.loadedModels ?? [{ name: "chat:large" }] });
    }
    if (request.url === "/api/show") {
      const body = (await readBody(request, bodyText)) as { model?: string };
      if (body.model === "unknown:latest") {
        response.statusCode = 500;
        return sendJson(response, { error: "show failed" });
      }
      const embedding = body.model?.startsWith("embedding") === true;
      return sendJson(response, {
        capabilities: embedding ? ["embedding"] : ["completion", "tools"],
        model_info: embedding ? {} : { "test.context_length": options?.showContextWindow ?? 32768 },
      });
    }
    if (request.url === "/api/chat") {
      const body = (await readBody(request, bodyText)) as Record<string, unknown>;
      chatRequests.push(body);
      return sendJson(response, {
        model: body.model,
        message: { content: options?.chatContent ?? "local answer" },
        done_reason:
          (body.options as { num_predict?: unknown } | undefined)?.num_predict === 1
            ? "length"
            : "stop",
        prompt_eval_count: 8,
        eval_count: 3,
        load_duration: 2_500_000,
        total_duration: 12_750_000,
      });
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  };
  await withServer(
    (request, response) => {
      void handleRequest(request, response);
    },
    (baseUrl) => run(baseUrl, chatRequests, requests, canceled),
  );
}

function commandByName(baseUrl: string, command: string) {
  return createOllamaNodeHostCommands({ baseUrl }).find(
    (candidate) => candidate.command === command,
  )!;
}

function chat(baseUrl: string, params: Record<string, unknown>) {
  return commandByName(baseUrl, CHAT).handle(JSON.stringify(params));
}

describe("Ollama node host inference", () => {
  it("discovers bounded local chat models, prioritizing loaded models beyond the limit", async () => {
    const extraModels = Array.from({ length: 200 }, (_, index) => ({
      name: `chat-${index}:latest`,
    }));
    await withOllamaServer(
      async (baseUrl) => {
        const result: { provider: string; models: Array<Record<string, unknown>> } = JSON.parse(
          await commandByName(baseUrl, MODELS).handle(),
        );

        expect(result.provider).toBe("ollama");
        expect(result.models).toHaveLength(200);
        expect(result.models.slice(0, 2)).toMatchObject([
          { name: "chat:large", loaded: true, contextWindow: 32768 },
          {
            name: "chat:small",
            loaded: false,
            family: "small",
            parameterSize: "0.5B",
            quantization: "Q4_K_M",
          },
        ]);
      },
      { models: [...LOCAL_CATALOG.slice(0, -1), ...extraModels, LOCAL_CATALOG.at(-1)!] },
    );
  });

  it("runs bounded chat and returns compact usage", async () => {
    await withOllamaServer(async (baseUrl, chatRequests) => {
      const result = JSON.parse(
        await chat(baseUrl, {
          model: "chat:small",
          prompt: "Summarize this",
          system: "Be concise",
          maxTokens: 64,
          temperature: 0.2,
        }),
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
      expect(result.timings).toEqual({ loadMs: 2.5, totalMs: 12.75 });
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
        await expect(chat(baseUrl, { model, prompt: "hello" })).rejects.toThrow(
          "is not a local chat model",
        );
      }
      expect(chatRequests).toHaveLength(0);
    });
  });

  it("rejects a token-limited partial answer", async () => {
    await withOllamaServer(async (baseUrl) => {
      await expect(
        chat(baseUrl, { model: "chat:small", prompt: "long answer", maxTokens: 1 }),
      ).rejects.toThrow("reaching maxTokens (1)");
    });
  });

  it("registers desktop and server inference commands", () => {
    expect(createOllamaNodeInvokePolicy()).toMatchObject({
      commands: ["ollama.models", "ollama.chat"],
      defaultPlatforms: ["macos", "linux", "windows"],
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

  it.each(["discover", "run"] as const)("routes %s only to authorized nodes", async (action) => {
    const discovery = action === "discover";
    const command = discovery ? MODELS : CHAT;
    const timeoutMs = discovery ? 90_000 : 120_000;
    const payload = discovery
      ? { provider: "ollama", models: [{ name: "chat:small", loaded: true }] }
      : { provider: "ollama", model: "chat:small", response: "done" };
    const params = discovery ? {} : { model: "chat:small", prompt: "answer fast", maxTokens: 32 };
    const invoke = vi.fn(async () => ({ payload }));
    const api = nodeApi(
      [
        nodeRow("denied-node", discovery ? [] : [MODELS]),
        nodeRow(
          "allowed-node",
          discovery ? [command] : [MODELS, command],
          discovery ? "Desk" : undefined,
        ),
      ],
      invoke,
    );
    const result = await createOllamaNodeInferenceTool(api).execute("call-authorized", {
      action,
      ...params,
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith({
      nodeId: "allowed-node",
      command,
      params: discovery ? params : { ...params, timeoutMs },
      timeoutMs,
      scopes: ["operator.write"],
    });
    if (discovery) {
      expect(result.details).toEqual({
        nodes: [{ nodeId: "allowed-node", displayName: "Desk", ok: true, ...payload }],
      });
    } else {
      expect(result.details).toMatchObject({ nodeId: "allowed-node", ...payload });
    }
  });
});

async function withAbortTestServer(
  stallPath: string,
  run: (server: {
    invoke: NodeRuntime["invoke"];
    discover: (signal?: AbortSignal) => Promise<string>;
    signal: AbortSignal;
    cancel: (inference: Promise<unknown>, reason: string) => Promise<void>;
    requests: string[];
  }) => Promise<void>,
  options?: { stallCount?: number },
): Promise<void> {
  await withOllamaServer(
    (baseUrl, _chats, requests, canceled) => {
      const controller = new AbortController();
      const context = { sendNodeEvent: async () => undefined, signal: controller.signal };
      const command = commandByName(baseUrl, MODELS);
      return run({
        requests,
        signal: controller.signal,
        discover: (signal) =>
          command.handle(undefined, undefined, signal ? { ...context, signal } : undefined),
        invoke: async (params) => ({
          payloadJSON: await commandByName(baseUrl, CHAT).handle(
            JSON.stringify(params.params),
            undefined,
            { ...context, signal: params.signal },
          ),
        }),
        cancel: async (inference, reason) => {
          await vi.waitFor(() => expect(requests).toContain(stallPath));
          controller.abort(new Error(reason));
          await expect(inference).rejects.toThrow(reason);
          await vi.waitFor(() => expect(canceled).toContain(stallPath));
        },
      });
    },
    {
      models: [{ name: "node-local:small", digest: "sha256:node-local-small", size: 512 }],
      loadedModels: false,
      showContextWindow: 8192,
      chatContent: "node-only inference",
      stallPath,
      ...options,
    },
  );
}

describe("node-local Ollama inference cancellation", () => {
  it.each(["/api/tags", "/api/show", "/api/chat"])(
    "forwards agent cancellation through the paired node and closes %s",
    async (path) => {
      await withAbortTestServer(path, async (server) => {
        const invoke = vi.fn(server.invoke);
        const api = nodeApi([nodeRow("paired-node")], invoke);
        const inference = createOllamaNodeInferenceTool(api).execute(
          "run",
          { action: "run", model: "node-local:small", prompt: "local" },
          server.signal,
        );
        await server.cancel(inference, "agent inference canceled");
        expect(invoke).toHaveBeenCalledWith(
          expect.objectContaining({
            nodeId: "paired-node",
            command: "ollama.chat",
            signal: server.signal,
          }),
        );
      });
    },
  );

  it("normalizes a pre-aborted agent-tool string reason before listing nodes", async () => {
    const list = vi.fn(async () => ({ nodes: [] }));
    const api = createTestPluginApi({ runtime: { nodes: { list, invoke: vi.fn() } } as never });
    const inference = createOllamaNodeInferenceTool(api).execute(
      "paired-node-inference",
      { action: "discover" },
      AbortSignal.abort("agent inference canceled"),
    );
    await expect(inference).rejects.toBeInstanceOf(Error);
    await expect(inference).rejects.toMatchObject({ message: "agent inference canceled" });
    expect(list).not.toHaveBeenCalled();
  });

  // Go through ollama.models without a timeout, because a timeout bypasses the
  // cache on its own. Keep the cache key stable and prove both cancellation
  // isolation and later successful reuse.
  it("does not poison shared model metadata after a canceled show request", async () => {
    await withAbortTestServer(
      "/api/show",
      async (server) => {
        await server.cancel(server.discover(server.signal), "first discovery canceled");
        const discovered: unknown = JSON.parse(await server.discover());
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
        expect(server.requests.filter((request) => request === "/api/show")).toHaveLength(2);
        expect(JSON.parse(await server.discover())).toEqual(discovered);
        expect(server.requests.filter((request) => request === "/api/show")).toHaveLength(2);
      },
      { stallCount: 1 },
    );
  });
});

const CHAT_MODEL = "deadline-model:latest";
const PHASES = ["/api/tags", "/api/show", "/api/chat"];

describe("Ollama node inference deadline", () => {
  it.each([
    ["stalled tags", [900], 250, 1, true],
    ["stalled show", [undefined, 900], 250, 2, true],
    ["stalled chat", [undefined, undefined, 900], 250, 3, true],
    ["shared preflight", [160, 160, 160], 400, 2, false],
  ] as const)(
    "bounds %s by one inference deadline",
    async (_name, delayMs, timeout, phases, exact) => {
      await withOllamaServer(
        async (baseUrl, _chats, requestedPaths) => {
          const startedAtMs = performance.now();
          await expect(
            chat(baseUrl, { model: CHAT_MODEL, prompt: "deadline", timeoutMs: timeout }),
          ).rejects.toThrow(/timed out|unavailable/);
          expect(performance.now() - startedAtMs).toBeLessThan(2_000);
          expect(exact ? requestedPaths : requestedPaths.slice(0, phases)).toEqual(
            PHASES.slice(0, phases),
          );
        },
        {
          models: [{ name: CHAT_MODEL }],
          loadedModels: false,
          chatContent: "within the requested deadline",
          delays: Object.fromEntries(delayMs.map((delay, index) => [PHASES[index], delay])),
        },
      );
    },
  );
});
