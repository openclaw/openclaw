import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
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
    return this;
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
type ClearToken = NonNullable<GatewayClientHostDeps["clearDeviceAuthToken"]>;
type StoreToken = NonNullable<GatewayClientHostDeps["storeDeviceAuthToken"]>;

function storageGate() {
  const deferred = createDeferred();
  releaseStorage.push(deferred.resolve);
  return deferred;
}

async function reconnectSocket() {
  await vi.advanceTimersByTimeAsync(1_000);
  const socket = MockWebSocket.instances[1];
  assert(socket);
  return socket.open();
}

function tokenStorage(initial: DeviceAuthTokenRecord | null = storedToken) {
  const gate = storageGate();
  const cache: { value: DeviceAuthTokenRecord | null; failure?: Error } = { value: initial };
  const host = {
    loadDeviceAuthToken: vi.fn(() => cache.value),
    clearDeviceAuthToken: vi.fn<ClearToken>((params) => {
      params.assertCurrent?.();
      if (params.expectedToken === undefined || params.expectedToken === cache.value?.token) {
        cache.value = null;
      }
    }),
    storeDeviceAuthToken: vi.fn<StoreToken>(async (params) => {
      await gate.promise;
      params.signal?.throwIfAborted();
      params.assertCurrent?.();
      if (
        params.expectedToken === undefined ||
        params.expectedToken === (cache.value?.token ?? null)
      ) {
        cache.value = { token: params.token, scopes: params.scopes };
      }
      if (cache.failure) {
        throw cache.failure;
      }
    }),
  };
  return { cache, gate, host };
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
    "preferBootstrapToken" | "bootstrapToken" | "token" | "password" | "assertConnectionCurrent"
  > = {},
  reportError?: ((error: Error) => void) | false,
) {
  const observers = {
    onHelloOk: vi.fn(),
    onConnectError: vi.fn<(error: Error) => void>(
      typeof reportError === "function" ? reportError : undefined,
    ),
    onClose: vi.fn(),
    onReconnectPaused: vi.fn(),
  };
  const client = new GatewayClient({
    ...observers,
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
    onConnectError: reportError === false ? undefined : observers.onConnectError,
  });
  clients.push(client);
  client.start();
  const socket = MockWebSocket.instances[0];
  assert(socket);
  socket.open();
  return { client, socket, ...observers };
}

const storedToken = { token: "synthetic-stored-token", scopes: ["operator.read"] };
const hello = {
  type: "hello-ok",
  protocol: PROTOCOL_VERSION,
  auth: { deviceToken: "synthetic-issued-token", role: "operator", scopes: ["operator.read"] },
};

describe("GatewayClient host token storage", () => {
  it("rejects connection authority retired by socket registration and cleans the registration", () => {
    const failure = new Error("connection owner retired");
    const onConnectError = vi.fn();
    const cleanup = vi.fn();
    let current = true;
    const client = new GatewayClient({
      url: "wss://gateway.example.invalid",
      edgeAuthHeaders: { Authorization: "synthetic-edge-token" },
      assertConnectionCurrent() {
        if (!current) {
          throw failure;
        }
      },
      onConnectError,
      hostDeps: {
        registerGatewayLoopbackBypass() {
          current = false;
          return cleanup;
        },
      },
    });
    clients.push(client);
    expect(() => client.start()).toThrow(failure.message);
    expect(MockWebSocket.instances).toEqual([]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onConnectError).toHaveBeenCalledWith(
      expect.objectContaining({ message: failure.message }),
    );
  });

  it("rejects connection authority retired during asynchronous token loading", async () => {
    const loaded = createDeferred<DeviceAuthTokenRecord | null>();
    let current = true;
    const failure = new Error("connection owner retired");
    const { socket, onHelloOk, onConnectError } = connect(
      { loadDeviceAuthToken: () => loaded.promise },
      {
        assertConnectionCurrent() {
          if (!current) {
            throw failure;
          }
        },
      },
    );
    expect(socket.send).not.toHaveBeenCalled();
    current = false;
    loaded.resolve(storedToken);
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.send).not.toHaveBeenCalled();
    expect(onHelloOk).not.toHaveBeenCalled();
    expect(onConnectError).toHaveBeenCalledWith(
      expect.objectContaining({ message: String(failure) }),
    );
  });

  it("rejects a correlated startup retry after connection authority retires", async () => {
    let current = true;
    const failure = new Error("connection owner retired");
    const { client, socket } = connect(
      {},
      {
        assertConnectionCurrent() {
          if (!current) {
            throw failure;
          }
        },
      },
    );
    socket.respond({ type: "hello-ok", protocol: PROTOCOL_VERSION });
    await vi.advanceTimersByTimeAsync(0);
    const request = client.request("sessions.create", {}, { timeoutMs: 1_000 });
    const outcome = request.catch((error: unknown) => error);
    const sent = socket.send.mock.calls.at(-1);
    assert(sent);
    const frame = JSON.parse(sent[0]) as { id: string; method: string };
    expect(frame.method).toBe("sessions.create");
    socket.receive({
      type: "res",
      id: frame.id,
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "agent is preparing",
        retryable: true,
        retryAfterMs: 250,
        details: { reason: "startup-sidecars", method: frame.method },
      },
    });
    current = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(socket.send.mock.calls.map(([data]) => JSON.parse(data).method)).toEqual([
      "connect",
      "sessions.create",
    ]);
    expect(await outcome).toBe(failure);
  });

  it("settles pending token loading after stop", async () => {
    const loaded = createDeferred<DeviceAuthTokenRecord | null>();
    const { client, socket, onHelloOk } = connect({ loadDeviceAuthToken: () => loaded.promise });
    expect(socket.send).not.toHaveBeenCalled();
    const stopped = client.stopAndWait();
    loaded.resolve(storedToken);
    await stopped;
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.send).not.toHaveBeenCalled();
    expect(onHelloOk).not.toHaveBeenCalled();
  });

  it.each(["sync", "ready", "closing", "stop"] as const)(
    "settles token persistence before completing %s",
    async (completion) => {
      const { gate, cache, host } = tokenStorage();
      const { storeDeviceAuthToken } = host;
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
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await stop;
      expect(cache.value?.token).toBe(hello.auth.deviceToken);
      expect(onConnectError).not.toHaveBeenCalled();
      expect(onHelloOk).toHaveBeenCalledTimes(completion === "ready" ? 1 : 0);
    },
  );

  it("reconnects with the durable receipt after bootstrap hello's transport retires", async () => {
    const { gate, host } = tokenStorage(null);
    const { socket, onHelloOk } = connect(host, {
      bootstrapToken: "synthetic-bootstrap",
      preferBootstrapToken: true,
    });
    socket.respond(hello);
    await vi.advanceTimersByTimeAsync(0);
    socket.close(1006, "transport retired");
    const replacement = await reconnectSocket();
    expect(replacement.send).not.toHaveBeenCalled();
    gate.resolve();
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
    const { cache, host } = tokenStorage(null);
    const newer = { token: "synthetic-newer-token", scopes: ["operator.read"] };
    const { client, socket } = connect({
      ...host,
      loadDeviceAuthToken: () => Promise.resolve(cache.value),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.send).toHaveBeenCalledOnce();
    cache.value = newer;
    socket.close(1008, "device token mismatch");
    await client.stopAndWait();
    expect(host.clearDeviceAuthToken).not.toHaveBeenCalled();
    expect(cache.value).toEqual(newer);
  });

  it.each([
    { initial: storedToken, result: "committed", replaceWithNewer: false, bootstrap: true },
    { initial: storedToken, result: "committed", replaceWithNewer: true },
    { initial: null, result: "uncertain", replaceWithNewer: false },
  ] as const)("reconciles mismatch cleanup against the accepted receipt: %j", async (entry) => {
    const { initial, result, replaceWithNewer } = entry;
    const { gate, cache, host } = tokenStorage(initial);
    const { clearDeviceAuthToken } = host;
    const newer = { token: "synthetic-newer-token", scopes: ["operator.read"] };
    cache.failure = result === "uncertain" ? new Error("synthetic result unavailable") : undefined;
    const { socket, onHelloOk } = connect(
      host,
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
      cache.value = newer;
    }
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(clearDeviceAuthToken).toHaveBeenCalled();
    expect(
      clearDeviceAuthToken.mock.calls.every(([params]) => params.expectedToken !== undefined),
    ).toBe(true);
    expect(cache.value).toEqual(replaceWithNewer ? newer : null);
    expect(onHelloOk).not.toHaveBeenCalled();
  });

  it.each([
    { storage: "sync", lifetime: "active", reporter: "reported" },
    { storage: "async", lifetime: "active", reporter: "reported" },
    { storage: "async", lifetime: "disconnected", reporter: "reported" },
    { storage: "async", lifetime: "disconnected", reporter: "missing" },
    { storage: "async", lifetime: "stopped", reporter: "throwing" },
  ] as const)(
    "preserves $storage storage errors when $lifetime with a $reporter reporter",
    async ({ storage, lifetime, reporter }) => {
      const permitStore = storageGate();
      const failure = new Error(`synthetic ${storage} persistence failure`);
      const fail = () => {
        throw failure;
      };
      const failReporter = () => {
        throw new Error("synthetic reporter failure");
      };
      const storeDeviceAuthToken = storage === "sync" ? fail : () => permitStore.promise.then(fail);
      const observer =
        reporter === "missing" ? false : reporter === "throwing" ? failReporter : undefined;
      const { client, socket, onConnectError } = connect({ storeDeviceAuthToken }, {}, observer);
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
        lifetime === "stopped" ? expect(client.stopAndWait()).rejects.toBe(failure) : undefined;
      permitStore.resolve();
      if (reporter === "missing") {
        const replacement = await reconnectSocket();
        expect(replacement.send).toHaveBeenCalledOnce();
        await expect(client.stopAndWait()).rejects.toBe(failure);
      } else {
        await vi.advanceTimersByTimeAsync(0);
        await stopped;
        if (reporter === "reported") {
          expect(onConnectError).toHaveBeenCalledExactlyOnceWith(failure);
        }
      }
    },
  );

  it.each(["closing", "reconnecting"])("settles token cleanup while %s", async (phase) => {
    const cleared = storageGate();
    const loadDeviceAuthToken = vi.fn(() => storedToken);
    const clearDeviceAuthToken = vi.fn<ClearToken>(() => cleared.promise);
    const { socket, onConnectError, onClose, onReconnectPaused } = connect({
      loadDeviceAuthToken,
      clearDeviceAuthToken,
    });
    if (phase === "closing") {
      socket.respond(undefined, {
        code: "INVALID_REQUEST",
        message: "synthetic token rejected",
        details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
      });
      socket.readyState = 2;
      await vi.advanceTimersByTimeAsync(0);
      expect(onConnectError).toHaveBeenCalledOnce();
      expect(onConnectError.mock.calls[0]?.[0]).toMatchObject({
        message: "synthetic token rejected",
      });
    } else {
      socket.close(1008, "device token mismatch");
    }
    const cleanup = clearDeviceAuthToken.mock.calls[0]?.[0];
    assert(cleanup);
    expect(cleanup.expectedToken).toBe(storedToken.token);
    if (phase === "closing") {
      socket.close(1008, "connect failed");
      expect(onClose).toHaveBeenCalledWith(
        1008,
        "connect failed",
        expect.objectContaining({ connectError: onConnectError.mock.calls[0]?.[0] }),
      );
      expect(onReconnectPaused).toHaveBeenCalledWith(
        expect.objectContaining({ detailCode: "AUTH_DEVICE_TOKEN_MISMATCH" }),
      );
    }
    expect(() => cleanup.assertCurrent?.()).not.toThrow();
    if (phase === "closing") {
      cleared.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onConnectError).toHaveBeenCalledOnce();
      expect(MockWebSocket.instances).toHaveLength(1);
    } else {
      const replacement = await reconnectSocket();
      expect(loadDeviceAuthToken).toHaveBeenCalledOnce();
      cleared.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(loadDeviceAuthToken).toHaveBeenCalledTimes(2);
      expect(replacement.send).toHaveBeenCalledOnce();
    }
  });
});
