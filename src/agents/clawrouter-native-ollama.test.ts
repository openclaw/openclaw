import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Context } from "../llm/types.js";
import { registerSingleProviderPlugin } from "../plugin-sdk/plugin-test-runtime.js";
import { clearLiveCatalogCacheForTests } from "../plugin-sdk/provider-catalog-live-runtime.js";
import { withServer } from "../plugin-sdk/test-env.js";
import { makeAgentAssistantMessage } from "../plugin-sdk/test-fixtures.js";
import { resolveProviderStreamFn } from "../plugins/provider-runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createRegistryRuntimeModel } from "./sessions/model-registry-runtime-model.js";

const loadControl = vi.hoisted(() => {
  const control: {
    gate?: { enter(): void; wait: Promise<void>; settle(): void };
  } = {};
  return control;
});
vi.mock("openclaw/plugin-sdk/provider-stream-family", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugin-sdk/provider-stream-family.js")>();
  return {
    ...actual,
    async createProviderNativeStreamFn(
      ...args: Parameters<typeof actual.createProviderNativeStreamFn>
    ) {
      const gate = loadControl.gate;
      if (gate) {
        gate.enter();
        await gate.wait;
      }
      try {
        return await actual.createProviderNativeStreamFn(...args);
      } finally {
        gate?.settle();
      }
    },
  };
});

const KEY = "synthetic-clawrouter-ollama-proxy-key";
const MODEL = "ollama/qwen3:8b";
type Route = "native" | "manifest";
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const terminal =
  JSON.stringify({
    model: "qwen3:8b",
    message: { role: "assistant", content: "hello" },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 7,
    eval_count: 3,
  }) + "\n";

function catalog(route: Route, changes: Record<string, unknown> = {}) {
  return {
    version: "clawrouter.client-catalog.v1",
    providers: [
      {
        id: "ollama",
        displayName: "Ollama",
        allowed: true,
        executable: true,
        nativeBaseUrl: "/v1/native/ollama",
        openaiCompatible: false,
        routes: [
          {
            endpoint: "chat",
            path: "/api/chat",
            methods: ["POST"],
            requestFormat: "ollama.chat",
            responseFormat: "ollama.chat",
          },
        ],
        models: [
          {
            id: MODEL,
            upstream: "qwen3:8b",
            capabilities: ["llm.chat"],
            input: ["text"],
            pricing: {
              inputMicrosPerMillion: 1_000_000,
              outputMicrosPerMillion: 2_000_000,
              cachedInputMicrosPerMillion: 500_000,
              cacheWrite5mInputMicrosPerMillion: 1_000_000,
              maxInputTokens: 8192,
              defaultMaxOutputTokens: 1024,
            },
          },
        ],
        offers: [
          {
            endpoint: "chat",
            modelId: MODEL,
            eligible: true,
            transport: "http",
            affordability: "request-dependent",
            routeKind: route,
            route: route === "native" ? "/v1/native/ollama/api/chat" : "/v1/proxy/ollama/chat",
            ...changes,
          },
        ],
      },
    ],
  };
}

type Post = {
  url: string | undefined;
  headers: IncomingMessage["headers"];
  rawHeaders: IncomingMessage["rawHeaders"];
  body: unknown;
};
async function withRouter(
  route: Route,
  respond: (response: ServerResponse, request: IncomingMessage) => void,
  run: (fixture: {
    discover: () => Promise<Awaited<ReturnType<typeof prepare>>>;
    posts: Post[];
    arrivals: string[];
    responseClosed: Promise<void>;
    socketClosed: Promise<void>;
  }) => Promise<void>,
  changes: Record<string, unknown> = {},
) {
  const posts: Post[] = [];
  const arrivals: string[] = [];
  const responseClosed = Promise.withResolvers<void>();
  const socketClosed = Promise.withResolvers<void>();
  let serverError: Error | undefined;
  await withOpenClawTestState({ label: "clawrouter-ollama" }, async (state) => {
    await withServer(
      (request, response) => {
        void (async () => {
          if (request.method === "GET" && request.url === "/prefix/v1/catalog") {
            expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify(catalog(route, changes)));
            return;
          }
          arrivals.push(`${request.method} ${request.url}`);
          response.once("close", responseClosed.resolve);
          request.socket.once("close", socketClosed.resolve);
          posts.push({
            url: request.url,
            headers: request.headers,
            rawHeaders: request.rawHeaders,
            body: JSON.parse(await text(request)),
          });
          respond(response, request);
        })().catch((error: unknown) => {
          serverError =
            error instanceof Error ? error : new Error("Router fixture failed", { cause: error });
          response.destroy();
        });
      },
      async (origin) => {
        await run({
          discover: () => prepare(`${origin}/prefix`, state.agentDir(), state.workspaceDir),
          posts,
          arrivals,
          responseClosed: responseClosed.promise,
          socketClosed: socketClosed.promise,
        });
        if (serverError) {
          throw serverError;
        }
      },
    );
  });
}

async function prepare(baseUrl: string, agentDir: string, workspaceDir: string) {
  const { default: entry } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerSingleProviderPlugin>[0];
  }>({ pluginId: "clawrouter", artifactBasename: "index.js" });
  const provider = await registerSingleProviderPlugin(entry);
  const config: OpenClawConfig = {
    models: { providers: { clawrouter: { baseUrl, apiKey: KEY, models: [] } } },
  };
  const discovered = await provider.catalog?.run({
    config,
    env: {},
    agentDir,
    workspaceDir,
    resolveProviderAuth: () => ({
      apiKey: KEY,
      discoveryApiKey: KEY,
      mode: "api_key",
      source: "profile",
    }),
    resolveProviderApiKey: () => ({ apiKey: KEY, discoveryApiKey: KEY }),
  });
  if (!discovered || !("provider" in discovered) || !discovered.provider) {
    throw new Error("Expected the registered ClawRouter catalog");
  }
  const registry = createEmptyPluginRegistry();
  registry.providers.push({ pluginId: "clawrouter", source: "bundled-test", provider });
  setActivePluginRegistry(registry, "clawrouter-ollama-test", "gateway-bindable", workspaceDir);
  const row = discovered.provider.models.find((candidate) => candidate.id === MODEL);
  const model = row
    ? createRegistryRuntimeModel("clawrouter", discovered.provider, row, row.api)
    : undefined;
  const stream = (simple = false) => {
    if (!model) {
      throw new Error("No eligible Ollama model");
    }
    const native = resolveProviderStreamFn({
      provider: "clawrouter",
      workspaceDir,
      allowRuntimePluginLoad: false,
      context: { provider: "clawrouter", modelId: model.id, model, config },
    });
    expect(registry.providers.map((registration) => registration.pluginId)).toEqual(["clawrouter"]);
    if (!native) {
      throw new Error("Registered native Ollama hook missing");
    }
    const hook = simple ? provider.wrapSimpleCompletionStreamFn : provider.wrapStreamFn;
    const wrapped = hook?.({
      config,
      provider: "clawrouter",
      modelId: model.id,
      model,
      streamFn: native,
    });
    if (!wrapped) {
      throw new Error("Registered ClawRouter attribution wrapper missing");
    }
    return wrapped;
  };
  return { provider, model, stream };
}

afterEach(() => {
  loadControl.gate = undefined;
  clearLiveCatalogCacheForTests();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

describe.each(["native", "manifest"] as const)("registered ClawRouter Ollama %s", (route) => {
  it.each(["abort", "deadline"] as const)(
    "denies %s during a bound runtime load without a late POST",
    async (failure) => {
      await withRouter(
        route,
        (response) => response.end(terminal),
        async (f) => {
          const { model, stream } = await f.discover();
          if (!model) {
            throw new Error("Missing selected model");
          }
          const entered = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          const settled = Promise.withResolvers<void>();
          let loads = 0;
          loadControl.gate = {
            enter() {
              loads += 1;
              entered.resolve();
            },
            wait: release.promise,
            settle: settled.resolve,
          };
          const controller = new AbortController();
          const stopped = new Error("caller stopped during runtime load");
          const attempt = Promise.resolve(
            stream()(model, context, {
              apiKey: KEY,
              signal: controller.signal,
              timeoutMs: 1000,
            }),
          );
          const rejected = expect(attempt).rejects.toThrow(
            failure === "abort" ? stopped.message : /timed out|timeout/i,
          );
          try {
            await Promise.race([
              entered.promise,
              attempt.then(() => {
                throw new Error("Stream started before the runtime-load milestone");
              }),
            ]);
            expect(loads).toBe(1);
            expect(f.arrivals).toEqual([]);
            if (failure === "abort") {
              controller.abort(stopped);
            }
            await rejected;
          } finally {
            release.resolve();
            if (loads > 0) {
              await settled.promise;
            }
            loadControl.gate = undefined;
          }
          expect(f.arrivals).toEqual([]);
        },
      );
    },
  );

  it.each([false, true])(
    "uses the exact route, finished payload and proxy key (simple=%s)",
    async (simple) => {
      await withRouter(
        route,
        (response) => {
          response.setHeader("Content-Type", "application/x-ndjson");
          response.write(terminal.slice(0, 29));
          response.end(terminal.slice(29));
        },
        async (f) => {
          const { model, stream } = await f.discover();
          if (!model) {
            throw new Error("Missing selected model");
          }
          const result = await (
            await stream(simple)(model, context, {
              apiKey: KEY,
              timeoutMs: 5000,
              sessionId: "ollama-session",
              onPayload: (payload) => {
                if (typeof payload !== "object" || payload === null) {
                  throw new Error("Expected native payload");
                }
                return { ...payload, keep_alive: "3m" };
              },
            })
          ).result();
          expect(result).toMatchObject({
            stopReason: "stop",
            model: MODEL,
            provider: "clawrouter",
            usage: { input: 7, output: 3 },
          });
          expect(result.content).toEqual([{ type: "text", text: "hello" }]);
          expect(f.posts).toHaveLength(1);
          expect(f.arrivals).toEqual([
            `POST /prefix/v1/${route === "native" ? "native/ollama/api/chat" : "proxy/ollama/chat"}`,
          ]);
          expect(f.posts[0]?.headers).toMatchObject({
            authorization: `Bearer ${KEY}`,
            "x-clawrouter-client": "openclaw",
            "x-clawrouter-session-id": "ollama-session",
          });
          const body = {
            model: "qwen3:8b",
            stream: true,
            keep_alive: "3m",
            messages: [{ role: "user", content: "hello" }],
          };
          expect(f.posts[0]?.body).toMatchObject(route === "native" ? body : { body });
          if (route === "manifest") {
            expect(Object.keys(f.posts[0]?.body ?? {})).toEqual(["body"]);
          }
          await Promise.all([f.responseClosed, f.socketClosed]);
        },
      );
    },
  );

  it.each([
    [false, "authorization"],
    [false, "aUtHoRiZaTiOn"],
    [true, "authorization"],
    [true, "aUtHoRiZaTiOn"],
  ] as const)(
    "keeps one original proxy Authorization (simple=%s, header=%s)",
    async (simple, name) => {
      await withRouter(
        route,
        (response) => response.end(terminal),
        async (f) => {
          const { model, stream } = await f.discover();
          if (!model) {
            throw new Error("Missing selected model");
          }
          const result = await (
            await stream(simple)(model, context, {
              apiKey: KEY,
              headers: { [name]: "Bearer conflicting-synthetic-key" },
              timeoutMs: 5000,
            })
          ).result();
          expect(result.stopReason).toBe("stop");
          expect(f.posts).toHaveLength(1);
          expect(f.arrivals).toEqual([
            `POST /prefix/v1/${route === "native" ? "native/ollama/api/chat" : "proxy/ollama/chat"}`,
          ]);
          expect(f.posts[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
          const authorizationValues = f.posts[0]?.rawHeaders.flatMap((value, index, headers) =>
            index % 2 === 0 && value.toLowerCase() === "authorization" ? [headers[index + 1]] : [],
          );
          expect(authorizationValues).toEqual([`Bearer ${KEY}`]);
          await Promise.all([f.responseClosed, f.socketClosed]);
        },
      );
    },
  );

  it("preserves reasoning and tool IDs through the registered replay policy", async () => {
    await withRouter(
      route,
      (response) => response.end(terminal),
      async (f) => {
        const { model, provider, stream } = await f.discover();
        if (!model) {
          throw new Error("Missing selected model");
        }
        const policy = provider.buildReplayPolicy?.({
          provider: "clawrouter",
          modelId: MODEL,
          modelApi: "ollama",
          config: {},
        });
        expect(policy).toMatchObject({ sanitizeToolCallIds: false });
        const history: Context = {
          messages: [
            ...context.messages,
            makeAgentAssistantMessage({
              api: "ollama",
              provider: "clawrouter",
              model: MODEL,
              stopReason: "toolUse",
              content: [
                { type: "thinking", thinking: "retained reasoning" },
                { type: "toolCall", id: "call:one", name: "lookup", arguments: { value: 1 } },
              ],
            }),
            {
              role: "toolResult",
              toolCallId: "call:one",
              toolName: "lookup",
              content: [{ type: "text", text: "found" }],
              isError: false,
              timestamp: 1,
            },
          ],
          tools: [
            {
              name: "lookup",
              description: "lookup",
              parameters: { type: "object", properties: { value: { type: "number" } } },
            },
          ],
        };
        expect(
          (await (await stream()(model, history, { apiKey: KEY, timeoutMs: 5000 })).result())
            .stopReason,
        ).toBe("stop");
        expect(f.posts[0]?.body).toMatchObject(
          route === "native"
            ? {
                messages: expect.arrayContaining([
                  expect.objectContaining({
                    role: "assistant",
                    thinking: "retained reasoning",
                    tool_calls: [expect.objectContaining({ id: "call:one" })],
                  }),
                  expect.objectContaining({
                    role: "tool",
                    tool_call_id: "call:one",
                    content: "found",
                  }),
                ]),
              }
            : {
                body: {
                  messages: expect.arrayContaining([
                    expect.objectContaining({
                      role: "assistant",
                      thinking: "retained reasoning",
                      tool_calls: [expect.objectContaining({ id: "call:one" })],
                    }),
                    expect.objectContaining({
                      role: "tool",
                      tool_call_id: "call:one",
                      content: "found",
                    }),
                  ]),
                },
              },
        );
        expect(f.posts).toHaveLength(1);
      },
    );
  });

  it.each([
    ['{"message":{"role":"assistant","content":"partial"},"done":false}\n', "incomplete"],
    ['{"error":"model unavailable"}\n', "model unavailable"],
    ['{"message":', ""],
  ])("rejects errors and incomplete EOF without a second POST: %s", async (body) => {
    await withRouter(
      route,
      (response) => response.end(body),
      async (f) => {
        const { model, stream } = await f.discover();
        if (!model) {
          throw new Error("Missing selected model");
        }
        const result = await (
          await stream()(model, context, { apiKey: KEY, timeoutMs: 5000 })
        ).result();
        expect(result.stopReason).toBe("error");
        expect(result.content).toEqual([]);
        expect(f.posts).toHaveLength(1);
        await Promise.all([f.responseClosed, f.socketClosed]);
      },
    );
  });

  it("propagates caller abort and retires the physical connection before teardown", async () => {
    await withRouter(
      route,
      (response) => {
        response.setHeader("Content-Type", "application/x-ndjson");
        response.write('{"message":{"role":"assistant","content":"first"},"done":false}\n');
      },
      async (f) => {
        const { model, stream } = await f.discover();
        if (!model) {
          throw new Error("Missing selected model");
        }
        const controller = new AbortController();
        const output = await stream()(model, context, {
          apiKey: KEY,
          signal: controller.signal,
          timeoutMs: 5000,
        });
        let read = false;
        for await (const event of output) {
          if (event.type === "text_delta") {
            read = true;
            controller.abort(new Error("caller stopped"));
          }
        }
        expect(read).toBe(true);
        expect(await output.result()).toMatchObject({ stopReason: "aborted", content: [] });
        expect(f.posts).toHaveLength(1);
        await Promise.all([f.responseClosed, f.socketClosed]);
      },
    );
  });

  it.each(["aborted", "missing-key"] as const)("denies %s before POST", async (failure) => {
    await withRouter(
      route,
      (response) => response.end(terminal),
      async (f) => {
        const { model, stream } = await f.discover();
        if (!model) {
          throw new Error("Missing selected model");
        }
        const controller = new AbortController();
        if (failure === "aborted") {
          controller.abort(new Error("already stopped"));
        }
        await expect(
          stream()(model, context, {
            apiKey: failure === "missing-key" ? undefined : KEY,
            signal: controller.signal,
          }),
        ).rejects.toThrow();
        expect(f.arrivals).toEqual([]);
      },
    );
  });

  it.each([
    { eligible: false },
    { modelId: "ollama/foreign" },
    { route: "https://foreign.example/api/chat" },
  ])("retains no executable model for a denied or foreign offer %j", async (changes) => {
    await withRouter(
      route,
      (response) => response.end(terminal),
      async (f) => {
        expect((await f.discover()).model).toBeUndefined();
        expect(f.arrivals).toEqual([]);
      },
      changes,
    );
  });
});
