import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { withZalouserIngressTestQueue } from "./ingress.test-support.js";
import { monitorZalouserProvider } from "./monitor.js";
import { setZalouserRuntime } from "./runtime.js";
import { loadStoredZaloCredentialsAsync, saveStoredZaloCredentials } from "./session-state.js";
import { createDefaultResolvedZalouserAccount, createZalouserRuntimeEnv } from "./test-helpers.js";
import type { API } from "./zca-client.js";

const createZaloMock = vi.hoisted(() => vi.fn());
vi.mock("./zca-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./zca-client.js")>()),
  createZalo: createZaloMock,
}));
import { logoutZaloProfile, startZaloListener } from "./zalo-js.js";

class TestListener extends EventEmitter {
  start = vi.fn(() => {});
  stop = vi.fn(() => this.emit("closed", 1000, "stopped"));
}

function sessionApi(
  listener: API["listener"],
): Pick<API, "listener" | "getContext" | "getCookie" | "getOwnId"> {
  return {
    listener,
    getContext: () => ({ imei: "fixture", userAgent: "openclaw-test" }),
    getCookie: () => ({ toJSON: () => ({ cookies: [] }) }),
    getOwnId: () => "fixture-owner",
  };
}

async function seedSession() {
  saveStoredZaloCredentials("default", {
    imei: "fixture",
    userAgent: "openclaw-test",
    cookie: [],
    createdAt: new Date().toISOString(),
  });
  expect(await loadStoredZaloCredentialsAsync("default")).not.toBeNull();
}

beforeEach(() => {
  resetPluginStateStoreForTests();
  const runtime = createPluginRuntimeMock();
  runtime.state.openKeyedStore = (options) =>
    createPluginStateKeyedStoreForTests("zalouser", options);
  runtime.state.openSyncKeyedStore = (options) =>
    createPluginStateSyncKeyedStoreForTests("zalouser", options);
  setZalouserRuntime(runtime);
  createZaloMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
});

describe("Zalo listener startup lifecycle", () => {
  it.each(["connected", "throw", "abort", "error", "message rejection"] as const)(
    "cleans up %s during start and permits another listener",
    async (event) => {
      await withZalouserIngressTestQueue(async () => {
        await seedSession();
        vi.useFakeTimers();
        const abort = new AbortController();
        const listener = new TestListener();
        const failure = new Error("start failed");
        listener.start.mockImplementation(() => {
          if (event === "connected") {
            listener.emit("connected");
          }
          if (event === "throw") {
            throw failure;
          }
          if (event === "abort") {
            abort.abort();
          }
          if (event === "error") {
            listener.emit("error", failure);
          }
          if (event === "message rejection") {
            listener.emit("message", { isSelf: false });
          }
        });
        createZaloMock.mockResolvedValue({ login: async () => sessionApi(listener) });
        const onError = vi.fn();
        try {
          const run = startZaloListener({
            accountId: "default",
            abortSignal: abort.signal,
            onMessage: vi.fn(async () => {
              throw failure;
            }),
            onError,
          });
          if (event === "throw") {
            await expect(run).rejects.toBe(failure);
          } else {
            const handle = await run;
            await vi.advanceTimersByTimeAsync(60_000);
            if (event === "error" || event === "message rejection") {
              expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
            } else {
              expect(onError).not.toHaveBeenCalled();
            }
            handle.stop();
          }
          // Storage has its own idle actor timer; retire it before asserting
          // that listener startup left no timeout or reconnect work behind.
          await closeOpenClawStateDatabaseAsync();
          expect(vi.getTimerCount()).toBe(0);
          expect(listener.eventNames()).toEqual([]);
          const next = new TestListener();
          createZaloMock.mockResolvedValue({ login: async () => sessionApi(next) });
          const handle = await startZaloListener({
            accountId: "default",
            abortSignal: new AbortController().signal,
            onMessage: vi.fn(),
            onError,
          });
          expect(next.start).toHaveBeenCalledOnce();
          handle.stop();
        } finally {
          abort.abort();
          await logoutZaloProfile();
          vi.useRealTimers();
        }
      });
    },
  );
});

it("settles a real zca-js handshake timeout and reconnects the same monitor profile", async () => {
  // Only account restoration is stubbed. zca-js, ws, TCP, listener ownership,
  // monitor settlement and durable ingress are real; no Zalo account is contacted.
  const require = createRequire(import.meta.url);
  const { Listener } = require(
    path.resolve(path.dirname(require.resolve("zca-js")), "apis/listen.cjs"),
  ) as { Listener: new (context: unknown, urls: string[]) => API["listener"] & EventEmitter };
  const { createContext } = require(
    path.resolve(path.dirname(require.resolve("zca-js")), "context.cjs"),
  ) as { createContext: () => Record<string, unknown> };
  const server = createServer();
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const sockets = new Set<Socket>();
  const trace: string[] = [];
  const connected = createDeferred<void>();
  let upgrades = 0;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    upgrades++;
    trace.push(`transport:upgrade:${upgrades}`);
    if (upgrades > 1) {
      websocketServer.handleUpgrade(request, socket, head, () => {});
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected loopback address");
  }
  const listeners: Array<API["listener"] & EventEmitter> = [];
  const abort = new AbortController();
  let second: ReturnType<typeof monitorZalouserProvider> | undefined;
  try {
    await withZalouserIngressTestQueue(async (ingressQueue) => {
      await seedSession();
      createZaloMock.mockImplementation(async () => ({
        login: async () => {
          const listener = new Listener(
            {
              ...createContext(),
              cookie: { getCookieStringSync: () => "" },
              userAgent: "openclaw-test",
              options: { logging: false, selfListen: false },
              settings: { features: { socket: { retries: {}, close_and_retry_codes: [] } } },
            },
            [`ws://127.0.0.1:${address.port}`],
          );
          listener.once("connected", (...args) => {
            expect(args).toEqual([]);
            trace.push("transport:connected");
            connected.resolve();
          });
          listeners.push(listener);
          return sessionApi(listener);
        },
      }));
      const runtime = createZalouserRuntimeEnv();
      const errors = vi.fn((...args: unknown[]) => {
        trace.push(args.map(String).join(" "));
      });
      runtime.error = errors;
      const options = {
        account: createDefaultResolvedZalouserAccount(),
        config: {},
        runtime,
        abortSignal: abort.signal,
        ingressQueue,
      };
      const started = Date.now();
      const first = monitorZalouserProvider(options);
      await expect(first).rejects.toThrow("Zalo listener websocket handshake timed out");
      trace.push("monitor:rejected");
      expect(Date.now() - started).toBeGreaterThanOrEqual(29_000);
      expect(upgrades).toBe(1);
      // Stop during CONNECTING emits ws's error on nextTick before closed.
      // There is deliberately no test error listener masking an unhandled error.
      await vi.waitFor(() => expect(listeners[0]?.listenerCount("error")).toBe(0));
      expect(errors).toHaveBeenCalledOnce();
      second = monitorZalouserProvider(options);
      await connected.promise;
      expect(upgrades).toBe(2);
      expect(listeners).toHaveLength(2);
      trace.push("monitor:retry-started");
      abort.abort();
      await second;
      await vi.waitFor(() => expect(listeners[1]?.listenerCount("error")).toBe(0));
      expect(errors).toHaveBeenCalledOnce();
      trace.push("monitor:abort-settled");
      console.log(JSON.stringify({ proof: "zca-js-2.1.2-real-transport", trace }));
    });
  } finally {
    abort.abort();
    await second?.catch(() => {});
    for (const listener of listeners) {
      listener.stop();
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      websocketServer.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}, 60_000);
