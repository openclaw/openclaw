import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type {
  DeviceAuthTokenRecord,
  GatewayClient as GatewayClientInstance,
  GatewayClientHostDeps,
  GatewayClientOptions,
} from "./client.js";

class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  readonly send = vi.fn<(data: string) => void>();

  constructor() {
    super();
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
    this.receive({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "synthetic-nonce", ts: 1_800_000_000_000 },
    });
  }

  receive(frame: unknown) {
    this.emit("message", JSON.stringify(frame));
  }

  respond(payload: unknown, error?: unknown) {
    const sent = this.send.mock.calls[0];
    assert(sent);
    const { id } = JSON.parse(sent[0]) as { id: string };
    this.receive({ type: "res", id, ok: !error, payload, error });
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate() {
    this.close();
  }
}

vi.mock("./websocket.js", () => ({ WebSocket: MockWebSocket }));
let GatewayClient: typeof GatewayClientInstance;
const clients: GatewayClientInstance[] = [];
const releaseStorage: Array<() => void> = [];

function storageGate() {
  const deferred = createDeferred();
  releaseStorage.push(deferred.resolve);
  return deferred;
}

beforeAll(async () => {
  ({ GatewayClient } = await import("./client.js"));
});
beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.useFakeTimers();
  MockWebSocket.instances = [];
});
afterEach(async () => {
  for (const release of releaseStorage.splice(0)) {
    release();
  }
  for (const client of clients.splice(0)) {
    await client.stopAndWait();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function connect(
  hostDeps: GatewayClientHostDeps,
  options: Pick<
    GatewayClientOptions,
    "preferBootstrapToken" | "bootstrapToken" | "token" | "password"
  > = {},
  reportError?: ((error: Error) => void) | false,
) {
  const onHelloOk = vi.fn();
  const onConnectError = vi.fn((error: Error) => {
    if (reportError) {
      reportError(error);
    }
  });
  const onClose = vi.fn();
  const onReconnectPaused = vi.fn();
  const client = new GatewayClient({
    ...options,
    url: "ws://127.0.0.1:18789",
    deviceIdentity: {
      deviceId: "synthetic-device",
      privateKeyPem: "synthetic-private-key",
      publicKeyPem: "synthetic-public-key",
    },
    hostDeps: {
      signDevicePayload: () => "synthetic-signature",
      publicKeyRawBase64UrlFromPem: () => "synthetic-public-key",
      loadDeviceAuthToken: () => storedToken,
      ...hostDeps,
    },
    onHelloOk,
    onConnectError: reportError === false ? undefined : onConnectError,
    onClose,
    onReconnectPaused,
  });
  clients.push(client);
  client.start();
  const socket = MockWebSocket.instances[0];
  assert(socket);
  socket.open();
  return { client, socket, onHelloOk, onConnectError, onClose, onReconnectPaused };
}

const storedToken = { token: "synthetic-stored-token", scopes: ["operator.read"] };
const hello = {
  type: "hello-ok",
  protocol: 4,
  auth: { deviceToken: "synthetic-issued-token", role: "operator", scopes: ["operator.read"] },
};

describe("GatewayClient host token storage", () => {
  it.each([false, true])("settles pending token loading (stopped: %s)", async (stop) => {
    const loaded = createDeferred<DeviceAuthTokenRecord | null>();
    const { client, socket, onHelloOk } = connect({ loadDeviceAuthToken: () => loaded.promise });
    expect(socket.send).not.toHaveBeenCalled();
    const stopped = stop ? client.stopAndWait() : undefined;
    loaded.resolve(storedToken);
    if (stopped) {
      await stopped;
    }
    await vi.advanceTimersByTimeAsync(0);
    if (stop) {
      expect(socket.send).not.toHaveBeenCalled();
      expect(onHelloOk).not.toHaveBeenCalled();
      return;
    }
    const sent = socket.send.mock.calls[0];
    assert(sent);
    expect(JSON.parse(sent[0])).toMatchObject({
      method: "connect",
      params: { auth: { deviceToken: storedToken.token }, scopes: storedToken.scopes },
    });
  });

  it.each(["sync", "ready", "closing", "stop"] as const)(
    "settles token persistence before completing %s",
    async (completion) => {
      const stored = storageGate();
      let persistedToken: string | undefined;
      const storeDeviceAuthToken = vi.fn<
        NonNullable<GatewayClientHostDeps["storeDeviceAuthToken"]>
      >(async (params) => {
        await stored.promise;
        params.signal?.throwIfAborted();
        params.assertCurrent?.();
        persistedToken = params.token;
      });
      const { client, socket, onHelloOk, onConnectError } = connect(
        completion === "sync"
          ? { storeDeviceAuthToken: () => storedToken, clearDeviceAuthToken: () => true }
          : { storeDeviceAuthToken },
      );
      if (completion === "sync") {
        expect(socket.send).toHaveBeenCalledOnce();
      }
      socket.respond(hello);
      await vi.advanceTimersByTimeAsync(0);
      if (completion === "sync") {
        expect(onHelloOk).toHaveBeenCalledOnce();
        return;
      }
      expect(onHelloOk).not.toHaveBeenCalled();
      expect(storeDeviceAuthToken).toHaveBeenCalledOnce();
      const operation = storeDeviceAuthToken.mock.calls[0]?.[0];
      assert(operation);
      expect(operation).toMatchObject({ token: hello.auth.deviceToken, scopes: hello.auth.scopes });
      expect(() => operation.assertCurrent?.()).not.toThrow();
      if (completion === "closing") {
        socket.readyState = 2;
      }
      const stopped = vi.fn();
      const stop = completion === "stop" ? client.stopAndWait().then(stopped) : undefined;
      if (completion === "stop") {
        expect(operation.signal).toBeUndefined();
        expect(operation.assertCurrent).toBeUndefined();
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).not.toHaveBeenCalled();
      }
      stored.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await stop;
      expect(persistedToken).toBe(hello.auth.deviceToken);
      expect(onConnectError).not.toHaveBeenCalled();
      expect(onHelloOk).toHaveBeenCalledTimes(completion === "ready" ? 1 : 0);
    },
  );

  it("reconnects with the durable receipt after bootstrap hello's transport retires", async () => {
    const permitStore = storageGate();
    let cached: DeviceAuthTokenRecord | null = null;
    const { socket, onHelloOk } = connect(
      {
        loadDeviceAuthToken: () => cached,
        storeDeviceAuthToken: async (params) => {
          await permitStore.promise;
          params.signal?.throwIfAborted();
          params.assertCurrent?.();
          cached = { token: params.token, scopes: params.scopes };
        },
      },
      { bootstrapToken: "synthetic-bootstrap", preferBootstrapToken: true },
    );
    socket.respond(hello);
    await vi.advanceTimersByTimeAsync(0);
    socket.close(1006, "transport retired");
    await vi.advanceTimersByTimeAsync(1_000);
    const replacement = MockWebSocket.instances[1];
    assert(replacement);
    replacement.open();
    expect(replacement.send).not.toHaveBeenCalled();
    permitStore.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const sent = replacement.send.mock.calls[0];
    assert(sent);
    expect(JSON.parse(sent[0])).toMatchObject({
      method: "connect",
      params: { auth: { deviceToken: hello.auth.deviceToken } },
    });
    expect(JSON.parse(sent[0]).params.auth.bootstrapToken).toBeUndefined();
    expect(onHelloOk).not.toHaveBeenCalled();
  });

  it("keeps a newer token after observing an empty cache", async () => {
    let cached: DeviceAuthTokenRecord | null = null;
    const newer = { token: "synthetic-newer-token", scopes: ["operator.read"] };
    const clearDeviceAuthToken = vi.fn<NonNullable<GatewayClientHostDeps["clearDeviceAuthToken"]>>(
      (params) => {
        if (params.expectedToken === undefined || params.expectedToken === cached?.token) {
          cached = null;
        }
      },
    );
    const { client, socket } = connect({
      loadDeviceAuthToken: () => Promise.resolve(cached),
      clearDeviceAuthToken,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.send).toHaveBeenCalledOnce();
    cached = newer;
    socket.close(1008, "device token mismatch");
    await client.stopAndWait();
    expect(clearDeviceAuthToken).not.toHaveBeenCalled();
    expect(cached).toEqual(newer);
  });

  it.each([
    { initial: storedToken, result: "committed", replaceWithNewer: false, bootstrap: true },
    { initial: storedToken, result: "committed", replaceWithNewer: true },
    { initial: null, result: "committed", replaceWithNewer: true },
    { initial: storedToken, result: "uncertain", replaceWithNewer: false },
    { initial: null, result: "uncertain", replaceWithNewer: false },
    { initial: null, result: "failed", replaceWithNewer: true },
  ] as const)("reconciles mismatch cleanup against the accepted receipt: %j", async (entry) => {
    const { initial, result, replaceWithNewer } = entry;
    const permitStore = storageGate();
    let cached: DeviceAuthTokenRecord | null = initial;
    const newer = { token: "synthetic-newer-token", scopes: ["operator.read"] };
    const clearDeviceAuthToken = vi.fn<NonNullable<GatewayClientHostDeps["clearDeviceAuthToken"]>>(
      (params) => {
        params.assertCurrent?.();
        if (params.expectedToken === undefined || params.expectedToken === cached?.token) {
          cached = null;
        }
      },
    );
    const { socket, onHelloOk } = connect(
      {
        loadDeviceAuthToken: () => cached,
        storeDeviceAuthToken: async (params) => {
          await permitStore.promise;
          params.signal?.throwIfAborted();
          params.assertCurrent?.();
          if (result === "failed") {
            throw new Error("synthetic persistence rejected");
          }
          if (
            params.expectedToken === undefined ||
            (params.expectedToken === null
              ? cached === null
              : params.expectedToken === cached?.token)
          ) {
            cached = { token: params.token, scopes: params.scopes };
          }
          if (result === "uncertain") {
            throw new Error("synthetic result unavailable");
          }
        },
        clearDeviceAuthToken,
      },
      "bootstrap" in entry
        ? {
            preferBootstrapToken: true,
            bootstrapToken: "synthetic-bootstrap",
            token: "synthetic-shared-token",
            password: "synthetic-shared-password",
          }
        : {},
    );
    socket.respond(hello);
    await vi.advanceTimersByTimeAsync(0);
    socket.close(1008, "device token mismatch");
    expect(clearDeviceAuthToken).not.toHaveBeenCalled();
    if (replaceWithNewer) {
      cached = newer;
    }
    permitStore.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(clearDeviceAuthToken).toHaveBeenCalled();
    expect(
      clearDeviceAuthToken.mock.calls.every(([params]) => params.expectedToken !== undefined),
    ).toBe(true);
    expect(cached).toEqual(replaceWithNewer ? newer : null);
    expect(onHelloOk).not.toHaveBeenCalled();
  });

  it.each([
    { storage: "sync", lifetime: "active", reporter: "reported" },
    { storage: "async", lifetime: "active", reporter: "reported" },
    { storage: "async", lifetime: "disconnected", reporter: "reported" },
    { storage: "async", lifetime: "stopped", reporter: "reported" },
    { storage: "async", lifetime: "disconnected", reporter: "missing" },
    { storage: "async", lifetime: "stopped", reporter: "throwing" },
  ] as const)(
    "preserves $storage storage errors when $lifetime with a $reporter reporter",
    async ({ storage, lifetime, reporter }) => {
      const permitStore = storageGate();
      const failure = new Error(`synthetic ${storage} persistence failure`);
      const { client, socket, onConnectError } = connect(
        {
          storeDeviceAuthToken:
            storage === "sync"
              ? () => {
                  throw failure;
                }
              : async () => {
                  await permitStore.promise;
                  throw failure;
                },
        },
        {},
        reporter === "missing"
          ? false
          : reporter === "throwing"
            ? () => {
                throw new Error("synthetic reporter failure");
              }
            : undefined,
      );
      socket.respond(hello);
      await vi.advanceTimersByTimeAsync(0);
      if (storage === "sync") {
        expect(onConnectError).toHaveBeenCalledOnce();
        await expect(client.stopAndWait()).resolves.toBeUndefined();
        return;
      }
      if (lifetime === "disconnected") {
        socket.close(1006, "transport retired");
      }
      const stopped =
        lifetime === "stopped"
          ? reporter === "throwing"
            ? expect(client.stopAndWait()).rejects.toBe(failure)
            : client.stopAndWait()
          : undefined;
      permitStore.resolve();
      await vi.advanceTimersByTimeAsync(reporter === "missing" ? 1_000 : 0);
      if (reporter === "missing") {
        const replacement = MockWebSocket.instances[1];
        assert(replacement);
        replacement.open();
        expect(replacement.send).toHaveBeenCalledOnce();
        await expect(client.stopAndWait()).rejects.toBe(failure);
      } else {
        await stopped;
        if (reporter === "reported") {
          expect(onConnectError).toHaveBeenCalledExactlyOnceWith(failure);
        }
      }
    },
  );

  it.each([false, true])(
    "preserves rejection and cleanup when the peer closes (already closing: %s)",
    async (alreadyClosing) => {
      const cleared = storageGate();
      const clearDeviceAuthToken = vi.fn<
        NonNullable<GatewayClientHostDeps["clearDeviceAuthToken"]>
      >(() => cleared.promise);
      const { socket, onConnectError, onClose, onReconnectPaused } = connect({
        clearDeviceAuthToken,
      });
      socket.respond(undefined, {
        code: "INVALID_REQUEST",
        message: "synthetic token rejected",
        details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
      });
      if (alreadyClosing) {
        socket.readyState = 2;
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(clearDeviceAuthToken).toHaveBeenCalledWith(
        expect.objectContaining({ expectedToken: storedToken.token }),
      );
      expect(onConnectError).toHaveBeenCalledOnce();
      const error = onConnectError.mock.calls[0]?.[0];
      expect(error).toMatchObject({ message: "synthetic token rejected" });
      socket.close(1008, "connect failed");
      const cleanup = clearDeviceAuthToken.mock.calls[0]?.[0];
      assert(cleanup);
      expect(() => cleanup.assertCurrent?.()).not.toThrow();
      expect(onClose).toHaveBeenCalledWith(
        1008,
        "connect failed",
        expect.objectContaining({ connectError: error }),
      );
      expect(onReconnectPaused).toHaveBeenCalledWith(
        expect.objectContaining({ detailCode: "AUTH_DEVICE_TOKEN_MISMATCH" }),
      );
      cleared.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onConnectError).toHaveBeenCalledOnce();
      expect(MockWebSocket.instances).toHaveLength(1);
    },
  );

  it("finishes close cleanup before loading credentials for the replacement connection", async () => {
    const cleared = storageGate();
    const loadDeviceAuthToken = vi.fn(() => storedToken);
    const clearDeviceAuthToken = vi.fn<NonNullable<GatewayClientHostDeps["clearDeviceAuthToken"]>>(
      () => cleared.promise,
    );
    const { socket } = connect({ loadDeviceAuthToken, clearDeviceAuthToken });
    socket.close(1008, "device token mismatch");
    const cleanup = clearDeviceAuthToken.mock.calls[0]?.[0];
    assert(cleanup);
    expect(cleanup.expectedToken).toBe(storedToken.token);
    expect(() => cleanup.assertCurrent?.()).not.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    const replacement = MockWebSocket.instances[1];
    assert(replacement);
    replacement.open();
    expect(loadDeviceAuthToken).toHaveBeenCalledOnce();
    cleared.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(loadDeviceAuthToken).toHaveBeenCalledTimes(2);
    expect(replacement.send).toHaveBeenCalledOnce();
  });
});
