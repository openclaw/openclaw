import { EventEmitter } from "node:events";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import {
  GatewayControlUiIngressError,
  type GatewayControlUiIngressFactoryV2,
  type GatewayControlUiIngressV2,
  type GatewayIngressPrincipalBindingV1,
  type GatewayIngressPrincipalOptionsV1,
  type GatewayIngressMessage,
  type GatewayIngressSocketV1,
} from "openclaw/plugin-sdk/gateway-ingress";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { vi } from "vitest";
import { identityFromPrivateKey, RelayError } from "./protocol.js";
import { RelayService, type RelaySocket } from "./service.js";
import { RelayState } from "./state.js";
import { UiTunnel } from "./ui-tunnel.js";

export function createStateFixture(now = () => 0) {
  const rows = new Map<string, string>();
  const expires = new Map<string, number>();
  const effects: { beforeWrite?: () => Promise<void>; failure?: Error } = {};
  const unsupported = () => {
    throw new Error("Unexpected SDK operation");
  };
  const unsupportedAsync = async () => unsupported();
  const runtime: Pick<PluginRuntime, "state"> = {
    state: {
      resolveStateDir: unsupported,
      openBlobStore: unsupported,
      openSyncKeyedStore: unsupported,
      openChannelIngressQueue: unsupported,
      openChannelIngressDrain: unsupported,
      openKeyedStore: unsupported,
      openKeyedStoreV2: <T>(
        _options: unknown,
        authority?: { assertCurrent(): void },
      ): PluginStateKeyedStore<T, 2> => {
        const read = (key: string): T | undefined => {
          authority?.assertCurrent();
          if (effects.failure) {
            throw effects.failure;
          }
          if ((expires.get(key) ?? Infinity) <= now()) {
            rows.delete(key);
            expires.delete(key);
          }
          const value = rows.get(key);
          return value === undefined ? undefined : JSON.parse(value);
        };
        return {
          lookup: async (key) => read(key),
          register: async (key, value, options) => {
            await effects.beforeWrite?.();
            authority?.assertCurrent();
            options?.assertCurrent?.();
            if (effects.failure) {
              throw effects.failure;
            }
            rows.set(key, JSON.stringify(value));
            if (options?.ttlMs !== undefined) {
              expires.set(key, now() + options.ttlMs);
            } else {
              expires.delete(key);
            }
          },
          consume: async (key) => {
            const value = read(key);
            rows.delete(key);
            expires.delete(key);
            return value;
          },
          delete: async (key, options) => {
            authority?.assertCurrent();
            options?.assertCurrent?.();
            expires.delete(key);
            return rows.delete(key);
          },
          entries: async () =>
            [...rows.keys()].flatMap((key) => {
              const value = read(key);
              return value === undefined ? [] : [{ key, value, createdAt: 0 }];
            }),
          observe: unsupportedAsync,
          compareAndApply: unsupportedAsync,
          registerIfAbsent: unsupportedAsync,
          lookupMany: unsupportedAsync,
          deleteIfEqual: unsupportedAsync,
          entriesInKeyRange: unsupportedAsync,
          moveEntriesFrom: unsupportedAsync,
          count: unsupportedAsync,
          clear: unsupportedAsync,
        };
      },
    },
  };
  return {
    effects,
    open: (url = "https://mcp.openclaw.ai") => new RelayState(runtime, url, () => {}),
    seed: (value: unknown, key = "identity") => {
      rows.set(key, JSON.stringify(value));
    },
    persisted: () => JSON.stringify([...rows]),
  };
}

const NONCE = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
export const GATEWAY_ID = "gw_ZbYGc9btiEvwHCwiLYKtoH";
export const PUBLIC_KEY = "ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ";
export const SIGNATURE =
  "wZaNEXDNbmhncHDPb_N5xVWk2IJD78-z-jg0_zvwiSspB7jo63XSwGuj7cHFx2evxQ8kII2r6dRIFeNlcqISAQ";
const VECTOR_PRIVATE_KEY = Buffer.from(
  "302e020100300506032b657004220420" +
    "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
  "hex",
).toString("base64url");
export const CHALLENGE = {
  type: "challenge",
  protocol: 1,
  nonce: NONCE,
  relay: "mcp.openclaw.ai",
};
export const CLIENT = { id: "synthetic-client", name: "Synthetic client" };

function parseFrame(text: string): Record<string, unknown> {
  const frame: unknown = JSON.parse(text);
  if (!isRecord(frame)) {
    throw new Error("Expected an object frame");
  }
  return frame;
}

class FakeRelaySocket extends EventEmitter implements RelaySocket {
  readonly frames: Record<string, unknown>[] = [];
  readonly closes: { code?: number; reason?: string }[] = [];
  readonly #queue: Record<string, unknown>[] = [];
  readonly #readers: ((frame: Record<string, unknown>) => void)[] = [];
  terminated = false;
  bufferedAmount = 0;

  send(data: Parameters<RelaySocket["send"]>[0]): void {
    if (typeof data !== "string") {
      throw new Error("The Gateway must send text frames");
    }
    const frame = parseFrame(data);
    this.frames.push(frame);
    const reader = this.#readers.shift();
    if (reader) {
      reader(frame);
    } else {
      this.#queue.push(frame);
    }
  }

  close(code?: number, reason?: string | Buffer): void {
    this.closes.push({ code, reason: reason?.toString() });
    this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
  }

  terminate(): void {
    this.terminated = true;
    this.emit("close", 1006, Buffer.alloc(0));
  }

  receive(frame: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)), false);
  }

  nextFrame(): Promise<Record<string, unknown>> {
    const frame = this.#queue.shift();
    return frame
      ? Promise.resolve(frame)
      : new Promise((resolve) => {
          this.#readers.push(resolve);
        });
  }

  acknowledge(frame: Record<string, unknown>, result: Record<string, unknown> = {}): void {
    this.receive({ type: "res", id: frame.id, ok: true, result });
  }
}

export function createPrincipalIngress(handle?: Omit<GatewayControlUiIngressV2, "requestGateway">) {
  const bindings: {
    options: GatewayIngressPrincipalOptionsV1;
    binding: GatewayIngressPrincipalBindingV1;
  }[] = [];
  const factory = {
    capabilityVersion: 2,
    open: vi.fn<GatewayControlUiIngressFactoryV2["open"]>(async () => {
      throw new Error("Relay grants must use their shared principal binding");
    }),
    bindPrincipal: vi.fn<GatewayControlUiIngressFactoryV2["bindPrincipal"]>(async (options) => {
      let closed = false;
      const assertCurrent = () => {
        if (closed || options.signal.aborted) {
          throw new GatewayControlUiIngressError("closed", "Principal binding closed");
        }
        options.assertCurrent();
      };
      assertCurrent();
      const request = vi.fn(async (): Promise<never> => {
        assertCurrent();
        throw new Error("Unexpected Gateway request");
      });
      const binding: GatewayIngressPrincipalBindingV1 = {
        request,
        openControlUi: vi.fn(async () => {
          assertCurrent();
          if (!handle) {
            throw new Error("Unexpected Control UI open");
          }
          return { ...handle, requestGateway: request };
        }),
        close: vi.fn(async () => {
          closed = true;
        }),
      };
      bindings.push({ options, binding });
      return binding;
    }),
  } satisfies GatewayControlUiIngressFactoryV2;
  return { factory, bindings };
}

export async function createTransportFixture(
  operations: ConstructorParameters<typeof RelayService>[0]["operations"] = async () => ({}),
  ui: Pick<ConstructorParameters<typeof RelayService>[0], "controlUiIngress"> &
    Partial<Pick<ConstructorParameters<typeof RelayService>[0], "config">> = {},
) {
  const clock = createGatewaySchedulerClock(1_000);
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  const storage = createStateFixture(() => scheduler.now());
  const state = storage.open();
  await state.initialize();
  const sockets: FakeRelaySocket[] = [];
  const addresses: string[] = [];
  const effects: { connectError?: Error } = {};
  const ingress = createPrincipalIngress();
  const service = new RelayService({
    config: () => ({}),
    controlUiIngress: ingress.factory,
    ...ui,
    scheduler,
    state,
    identity: identityFromPrivateKey(VECTOR_PRIVATE_KEY),
    relayUrl: "https://mcp.openclaw.ai",
    gateway: { name: "Synthetic Gateway", version: "2026.10.9" },
    operations,
    random: () => 0.5,
    socketFactory: (address) => {
      addresses.push(address);
      if (effects.connectError) {
        throw effects.connectError;
      }
      const socket = new FakeRelaySocket();
      sockets.push(socket);
      return socket;
    },
  });
  service.start();
  await clock.advanceBy(0);
  const socket = sockets[0];
  if (!socket) {
    throw new Error("The service did not connect");
  }
  return {
    clock,
    scheduler,
    storage,
    state,
    service,
    socket,
    sockets,
    addresses,
    effects,
    ingress,
    ready: async (target = socket, capability?: unknown) => {
      target.receive(CHALLENGE);
      const hello = await target.nextFrame();
      target.receive({
        type: "ready",
        gatewayId: GATEWAY_ID,
        ...(capability === undefined ? {} : { ui: capability }),
      });
      return hello;
    },
    request: async (frame: Record<string, unknown>) => {
      socket.receive({ type: "req", ...frame });
      await clock.advanceBy(0);
      return socket.nextFrame();
    },
    stop: async () => {
      await service.stop();
      await scheduler.stop();
    },
  };
}

class Mailbox<T> {
  readonly values: T[] = [];
  readonly #queue: T[] = [];
  readonly #readers: ((value: T) => void)[] = [];
  push(value: T): void {
    this.values.push(value);
    const reader = this.#readers.shift();
    if (reader) {
      reader(value);
    } else {
      this.#queue.push(value);
    }
  }
  next(): Promise<T> {
    if (this.#queue.length) {
      return Promise.resolve(this.#queue.shift()!);
    }
    return new Promise((resolve) => {
      this.#readers.push(resolve);
    });
  }
}

export class IngressSocket implements GatewayIngressSocketV1 {
  readonly incoming = new Mailbox<GatewayIngressMessage | undefined>();
  readonly sent = new Mailbox<GatewayIngressMessage>();
  readonly closing = Promise.withResolvers<{ code: number; reason: string }>();
  readonly closed = this.closing.promise;
  readonly closes: { code: number; reason: string }[] = [];
  #ended = false;
  send = vi.fn(async (message: GatewayIngressMessage) => {
    this.sent.push(message);
  });
  get messages(): AsyncIterable<GatewayIngressMessage> {
    const incoming = this.incoming;
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const message = await incoming.next();
          if (!message) {
            return;
          }
          yield message;
        }
      },
    };
  }
  close(code = 1000, reason = ""): void {
    this.closes.push({ code, reason });
    if (!this.#ended) {
      this.#ended = true;
      this.incoming.push(undefined);
      this.closing.resolve({ code, reason });
    }
  }
}

export const ORIGINS = {
  publicOrigin: "https://grant.ui.example",
  sandboxOrigin: "https://grant-sb.ui.example",
};
export const HTTP = {
  type: "ui.http",
  sid: "http0001",
  grantId: "gr_one",
  surface: "control-ui",
  ...ORIGINS,
  method: "GET",
  path: "/control/?x=1",
  headers: [],
  b64: "",
  more: false,
};
export const WS = {
  type: "ui.ws.open",
  sid: "socket01",
  grantId: "gr_one",
  ...ORIGINS,
  origin: ORIGINS.publicOrigin,
  path: "/control/?client=ui",
  protocols: [],
};

export function createTunnelFixture() {
  const clock = createGatewaySchedulerClock(0);
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  const frames = new Mailbox<Record<string, unknown>>();
  const sockets: IngressSocket[] = [];
  const handle = {
    presentation: {
      ...ORIGINS,
      basePath: "/control",
      operatorScopeCeiling: ["operator.read", "operator.write"],
    },
    request: vi.fn<GatewayControlUiIngressV2["request"]>(async () => ({
      response: new Response("index"),
      pluginReadCookies: [],
    })),
    openWebSocket: vi.fn<GatewayControlUiIngressV2["openWebSocket"]>(async () => {
      const socket = new IngressSocket();
      sockets.push(socket);
      return { socket };
    }),
    requestGateway: async () => {
      throw new Error("Unexpected Gateway request");
    },
    close: vi.fn<GatewayControlUiIngressV2["close"]>(async () => {
      for (const socket of sockets) {
        socket.close(1001, "handle closed");
      }
    }),
  } satisfies GatewayControlUiIngressV2;
  const open = vi.fn<ConstructorParameters<typeof UiTunnel>[0]["open"]>(async () => handle);
  const active = new Set(["gr_one"]);
  const tunnel = new UiTunnel({
    open,
    scheduler,
    frameAncestors: ["https://chatgpt.com"],
    assertGrantCurrent: (id) => {
      if (!active.has(id)) {
        throw new RelayError("grant_revoked", "Grant revoked");
      }
    },
    closeRelay: () => {
      void tunnel.close();
    },
    send: (frame) => {
      if (!isRecord(frame)) {
        throw new Error("Expected a frame");
      }
      frames.push(frame);
    },
  });
  return {
    tunnel,
    clock,
    frames,
    handle,
    open,
    sockets,
    active,
    receive: async (frame: Record<string, unknown>) => {
      tunnel.receive(frame);
      void clock.advanceBy(0);
    },
    stop: async () => {
      await tunnel.close();
      await scheduler.stop();
    },
  };
}

export function abortable<T>(signal: AbortSignal): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    const abort = () => reject(new Error("Aborted"));
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
  });
}
