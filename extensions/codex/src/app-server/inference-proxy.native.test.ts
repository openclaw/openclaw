import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import {
  type ClientOptions,
  WebSocket,
  WebSocketServer,
} from "openclaw/plugin-sdk/websocket-runtime";
import { describe, expect, it, vi, type TestContext } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { createCodexInferenceProxy } from "./inference-proxy.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject, type CodexUserInput, type JsonObject } from "./protocol.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const transport = vi.hoisted(() => ({
  upstream: "",
  rejected: [] as { status: number; connected: boolean; threadId?: string }[],
  socketThreads: new WeakMap<object, string>(),
  closedSockets: new WeakSet<object>(),
  closedThreads: new Set<string>(),
  httpSockets: new Set<object>(),
  httpClosed: 0,
  fetch: vi.fn(),
  changed: undefined as (() => void) | undefined,
}));
vi.unmock("node:child_process");
vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  if (process.env.OPENCLAW_LIVE_CODEX_INFERENCE === "1") {
    return actual;
  }
  return {
    ...actual,
    createServer(...args: Parameters<typeof actual.createServer>) {
      const server = actual.createServer(...args);
      if (typeof args[0] === "function") {
        server.on("request", (request) => {
          if (!transport.httpSockets.has(request.socket)) {
            transport.httpSockets.add(request.socket);
            request.socket.once("close", () => {
              transport.httpClosed++;
              transport.changed?.();
            });
          }
        });
        server.on("upgrade", (request, socket) => {
          const threadId = request.headers["thread-id"];
          if (typeof threadId === "string") {
            transport.socketThreads.set(socket, threadId);
          }
          socket.once("close", () => {
            transport.closedSockets.add(socket);
            if (typeof threadId === "string") {
              transport.closedThreads.add(threadId);
            }
            transport.changed?.();
          });
          transport.changed?.();
        });
      }
      return server;
    },
  };
});
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (original) =>
  process.env.OPENCLAW_LIVE_CODEX_INFERENCE === "1"
    ? original()
    : { createNodeProxyAgent: () => undefined },
);
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (original) =>
  process.env.OPENCLAW_LIVE_CODEX_INFERENCE === "1"
    ? original()
    : {
        isBlockedHostnameOrIp: () => false,
        resolvePinnedHostnameWithPolicy: async () => ({ lookup: undefined }),
        fetchWithSsrFGuard: transport.fetch,
      },
);
vi.mock("openclaw/plugin-sdk/websocket-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/websocket-runtime")>();
  if (process.env.OPENCLAW_LIVE_CODEX_INFERENCE === "1") {
    return actual;
  }
  return {
    ...actual,
    WebSocket: class extends actual.WebSocket {
      constructor(url: string | URL, options?: ClientOptions) {
        super(String(url).startsWith("wss:") ? transport.upstream : url, options);
      }
    },
    rejectWebSocketUpgrade(...args: Parameters<typeof actual.rejectWebSocketUpgrade>) {
      transport.rejected.push({
        status: args[1].status,
        connected: !transport.closedSockets.has(args[0]),
        threadId: transport.socketThreads.get(args[0]),
      });
      actual.rejectWebSocketUpgrade(...args);
      transport.changed?.();
    },
  };
});

async function prepareNative(context: TestContext, prefix: string) {
  const tempDirs = useAutoCleanupTempDirTracker(context.onTestFinished);
  const root = await fs.realpath(tempDirs.make(prefix));
  const native = await createCodexNativeTestState(root);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("HOME", native.env.HOME);
  vi.stubEnv("CODEX_HOME", native.codexHome);
  context.onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  return native;
}

async function startNative(
  context: TestContext,
  native: Awaited<ReturnType<typeof createCodexNativeTestState>>,
) {
  const childEnv = Object.fromEntries(
    Object.entries(native.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const client = await CodexAppServerClient.start({
    transport: "stdio",
    command: native.command,
    commandSource: "config",
    args: ["app-server"],
    cwd: native.cwd,
    headers: {},
    env: childEnv,
    clearEnv: Object.keys(process.env).filter((key) => !(key in childEnv)),
  });
  context.onTestFinished(async () => {
    expect(await client.closeAndWait()).toMatchObject({ exited: true });
  });
  await client.initialize();
  expect(client.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
  return client;
}

function responseEvents(id: string, item?: JsonObject) {
  return [
    { type: "response.created", response: { id } },
    ...(item ? [{ type: "response.output_item.done", item }] : []),
    {
      type: "response.completed",
      response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    },
  ];
}

const assistantMessage = (id: string, text: string) => ({
  type: "message",
  role: "assistant",
  id,
  content: [{ type: "output_text", text }],
});

function nativeConfig(model: string, provider: string, extra: string[] = []) {
  return [
    `model=${JSON.stringify(model)}`,
    `model_provider=${JSON.stringify(provider)}`,
    'cli_auth_credentials_store="ephemeral"',
    'web_search="disabled"',
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    "allow_login_shell=false",
    "[features]",
    "shell_snapshot=false",
    ...extra,
    "[analytics]",
    "enabled=false",
    "[feedback]",
    "enabled=false",
  ];
}

function fixtureProvider(name: string, baseUrl: string, websockets: boolean) {
  return [
    `[model_providers.${websockets ? "admission" : "http"}-fixture]`,
    `name=${JSON.stringify(name)}`,
    `base_url=${JSON.stringify(baseUrl)}`,
    'wire_api="responses"',
    "requires_openai_auth=false",
    `supports_websockets=${websockets}`,
    ...(!websockets ? ["request_max_retries=1"] : []),
  ];
}

function observeTurns(client: CodexAppServerClient, changed = new EventEmitter()) {
  const started = new Map<string, string>();
  const terminals = new Map<string, string>();
  client.addNotificationHandler(({ method, params }) => {
    if (
      (method !== "turn/started" && method !== "turn/completed") ||
      !isJsonObject(params) ||
      !isJsonObject(params.turn) ||
      typeof params.threadId !== "string"
    ) {
      return;
    }
    const { id, status } = params.turn;
    if (typeof id !== "string" || typeof status !== "string") {
      return;
    }
    if (method === "turn/started") {
      started.set(params.threadId, id);
    } else if (method === "turn/completed") {
      terminals.set(params.threadId, status);
    }
    changed.emit("changed");
  });
  const waitFor = async <T>(read: () => T | undefined): Promise<T> => {
    for (;;) {
      const value = read();
      if (value !== undefined) {
        return value;
      }
      await once(changed, "changed");
    }
  };
  return {
    started,
    waitFor,
    settled: async (threadId: string, status = "completed") =>
      expect(await waitFor(() => terminals.get(threadId))).toBe(status),
  };
}

const nativeInput = (text: string): CodexUserInput[] => [{ type: "text", text, text_elements: [] }];

// One real app-server complements the deterministic admission/clock tests.
// It never reaches a provider or the operator's HOME.
describe.skipIf(process.platform === "win32")("native inference admission", () => {
  it.skipIf(process.env.OPENCLAW_LIVE_CODEX_INFERENCE === "1")(
    "loads a remote model catalog through the relay with native client version and auth",
    async (context) => {
      const native = await prepareNative(context, "codex-catalog-relay-");
      // Synthetic external ChatGPT auth: no real credentials or provider calls.
      const accessToken =
        [
          { alg: "none", typ: "JWT" },
          { "https://api.openai.com/auth": { chatgpt_account_id: "catalog-account" } },
        ]
          .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
          .join(".") + ".signature";
      const seen: string[] = [];
      transport.fetch.mockReset().mockImplementation(async (args) => {
        seen.push(args.url);
        expect(args.init).toMatchObject({
          method: "GET",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "chatgpt-account-id": "catalog-account",
          },
        });
        return {
          response: Response.json({
            models: [
              {
                slug: "relay-catalog-only",
                display_name: "Relay catalog fixture",
                description: "Only available from the test upstream",
                model_messages: { instructions_template: "Synthetic catalog fixture." },
                default_reasoning_level: "medium",
                supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
                shell_type: "shell_command",
                visibility: "list",
                supported_in_api: true,
                priority: 1,
                upgrade: null,
                support_verbosity: false,
                default_verbosity: null,
                apply_patch_tool_type: null,
                truncation_policy: { mode: "bytes", limit: 10000 },
                context_window: 1050000,
                experimental_supported_tools: [],
              },
            ],
          }),
          release: async () => {},
        };
      });
      const proxy = await createCodexInferenceProxy({
        upstream: new URL("https://chatgpt.com/backend-api/codex"),
        assertCurrent: () => {},
      });
      context.onTestFinished(() => proxy.close());
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        [
          "openai_base_url=" + JSON.stringify(proxy.baseUrl),
          ...nativeConfig("relay-catalog-only", "openai"),
        ].join("\n"),
      );
      const client = await startNative(context, native);
      await client.request("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken,
        chatgptAccountId: "catalog-account",
        chatgptPlanType: "plus",
      });
      const result = await client.request("model/list", {});
      expect(seen, client.getStderrDiagnostic()).toContain(
        "https://chatgpt.com/backend-api/codex/models?client_version=" + CODEX_APP_SERVER_VERSION,
      );
      expect(
        result.data.map((model) => model.id),
        client.getStderrDiagnostic(),
      ).toContain("relay-catalog-only");
    },
  );
  it.skipIf(process.env.OPENCLAW_LIVE_CODEX_INFERENCE === "1")(
    "starts native roots and delegated work beyond 16 active responses",
    { timeout: 90_000 },
    async (context) => {
      const native = await prepareNative(context, "codex-inference-admission-");
      const changed = new EventEmitter();
      changed.setMaxListeners(64);
      transport.upstream = "";
      transport.closedThreads.clear();
      transport.httpSockets.clear();
      transport.httpClosed = 0;
      transport.fetch.mockReset().mockRejectedValue(new Error("Unexpected native HTTP fallback"));
      transport.rejected = [];
      transport.changed = () => changed.emit("changed");
      const upstream = http.createServer();
      const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
      let disconnectNextHandshake = false;
      upstream.on("upgrade", (request, socket, head) => {
        if (disconnectNextHandshake) {
          disconnectNextHandshake = false;
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (accepted) => wss.emit("connection", accepted));
      });
      const held = new Map<string, WebSocket>();
      const metadata = new Map<string, JsonObject>();
      let responseSequence = 0;
      let parentId = "";
      let spawned = false;
      const reply = (socket: WebSocket, item?: JsonObject) => {
        const id = `synthetic-${++responseSequence}`;
        for (const event of responseEvents(id, item)) {
          socket.send(JSON.stringify(event));
        }
      };
      const finish = (threadId: string) => {
        const socket = held.get(threadId);
        assert(socket, "Fixture thread has no held response");
        held.delete(threadId);
        reply(socket, assistantMessage(`answer-${responseSequence}`, "synthetic complete"));
        changed.emit("changed");
      };
      wss.on("connection", (socket) => {
        socket.once("close", () => {
          for (const [threadId, owner] of held) {
            if (owner === socket) {
              held.delete(threadId);
            }
          }
          changed.emit("changed");
        });
        socket.on("message", (raw) => {
          assert(Buffer.isBuffer(raw), "Expected a native WebSocket text buffer");
          const body: unknown = JSON.parse(raw.toString("utf8"));
          assert(
            isJsonObject(body) && isJsonObject(body.client_metadata),
            "Native metadata missing",
          );
          const encoded = body.client_metadata["x-codex-turn-metadata"];
          assert(typeof encoded === "string", "Native turn metadata missing");
          const info: unknown = JSON.parse(encoded);
          assert(
            isJsonObject(info) && typeof info.thread_id === "string",
            "Native thread identity missing",
          );
          metadata.set(info.thread_id, info);
          if (body.generate === false) {
            reply(socket);
          } else if (info.thread_id === parentId) {
            if (!spawned) {
              spawned = true;
              reply(socket, {
                type: "function_call",
                call_id: "synthetic-spawn",
                namespace: "multi_agent_v1",
                name: "spawn_agent",
                arguments: JSON.stringify({ message: "Reply synthetic child complete." }),
              });
            } else {
              reply(socket, assistantMessage("parent-answer", "Child dispatched."));
            }
          } else {
            held.set(info.thread_id, socket);
          }
          changed.emit("changed");
        });
      });
      upstream.listen(0, "127.0.0.1");
      await once(upstream, "listening");
      const address = upstream.address();
      assert(address && typeof address !== "string", "Fixture listener missing");
      transport.upstream = `ws://127.0.0.1:${address.port}`;
      const proxy = await createCodexInferenceProxy({
        upstream: new URL("https://api.openai.com/v1"),
        assertCurrent: () => {},
      });
      context.onTestFinished(async () => {
        transport.changed = undefined;
        proxy.close();
        for (const socket of wss.clients) {
          socket.terminate();
        }
        await promisify(wss.close.bind(wss))();
        await promisify(upstream.close.bind(upstream))();
      });
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        [
          ...nativeConfig("gpt-5.5", "admission-fixture", [
            "multi_agent=true",
            "multi_agent_v2=false",
          ]),
          ...fixtureProvider("Synthetic admission provider", proxy.baseUrl, true),
          ...fixtureProvider("Synthetic HTTP provider", proxy.baseUrl, false),
        ].join("\n"),
      );
      const client = await startNative(context, native);
      const { started, waitFor, settled } = observeTurns(client, changed);
      const begin = async (parent = false, modelProvider?: string) => {
        const { thread } = await client.request("thread/start", {
          cwd: native.cwd,
          experimentalRawEvents: true,
          ...(modelProvider ? { modelProvider } : {}),
        });
        if (parent) {
          parentId = thread.id;
        }
        const controller = new AbortController();
        const registration = await proxy.context.register({
          threadId: thread.id,
          text: "synthetic root context",
          signal: controller.signal,
          assertCurrent: () => {},
        });
        const { turn } = await client.request("turn/start", {
          threadId: thread.id,
          input: nativeInput(parent ? "Delegate the task." : "Reply synthetic complete."),
          responsesapiClientMetadata: { [CODEX_INFERENCE_GENERATION_KEY]: registration.generation },
        });
        return { threadId: thread.id, turnId: turn.id, controller };
      };
      disconnectNextHandshake = true;
      const recovered = await begin();
      await waitFor(() => (held.has(recovered.threadId) ? true : undefined));
      finish(recovered.threadId);
      await settled(recovered.threadId);
      expect(transport.rejected).toContainEqual({
        status: 502,
        connected: true,
        threadId: recovered.threadId,
      });
      transport.rejected = [];
      const roots = [];
      for (let index = 0; index < 16; index++) {
        roots.push(await begin());
      }
      await waitFor(() => (held.size === 16 ? true : undefined));
      const cancelled = await begin();
      await waitFor(() => (held.has(cancelled.threadId) ? true : undefined));
      expect(held.size).toBe(17);
      expect(roots.every((rootTurn) => held.has(rootTurn.threadId))).toBe(true);
      // Native prewarm can open the socket before turn/started establishes the active turn.
      await waitFor(() =>
        started.get(cancelled.threadId) === cancelled.turnId ? true : undefined,
      );
      await client.request("turn/interrupt", {
        threadId: cancelled.threadId,
        turnId: cancelled.turnId,
      });
      await settled(cancelled.threadId, "interrupted");
      // The host releases the admitted generation when native interruption settles.
      cancelled.controller.abort();
      await waitFor(() => (transport.closedThreads.has(cancelled.threadId) ? true : undefined));
      expect(transport.rejected.some((entry) => entry.threadId === cancelled.threadId)).toBe(false);
      await waitFor(() => (!held.has(cancelled.threadId) ? true : undefined));
      const parent = await begin(true);
      const childId = await waitFor(
        () => [...metadata].find(([, info]) => info.parent_thread_id === parent.threadId)?.[0],
      );
      await waitFor(() => (held.has(childId) ? true : undefined));
      expect(held.size).toBe(17);
      const quick = await begin();
      await waitFor(() => (held.has(quick.threadId) ? true : undefined));
      expect(held.size).toBe(18);
      expect(roots.every((rootTurn) => held.has(rootTurn.threadId))).toBe(true);
      finish(childId);
      finish(quick.threadId);
      await settled(parent.threadId);
      await settled(quick.threadId);
      expect(transport.rejected).toHaveLength(0);
      for (const threadId of held.keys()) {
        finish(threadId);
      }
      for (const rootTurn of roots) {
        await settled(rootTurn.threadId);
      }
      let httpAttempts = 0;
      transport.fetch.mockImplementation(async (args) => {
        const requestBody: unknown = await new Response(args.init.body).json();
        expect(requestBody).toMatchObject({
          instructions: expect.stringContaining("synthetic root context"),
        });
        if (++httpAttempts === 1) {
          return {
            response: new Response('{"error":{"type":"server_error","message":"retry fixture"}}', {
              status: 503,
            }),
            release: async () => {},
          };
        }
        const id = "http-retry-response";
        const events = responseEvents(
          id,
          assistantMessage("http-answer", "synthetic HTTP complete"),
        );
        return {
          response: new Response(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
            {
              headers: { "content-type": "text/event-stream" },
            },
          ),
          release: async () => {},
        };
      });
      const httpTurn = await begin(false, "http-fixture");
      await settled(httpTurn.threadId);
      await waitFor(() => (transport.httpClosed === 2 ? true : undefined));
      expect(httpAttempts).toBe(2);
      expect(transport.httpSockets.size).toBe(2);
    },
  );
  it.skipIf(process.env.OPENCLAW_LIVE_CODEX_INFERENCE === "1")(
    "keeps oversized native history terminal while a bounded replacement can answer",
    { timeout: 60_000 },
    async (context) => {
      const native = await prepareNative(context, "codex-relay-size-");
      const upstreamCalls: number[] = [];
      transport.fetch.mockReset().mockImplementation(async (args) => {
        upstreamCalls.push(1);
        expect(String(args.url).endsWith("/responses")).toBe(true);
        return {
          response: new Response(
            responseEvents("bounded", assistantMessage("answer", "BOUNDED_OK"))
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          ),
          release: async () => {},
        };
      });
      const proxy = await createCodexInferenceProxy({
        upstream: new URL("https://api.openai.com/v1"),
        assertCurrent: () => {},
      });
      context.onTestFinished(() => proxy.close());
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        [
          "model_context_window=100000000",
          "model_auto_compact_token_limit=99000000",
          ...nativeConfig("gpt-5.5", "http-fixture"),
          ...fixtureProvider("Synthetic size provider", proxy.baseUrl, false),
        ].join("\n"),
      );
      const client = await startNative(context, native);
      const begin = async () => {
        const { thread } = await client.request("thread/start", { cwd: native.cwd });
        const registration = await proxy.context.register({
          threadId: thread.id,
          text: "Synthetic size recovery proof.",
          signal: new AbortController().signal,
          assertCurrent: () => {},
        });
        context.onTestFinished(() => registration.release());
        return { thread, registration };
      };
      const old = await begin();
      // The native history, not the small current request, crosses the real 32 MiB relay cap.
      for (let index = 0; index < 34; index++) {
        await client.request("thread/inject_items", {
          threadId: old.thread.id,
          items: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "x".repeat(1_000_000) }],
            },
          ],
        });
      }
      const turns = observeTurns(client);
      const start = async (entry: typeof old) => {
        await client.request("turn/start", {
          threadId: entry.thread.id,
          input: nativeInput("Reply exactly BOUNDED_OK. Do not use tools."),
          responsesapiClientMetadata: {
            [CODEX_INFERENCE_GENERATION_KEY]: entry.registration.generation,
          },
        });
      };
      await start(old);
      await turns.settled(old.thread.id, "failed");
      const failed = await client.request("thread/read", {
        threadId: old.thread.id,
        includeTurns: true,
      });
      expect(failed.thread.turns?.at(-1)?.error?.message).toContain(
        "Request exceeds the maximum size accepted by the Codex inference relay",
      );
      expect(upstreamCalls).toHaveLength(0);
      const fresh = await begin();
      await start(fresh);
      await turns.settled(fresh.thread.id);
      const answered = await client.request("thread/read", {
        threadId: fresh.thread.id,
        includeTurns: true,
      });
      expect(
        answered.thread.turns
          ?.flatMap((turn) => turn.items)
          .filter((item) => item.type === "agentMessage")
          .map((item) => item.text),
      ).toContain("BOUNDED_OK");
      expect(upstreamCalls).toHaveLength(1);
      const retained = await client.request("thread/read", {
        threadId: old.thread.id,
        includeTurns: false,
      });
      expect(retained.thread.id).toBe(old.thread.id);
    },
  );
  it.skipIf(process.env.OPENCLAW_LIVE_CODEX_INFERENCE !== "1")(
    "streams through the real relay with isolated native API-key auth",
    { timeout: 90_000 },
    async (context) => {
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required for real relay proof");
      }
      const native = await prepareNative(context, "codex-inference-live-");
      const proxy = await createCodexInferenceProxy({
        upstream: new URL("https://api.openai.com/v1"),
        assertCurrent: () => {},
      });
      context.onTestFinished(() => proxy.close());
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        nativeConfig(process.env.OPENCLAW_LIVE_CODEX_MODEL || "gpt-5.5", "openai").join("\n"),
      );
      const client = await startNative(context, native);
      await client.request("account/login/start", { type: "apiKey", apiKey });
      const { thread } = await client.request("thread/start", {
        cwd: native.cwd,
        config: { openai_base_url: proxy.baseUrl },
      });
      const controller = new AbortController();
      const registration = await proxy.context.register({
        threadId: thread.id,
        text: "Reply concisely.",
        signal: controller.signal,
        assertCurrent: () => {},
      });
      const { settled } = observeTurns(client);
      await client.request("turn/start", {
        threadId: thread.id,
        input: nativeInput("Reply exactly RELAY_OK. Do not use tools."),
        responsesapiClientMetadata: { [CODEX_INFERENCE_GENERATION_KEY]: registration.generation },
      });
      await settled(thread.id);
      const history = await client.request("thread/read", {
        threadId: thread.id,
        includeTurns: true,
      });
      const replies = (history.thread.turns ?? [])
        .flatMap((turn) => turn.items)
        .filter((item) => item.type === "agentMessage")
        .map((item) => item.text);
      expect(replies).toContain("RELAY_OK");
      registration.release();
    },
  );
});
