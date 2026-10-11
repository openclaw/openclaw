import type {
  GatewayControlUiIngressFactoryV1,
  GatewayControlUiIngressV1,
  GatewayIngressMessage,
  GatewayIngressSocketV1,
} from "openclaw/plugin-sdk/gateway-ingress";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { vi } from "vitest";
import { RelayError } from "./protocol.js";
import { UiTunnel } from "./ui-tunnel.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export class Mailbox<T> {
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
  readonly closing = deferred<{ code: number; reason: string }>();
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

export function fixture() {
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
    request: vi.fn<GatewayControlUiIngressV1["request"]>(async () => ({
      response: new Response("index"),
      pluginReadCookies: [],
    })),
    openWebSocket: vi.fn<GatewayControlUiIngressV1["openWebSocket"]>(async () => {
      const socket = new IngressSocket();
      sockets.push(socket);
      return { socket };
    }),
    close: vi.fn<GatewayControlUiIngressV1["close"]>(async () => {
      for (const socket of sockets) {
        socket.close(1001, "handle closed");
      }
    }),
  } satisfies GatewayControlUiIngressV1;
  const factory = {
    open: vi.fn<GatewayControlUiIngressFactoryV1["open"]>(async () => handle),
  } satisfies GatewayControlUiIngressFactoryV1;
  const active = new Set(["gr_one"]);
  const onUnsupportedAuth = vi.fn();
  let bufferedBytes = 0;
  const relayClosed = deferred<void>();
  const closeRelay = vi.fn(() => {
    relayClosed.resolve();
    void tunnel.close();
  });
  const tunnel = new UiTunnel({
    factory,
    scheduler,
    frameAncestors: ["https://chatgpt.com"],
    assertGrantCurrent: (id) => {
      if (!active.has(id)) {
        throw new RelayError("grant_revoked", "Grant revoked");
      }
    },
    bufferedBytes: () => bufferedBytes,
    closeRelay,
    onUnsupportedAuth,
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
    factory,
    sockets,
    active,
    closeRelay,
    relayClosed: relayClosed.promise,
    onUnsupportedAuth,
    setBuffered: (bytes: number) => {
      bufferedBytes = bytes;
    },
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
