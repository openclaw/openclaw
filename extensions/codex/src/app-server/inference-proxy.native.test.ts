import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import {
  type ClientOptions,
  WebSocket,
  WebSocketServer,
} from "openclaw/plugin-sdk/websocket-runtime";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { createCodexInferenceProxy } from "./inference-proxy.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const transport = vi.hoisted(() => ({
  upstream: "",
  dials: 0,
  upgrades: new Set<string>(),
  rejected: [] as { status: number; connected: boolean; threadId?: string }[],
  socketThreads: new WeakMap<object, string>(),
  closedSockets: new WeakSet<object>(),
  closedThreads: new Set<string>(),
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
        server.on("upgrade", (request, socket) => {
          const threadId = request.headers["thread-id"];
          if (typeof threadId === "string") {
            transport.upgrades.add(threadId);
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
        fetchWithSsrFGuard: async () => {
          throw new Error("Native fixture unexpectedly fell back to HTTP");
        },
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
        transport.dials++;
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

// Native proof complements the deterministic queue/clock tests. It deliberately
// spans the relay's real handshake deadline so the pinned native connect/retry
// contract is exercised; it never reaches a provider or the operator's HOME.
describe.skipIf(process.platform === "win32")("native inference admission", () => {
  it.skipIf(process.env.OPENCLAW_LIVE_CODEX_INFERENCE === "1")(
    "keeps native roots and delegated work progressing across saturation and cancellation",
    { timeout: 90_000 },
    async (context) => {
      const tempDirs = useAutoCleanupTempDirTracker(context.onTestFinished);
      const root = await fs.realpath(tempDirs.make("codex-inference-admission-"));
      const native = await createCodexNativeTestState(root);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      vi.stubEnv("HOME", native.env.HOME);
      vi.stubEnv("CODEX_HOME", native.codexHome);
      context.onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const changed = new EventEmitter();
      changed.setMaxListeners(64);
      transport.upstream = "";
      transport.dials = 0;
      transport.upgrades.clear();
      transport.closedThreads.clear();
      transport.rejected = [];
      transport.changed = () => changed.emit("changed");
      const waitFor = <T>(read: () => T | undefined): Promise<T> => {
        const value = read();
        if (value !== undefined) {
          return Promise.resolve(value);
        }
        return new Promise((resolve) => {
          const check = () => {
            const next = read();
            if (next === undefined) {
              return;
            }
            changed.off("changed", check);
            resolve(next);
          };
          changed.on("changed", check);
          check();
        });
      };
      const upstream = http.createServer();
      const wss = new WebSocketServer({ server: upstream });
      const held = new Map<string, WebSocket>();
      const metadata = new Map<string, JsonObject>();
      let responseSequence = 0;
      let parentId = "";
      let spawned = false;
      const reply = (socket: WebSocket, item?: JsonObject) => {
        const id = `synthetic-${++responseSequence}`;
        socket.send(JSON.stringify({ type: "response.created", response: { id } }));
        if (item) {
          socket.send(JSON.stringify({ type: "response.output_item.done", item }));
        }
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
          }),
        );
      };
      const finish = (threadId: string) => {
        const socket = held.get(threadId);
        if (!socket) {
          throw new Error("Fixture thread has no held response");
        }
        held.delete(threadId);
        reply(socket, {
          type: "message",
          role: "assistant",
          id: `answer-${responseSequence}`,
          content: [{ type: "output_text", text: "synthetic complete" }],
        });
        changed.emit("changed");
      };
      wss.on("connection", (socket) =>
        socket.on("message", (raw) => {
          if (!Buffer.isBuffer(raw)) {
            throw new Error("Expected a native WebSocket text buffer");
          }
          const body: unknown = JSON.parse(raw.toString("utf8"));
          if (!isJsonObject(body) || !isJsonObject(body.client_metadata)) {
            throw new Error("Native metadata missing");
          }
          const encoded = body.client_metadata["x-codex-turn-metadata"];
          if (typeof encoded !== "string") {
            throw new Error("Native turn metadata missing");
          }
          const info: unknown = JSON.parse(encoded);
          if (!isJsonObject(info) || typeof info.thread_id !== "string") {
            throw new Error("Native thread identity missing");
          }
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
              reply(socket, {
                type: "message",
                role: "assistant",
                id: "parent-answer",
                content: [{ type: "output_text", text: "Child dispatched." }],
              });
            }
          } else {
            held.set(info.thread_id, socket);
          }
          changed.emit("changed");
        }),
      );
      await new Promise<void>((resolve) => {
        upstream.listen(0, "127.0.0.1", resolve);
      });
      const address = upstream.address();
      if (!address || typeof address === "string") {
        throw new Error("Fixture listener missing");
      }
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
        await new Promise<void>((resolve) => {
          wss.close(() => resolve());
        });
        await new Promise<void>((resolve) => {
          upstream.close(() => resolve());
        });
      });
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        [
          'model="gpt-5.5"',
          'model_provider="admission-fixture"',
          'cli_auth_credentials_store="ephemeral"',
          'web_search="disabled"',
          'approval_policy="never"',
          'sandbox_mode="read-only"',
          "allow_login_shell=false",
          "[features]",
          "shell_snapshot=false",
          "multi_agent=true",
          "multi_agent_v2=false",
          "[analytics]",
          "enabled=false",
          "[feedback]",
          "enabled=false",
          "[model_providers.admission-fixture]",
          'name="Synthetic admission provider"',
          `base_url=${JSON.stringify(proxy.baseUrl)}`,
          'wire_api="responses"',
          "requires_openai_auth=false",
          "supports_websockets=true",
        ].join("\n"),
      );
      const childEnv = Object.fromEntries(
        Object.entries(native.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
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
      const terminals = new Map<string, string>();
      client.addNotificationHandler((event) => {
        if (
          event.method !== "turn/completed" ||
          !isJsonObject(event.params) ||
          typeof event.params.threadId !== "string" ||
          !isJsonObject(event.params.turn) ||
          typeof event.params.turn.status !== "string"
        ) {
          return;
        }
        terminals.set(event.params.threadId, event.params.turn.status);
        changed.emit("changed");
      });
      const begin = async (parent = false) => {
        const { thread } = await client.request("thread/start", {
          cwd: native.cwd,
          experimentalRawEvents: true,
        });
        if (parent) {
          parentId = thread.id;
        }
        const controller = new AbortController();
        const registration = proxy.context.register({
          threadId: thread.id,
          text: "synthetic root context",
          signal: controller.signal,
          assertCurrent: () => {},
        });
        const { turn } = await client.request("turn/start", {
          threadId: thread.id,
          input: [
            {
              type: "text",
              text: parent ? "Delegate the task." : "Reply synthetic complete.",
              text_elements: [],
            },
          ],
          responsesapiClientMetadata: { [CODEX_INFERENCE_GENERATION_KEY]: registration.generation },
        });
        return { threadId: thread.id, turnId: turn.id, controller };
      };
      const roots = [];
      for (let index = 0; index < 16; index++) {
        roots.push(await begin());
      }
      await waitFor(() => (held.size === 16 ? true : undefined));
      const activeDials = transport.dials;
      const cancelled = await begin();
      await waitFor(() => (transport.upgrades.has(cancelled.threadId) ? true : undefined));
      await client.request("turn/interrupt", {
        threadId: cancelled.threadId,
        turnId: cancelled.turnId,
      });
      expect(await waitFor(() => terminals.get(cancelled.threadId))).toBe("interrupted");
      await waitFor(() => (transport.closedThreads.has(cancelled.threadId) ? true : undefined));
      expect(transport.rejected.some((entry) => entry.threadId === cancelled.threadId)).toBe(false);
      expect(transport.dials).toBe(activeDials);
      expect(held.has(cancelled.threadId)).toBe(false);
      const waiting = await begin();
      const rejection = await waitFor(() =>
        transport.rejected.find((entry) => entry.threadId === waiting.threadId),
      );
      expect(rejection).toMatchObject({ status: 503, connected: true });
      expect(transport.dials).toBe(activeDials);
      expect(terminals.has(waiting.threadId)).toBe(false);
      finish(roots[0]!.threadId);
      await waitFor(() => (held.has(waiting.threadId) ? true : undefined));
      finish(waiting.threadId);
      expect(await waitFor(() => terminals.get(waiting.threadId))).toBe("completed");
      expect(held.size).toBe(15);
      const parent = await begin(true);
      const childId = await waitFor(
        () => [...metadata].find(([, info]) => info.parent_thread_id === parent.threadId)?.[0],
      );
      await waitFor(() => (held.has(childId) ? true : undefined));
      expect(held.size).toBe(16);
      const quick = await begin();
      await waitFor(() => (transport.upgrades.has(quick.threadId) ? true : undefined));
      const rejectedBeforeDrain = transport.rejected.length;
      finish(childId);
      await waitFor(() => (held.has(quick.threadId) ? true : undefined));
      finish(quick.threadId);
      // Child and queued root may run before the parent's follow-up request.
      expect(await waitFor(() => terminals.get(parent.threadId))).toBe("completed");
      expect(await waitFor(() => terminals.get(quick.threadId))).toBe("completed");
      expect(transport.rejected).toHaveLength(rejectedBeforeDrain);
      for (const threadId of held.keys()) {
        finish(threadId);
      }
      for (const rootTurn of roots) {
        expect(await waitFor(() => terminals.get(rootTurn.threadId))).toBe("completed");
      }
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
      const tempDirs = useAutoCleanupTempDirTracker(context.onTestFinished);
      const root = await fs.realpath(tempDirs.make("codex-inference-live-"));
      const native = await createCodexNativeTestState(root);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      vi.stubEnv("HOME", native.env.HOME);
      vi.stubEnv("CODEX_HOME", native.codexHome);
      context.onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const proxy = await createCodexInferenceProxy({
        upstream: new URL("https://api.openai.com/v1"),
        assertCurrent: () => {},
      });
      context.onTestFinished(() => proxy.close());
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        [
          `model=${JSON.stringify(process.env.OPENCLAW_LIVE_CODEX_MODEL || "gpt-5.5")}`,
          'model_provider="openai"',
          'cli_auth_credentials_store="ephemeral"',
          'web_search="disabled"',
          'approval_policy="never"',
          'sandbox_mode="read-only"',
          "allow_login_shell=false",
          "[features]",
          "shell_snapshot=false",
          "[analytics]",
          "enabled=false",
          "[feedback]",
          "enabled=false",
        ].join("\n"),
      );
      const childEnv = Object.fromEntries(
        Object.entries(native.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
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
      await client.request("account/login/start", { type: "apiKey", apiKey });
      const { thread } = await client.request("thread/start", {
        cwd: native.cwd,
        config: { openai_base_url: proxy.baseUrl },
      });
      const controller = new AbortController();
      const registration = proxy.context.register({
        threadId: thread.id,
        text: "Reply concisely.",
        signal: controller.signal,
        assertCurrent: () => {},
      });
      const completed = new Promise<string>((resolve) => {
        client.addNotificationHandler((event) => {
          if (
            event.method === "turn/completed" &&
            isJsonObject(event.params) &&
            event.params.threadId === thread.id &&
            isJsonObject(event.params.turn) &&
            typeof event.params.turn.status === "string"
          ) {
            resolve(event.params.turn.status);
          }
        });
      });
      await client.request("turn/start", {
        threadId: thread.id,
        input: [
          { type: "text", text: "Reply exactly RELAY_OK. Do not use tools.", text_elements: [] },
        ],
        responsesapiClientMetadata: { [CODEX_INFERENCE_GENERATION_KEY]: registration.generation },
      });
      expect(await completed).toBe("completed");
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
