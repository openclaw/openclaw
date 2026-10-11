import {
  GatewayControlUiIngressError,
  type GatewayControlUiIngressFactoryV1,
  type GatewayControlUiIngressV1,
  type GatewayIngressMessage,
  type GatewayIngressSocketV1,
} from "openclaw/plugin-sdk/gateway-ingress";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { MAX_FRAME_BYTES } from "./protocol.js";
import { type UiIngressAdmission, waitForUiIngress } from "./ui-tunnel-admission.js";
import { UiRequestBody } from "./ui-tunnel-body.js";
import {
  chunkBytes,
  closeInfo,
  exactHttpsOrigin,
  invalid,
  localPath,
  moreFlag,
  textFrames,
  tunnelCookies,
  tunnelHeaders,
  UI_BUFFER_BYTES,
  UI_CHUNK_BYTES,
  uiError,
  UiTunnelError,
} from "./ui-tunnel-protocol.js";

type Options = {
  factory: GatewayControlUiIngressFactoryV1;
  frameAncestors: readonly string[];
  scheduler: PluginServiceSchedulerV1;
  assertGrantCurrent: (grantId: string) => void;
  send: (frame: unknown) => void;
  bufferedBytes: () => number;
  closeRelay: () => void;
  onUnsupportedAuth: (reason: string) => void;
};
type Grant = UiIngressAdmission & {
  id: string;
  publicOrigin: string;
  sandboxOrigin: string;
  abort: AbortController;
  handle: Promise<GatewayControlUiIngressV1>;
};
type StreamBase = {
  sid: string;
  grant: Grant;
  abort: AbortController;
  deadline?: { cancel: () => void };
  jobs: Set<{ cancel: () => void }>;
};
type HttpStream = StreamBase & {
  kind: "http";
  input: UiRequestBody;
  total: number;
  ended: boolean;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
};
type SocketStream = StreamBase & {
  kind: "ws";
  socket?: GatewayIngressSocketV1;
  partial?: { kind: "text" | "binary"; bytes: Buffer };
  messages: { message: GatewayIngressMessage; bytes: number }[];
  sending: boolean;
};
type Stream = HttpStream | SocketStream;

export class UiTunnel {
  readonly #options: Options;
  readonly #scheduler: PluginServiceSchedulerV1;
  readonly #grants = new Map<string, Grant>();
  readonly #streams = new Map<string, Stream>();
  readonly #closing = new Set<Promise<void>>();
  #buffered = 0;
  #serial = 0;
  #stopped = false;
  #stopping?: Promise<void>;

  constructor(options: Options) {
    this.#options = options;
    this.#scheduler = options.scheduler.scope();
    this.#scheduler.signal.addEventListener("abort", () => this.#fence(), { once: true });
  }

  get bufferedBytes(): number {
    return this.#buffered;
  }

  receive(frame: Record<string, unknown>): void {
    if (this.#stopped) {
      return;
    }
    const sid = frame.sid;
    if (typeof sid !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(sid)) {
      this.#options.closeRelay();
      return;
    }
    try {
      if (Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME_BYTES) {
        throw new UiTunnelError("limit_exceeded", "Control UI frames are limited to 1 MiB.");
      }
      if (frame.type === "ui.http" || frame.type === "ui.ws.open") {
        if (this.#streams.has(sid)) {
          invalid("The Control UI stream ID is already in use.");
        }
        const kind = frame.type === "ui.http" ? "http" : "ws";
        const count = Array.from(this.#streams.values()).filter(
          (stream) => stream.kind === kind,
        ).length;
        if (count >= (kind === "http" ? 64 : 8)) {
          throw new UiTunnelError(
            "limit_exceeded",
            `Too many Control UI ${kind === "http" ? "HTTP streams" : "sockets"}.`,
          );
        }
        const grant = this.#grant(frame);
        if (kind === "http") {
          this.#http(sid, grant, frame);
        } else {
          this.#webSocket(sid, grant, frame);
        }
        return;
      }
      const stream = this.#streams.get(sid);
      if (!stream) {
        // Cancellation and close can arrive after the local terminal frame.
        if (frame.type !== "ui.cancel" && frame.type !== "ui.ws.close") {
          invalid("Unknown Control UI stream.");
        }
        return;
      }
      this.#assert(stream);
      switch (frame.type) {
        case "ui.http.body":
          if (stream.kind !== "http") {
            invalid();
          }
          this.#body(stream, frame);
          break;
        case "ui.cancel":
          if (stream.kind !== "http") {
            invalid();
          }
          this.#finish(stream);
          break;
        case "ui.ws.msg":
          if (stream.kind !== "ws" || !stream.socket) {
            invalid("The Control UI socket is not open.");
          }
          this.#message(stream, frame);
          break;
        case "ui.ws.close": {
          if (stream.kind !== "ws") {
            invalid();
          }
          const { code, reason } = closeInfo(frame);
          stream.socket?.close(code, reason);
          this.#finish(stream);
          break;
        }
        default:
          invalid();
      }
    } catch (error) {
      this.#fail(sid, error);
    }
  }

  revoke(grantId: string): void {
    const grant = this.#grants.get(grantId);
    if (grant) {
      this.#retire(
        grant,
        new UiTunnelError(
          "grant_revoked",
          "This connection was revoked. Pair OpenClaw again to reconnect.",
        ),
      );
    }
  }

  close(): Promise<void> {
    this.#fence();
    this.#scheduler.beginClose();
    this.#stopping ??= this.#scheduler.stop().then(async () => {
      await Promise.all(this.#closing);
    });
    return this.#stopping;
  }

  #fence(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    for (const stream of this.#streams.values()) {
      this.#finish(stream);
    }
    for (const grant of this.#grants.values()) {
      this.#retire(grant);
    }
  }

  #assertGrant(grant: Grant): void {
    if (this.#stopped || grant.abort.signal.aborted || this.#grants.get(grant.id) !== grant) {
      throw new UiTunnelError(
        "unavailable",
        "The Control UI ingress has closed. Open OpenClaw from ChatGPT again.",
      );
    }
    this.#options.assertGrantCurrent(grant.id);
  }

  #assert(stream: Stream): void {
    this.#assertGrant(stream.grant);
    if (this.#streams.get(stream.sid) !== stream || stream.abort.signal.aborted) {
      throw new UiTunnelError("unavailable", "The Control UI stream has closed.");
    }
  }

  #grant(frame: Record<string, unknown>): Grant {
    if (typeof frame.grantId !== "string" || !frame.grantId || frame.grantId.length > 200) {
      invalid("Supply a valid grant ID.");
    }
    this.#options.assertGrantCurrent(frame.grantId);
    const publicOrigin = exactHttpsOrigin(frame.publicOrigin);
    const sandboxOrigin = exactHttpsOrigin(frame.sandboxOrigin);
    if (publicOrigin === sandboxOrigin) {
      invalid("Control UI and sandbox origins must be distinct.");
    }
    const existing = this.#grants.get(frame.grantId);
    if (existing?.publicOrigin === publicOrigin && existing.sandboxOrigin === sandboxOrigin) {
      return existing;
    }
    if (existing) {
      this.#retire(
        existing,
        new UiTunnelError(
          "unavailable",
          "The relay changed the Control UI origins. Open OpenClaw from ChatGPT again.",
        ),
      );
    }
    if (this.#grants.size + this.#closing.size >= 32) {
      throw new UiTunnelError("limit_exceeded", "Too many active Control UI grants.");
    }
    const abort = new AbortController();
    // Start admission in a microtask after publishing the grant used by assertCurrent.
    const grant: Grant = {
      id: frame.grantId,
      publicOrigin,
      sandboxOrigin,
      abort,
      waiters: new Set(),
      handle: Promise.resolve().then(async () => {
        this.#assertGrant(grant);
        try {
          const handle = await this.#options.factory.open({
            audienceId: grant.id,
            publicOrigin,
            sandboxOrigin,
            operatorScopeCeiling: ["operator.read", "operator.write"],
            frameAncestors: this.#options.frameAncestors,
            signal: abort.signal,
            assertCurrent: () => this.#assertGrant(grant),
          });
          try {
            this.#assertGrant(grant);
            return handle;
          } catch (error) {
            await handle.close();
            throw error;
          }
        } catch (error) {
          if (
            error instanceof GatewayControlUiIngressError &&
            error.code === "unsupported-auth" &&
            !this.#stopped
          ) {
            // The first unsupported launch shows its error inside the frame; later status calls fall back.
            this.#options.onUnsupportedAuth(error.message);
          }
          this.#retire(
            grant,
            error instanceof Error ? error : new Error("Control UI ingress failed"),
          );
          throw error;
        }
      }),
    };
    this.#grants.set(grant.id, grant);
    void grant.handle.then(
      (handle) => {
        grant.opened = handle;
        for (const waiter of grant.waiters) {
          waiter.resolve(handle);
        }
      },
      (error: unknown) => {
        for (const waiter of grant.waiters) {
          waiter.reject(error);
        }
      },
    );
    return grant;
  }

  #retire(grant: Grant, error?: Error): void {
    if (this.#grants.get(grant.id) !== grant) {
      return;
    }
    this.#grants.delete(grant.id);
    grant.abort.abort();
    for (const stream of this.#streams.values()) {
      if (stream.grant === grant) {
        if (error) {
          this.#fail(stream.sid, error);
        } else {
          this.#finish(stream);
        }
      }
    }
    const closing = grant.handle.then(
      (handle) => handle.close(),
      () => undefined,
    );
    this.#closing.add(closing);
    void closing.finally(() => this.#closing.delete(closing)).catch(() => undefined);
  }

  #reserve(bytes: number): void {
    if (this.#buffered + this.#options.bufferedBytes() + bytes > UI_BUFFER_BYTES) {
      throw new UiTunnelError(
        "limit_exceeded",
        "The Control UI tunnel exceeded its 32 MiB buffer limit.",
      );
    }
    this.#buffered += bytes;
  }

  #send(frame: Record<string, unknown>): void {
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    if (
      bytes > MAX_FRAME_BYTES ||
      this.#buffered + this.#options.bufferedBytes() + bytes > UI_BUFFER_BYTES
    ) {
      throw new UiTunnelError(
        "limit_exceeded",
        "The Control UI tunnel exceeded its output buffer limit.",
      );
    }
    this.#options.send(frame);
  }

  #fail(sid: string, error: unknown): void {
    const failure = uiError(error);
    const stream = this.#streams.get(sid);
    if (stream) {
      this.#finish(
        stream,
        failure.code === "forbidden" || failure.code === "grant_revoked" ? 1008 : 1011,
      );
    }
    if (!this.#stopped) {
      try {
        this.#send({ type: "ui.error", sid, code: failure.code, message: failure.message });
      } catch {
        this.#options.closeRelay();
      }
    }
  }

  #finish(stream: Stream, code = 1000): void {
    if (this.#streams.get(stream.sid) !== stream) {
      return;
    }
    this.#streams.delete(stream.sid);
    stream.deadline?.cancel();
    for (const job of stream.jobs) {
      job.cancel();
    }
    stream.jobs.clear();
    stream.abort.abort();
    if (stream.kind === "http") {
      stream.input.discard(new Error("Control UI request closed"));
      void stream.reader?.cancel().catch(() => undefined);
    } else {
      stream.socket?.close(code, code === 1000 ? "" : "Control UI tunnel closed");
      if (stream.partial) {
        this.#buffered -= stream.partial.bytes.length;
        stream.partial = undefined;
      }
      for (const queued of stream.messages) {
        this.#buffered -= queued.bytes;
      }
      stream.messages.length = 0;
    }
  }

  #run(stream: Stream, run: () => Promise<void>): void {
    const job = this.#scheduler.schedule({
      id: `ui-work:${++this.#serial}`,
      delayMs: 0,
      run: async () => {
        try {
          this.#assert(stream);
          await run();
        } catch (error) {
          if (this.#streams.get(stream.sid) === stream) {
            if (error instanceof GatewayControlUiIngressError && error.code === "closed") {
              this.#retire(stream.grant, error);
            } else {
              this.#fail(stream.sid, error);
            }
          }
        } finally {
          stream.jobs.delete(job);
        }
      },
    });
    stream.jobs.add(job);
  }

  #deadline(stream: Stream, delayMs: number, message: string): void {
    stream.deadline?.cancel();
    stream.deadline = this.#scheduler.schedule({
      id: `ui-deadline:${stream.sid}`,
      delayMs,
      run: () => {
        if (this.#streams.get(stream.sid) === stream) {
          this.#fail(stream.sid, new UiTunnelError("unavailable", message));
        }
      },
    });
  }

  #http(sid: string, grant: Grant, frame: Record<string, unknown>): void {
    if (frame.surface !== "control-ui" && frame.surface !== "sandbox") {
      invalid("Supply a valid Control UI surface.");
    }
    if (typeof frame.method !== "string" || !/^[A-Z]+$/.test(frame.method)) {
      invalid("Supply an HTTP method.");
    }
    const surface = frame.surface;
    const method = frame.method;
    const pathAndQuery = localPath(frame.path);
    const headers = tunnelHeaders(frame.headers, "request");
    const stream: HttpStream = {
      kind: "http",
      sid,
      grant,
      abort: new AbortController(),
      jobs: new Set(),
      total: 0,
      ended: false,
      input: new UiRequestBody(
        (bytes) => this.#reserve(bytes),
        (bytes) => {
          this.#buffered -= bytes;
        },
      ),
    };
    this.#streams.set(sid, stream);
    this.#body(stream, frame);
    this.#deadline(
      stream,
      60_000,
      "The Gateway did not return Control UI response headers within 60 seconds.",
    );
    this.#run(stream, async () => {
      const handle = await waitForUiIngress(grant, stream.abort.signal);
      this.#assert(stream);
      const { response, pluginReadCookies } = await handle.request({
        surface,
        method,
        pathAndQuery,
        headers,
        ...(stream.total || !stream.ended ? { body: stream.input.stream } : {}),
        signal: stream.abort.signal,
      });
      stream.reader = response.body?.getReader();
      try {
        this.#assert(stream);
      } catch (error) {
        await stream.reader?.cancel();
        throw error;
      }
      stream.deadline?.cancel();
      this.#send({
        type: "ui.http.head",
        sid,
        status: response.status,
        headers: tunnelHeaders(Array.from(response.headers), "response"),
        cookies: tunnelCookies(pluginReadCookies),
      });
      if (stream.reader) {
        for (;;) {
          const { done, value } = await stream.reader.read();
          this.#assert(stream);
          if (done) {
            break;
          }
          this.#reserve(value.byteLength);
          let remaining = value.byteLength;
          try {
            for (let offset = 0; offset < value.byteLength; offset += UI_CHUNK_BYTES) {
              const bytes = value.subarray(offset, offset + UI_CHUNK_BYTES);
              remaining -= bytes.byteLength;
              this.#buffered -= bytes.byteLength;
              this.#send({
                type: "ui.http.body",
                sid,
                b64: Buffer.from(bytes).toString("base64"),
                more: true,
              });
            }
          } finally {
            this.#buffered -= remaining;
          }
        }
      }
      this.#assert(stream);
      this.#send({ type: "ui.http.body", sid, b64: "", more: false });
      this.#finish(stream);
    });
  }

  #body(stream: HttpStream, frame: Record<string, unknown>): void {
    if (stream.ended) {
      invalid("The HTTP request body is already complete.");
    }
    const bytes = chunkBytes(frame.b64);
    const more = moreFlag(frame.more);
    stream.total += bytes.length;
    if (stream.total > 16 * 1024 * 1024) {
      throw new UiTunnelError("limit_exceeded", "Control UI request bodies are limited to 16 MiB.");
    }
    stream.input.push(bytes, more);
    stream.ended = !more;
  }

  #webSocket(sid: string, grant: Grant, frame: Record<string, unknown>): void {
    const pathAndQuery = localPath(frame.path);
    if (frame.origin === grant.sandboxOrigin) {
      throw new UiTunnelError("forbidden", "Sandbox WebSockets are not supported by this Gateway.");
    }
    if (frame.origin !== grant.publicOrigin) {
      throw new UiTunnelError(
        "forbidden",
        "WebSocket Origin does not match the Control UI origin.",
      );
    }
    if (
      !Array.isArray(frame.protocols) ||
      frame.protocols.some(
        (value) => typeof value !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value),
      )
    ) {
      invalid("Supply valid WebSocket protocols.");
    }
    const protocols: string[] = frame.protocols;
    const origin = frame.origin;
    const stream: SocketStream = {
      kind: "ws",
      sid,
      grant,
      abort: new AbortController(),
      jobs: new Set(),
      messages: [],
      sending: false,
    };
    this.#streams.set(sid, stream);
    this.#deadline(
      stream,
      10_000,
      "The Gateway did not open the Control UI socket within 10 seconds.",
    );
    this.#run(stream, async () => {
      const handle = await waitForUiIngress(grant, stream.abort.signal);
      this.#assert(stream);
      const { socket, protocol } = await handle.openWebSocket({
        pathAndQuery,
        origin,
        protocols,
        signal: stream.abort.signal,
      });
      stream.socket = socket;
      try {
        this.#assert(stream);
      } catch (error) {
        socket.close(1001, "Control UI stream closed");
        throw error;
      }
      if (protocol && !protocols.includes(protocol)) {
        throw new UiTunnelError("invalid", "The Gateway selected an unoffered WebSocket protocol.");
      }
      stream.deadline?.cancel();
      this.#send({ type: "ui.ws.opened", sid, ...(protocol ? { protocol } : {}) });
      const drain = async () => {
        for await (const message of socket.messages) {
          this.#assert(stream);
          const bytes =
            message.kind === "text" ? Buffer.byteLength(message.text) : message.bytes.byteLength;
          if (bytes > UI_BUFFER_BYTES) {
            throw new UiTunnelError(
              "limit_exceeded",
              "Control UI WebSocket messages are limited to 32 MiB.",
            );
          }
          this.#reserve(bytes);
          let remaining = bytes;
          const release = (count: number) => {
            remaining -= count;
            this.#buffered -= count;
          };
          try {
            if (message.kind === "text") {
              for (const chunk of textFrames(sid, message.text)) {
                release(Buffer.byteLength(chunk.text));
                this.#send(chunk);
              }
            } else {
              for (
                let offset = 0;
                offset < Math.max(1, message.bytes.byteLength);
                offset += UI_CHUNK_BYTES
              ) {
                const chunk = message.bytes.subarray(offset, offset + UI_CHUNK_BYTES);
                release(chunk.byteLength);
                this.#send({
                  type: "ui.ws.msg",
                  sid,
                  b64: Buffer.from(chunk).toString("base64"),
                  more: offset + UI_CHUNK_BYTES < message.bytes.byteLength,
                });
              }
            }
          } finally {
            this.#buffered -= remaining;
          }
        }
      };
      const [, closed] = await Promise.all([drain(), socket.closed]);
      this.#assert(stream);
      this.#send({ type: "ui.ws.close", sid, code: closed.code, reason: closed.reason });
      this.#finish(stream);
    });
  }

  #message(stream: SocketStream, frame: Record<string, unknown>): void {
    const more = moreFlag(frame.more);
    const text = typeof frame.text === "string";
    if (text === (typeof frame.b64 === "string")) {
      invalid("Supply either text or base64 WebSocket data.");
    }
    let bytes: Buffer;
    if (text) {
      if (
        typeof frame.text !== "string" ||
        /[\uD800-\uDFFF]/u.test(frame.text) ||
        Buffer.byteLength(frame.text) > UI_CHUNK_BYTES
      ) {
        invalid("Supply a complete Unicode text chunk of at most 512 KiB.");
      }
      bytes = Buffer.from(frame.text);
    } else {
      bytes = chunkBytes(frame.b64);
    }
    const kind = text ? "text" : "binary";
    if (stream.partial && stream.partial.kind !== kind) {
      invalid("WebSocket fragments must use the same data type.");
    }
    const fragmented = stream.partial !== undefined;
    const length = (stream.partial?.bytes.length ?? 0) + bytes.length;
    if (length > UI_BUFFER_BYTES) {
      throw new UiTunnelError(
        "limit_exceeded",
        "Control UI WebSocket messages are limited to 32 MiB.",
      );
    }
    this.#reserve(bytes.length);
    const complete = stream.partial ? Buffer.concat([stream.partial.bytes, bytes]) : bytes;
    stream.partial = { kind, bytes: complete };
    if (more) {
      if (!fragmented) {
        this.#deadline(stream, 60_000, "The fragmented Control UI socket message expired.");
      }
      return;
    }
    this.#reserve(64);
    stream.partial = undefined;
    stream.deadline?.cancel();
    const message: GatewayIngressMessage =
      kind === "text" ? { kind, text: complete.toString("utf8") } : { kind, bytes: complete };
    stream.messages.push({ message, bytes: complete.length + 64 });
    if (stream.sending) {
      return;
    }
    stream.sending = true;
    this.#run(stream, async () => {
      try {
        for (;;) {
          const queued = stream.messages.shift();
          if (!queued) {
            break;
          }
          try {
            this.#assert(stream);
            await stream.socket?.send(queued.message);
            this.#assert(stream);
          } finally {
            this.#buffered -= queued.bytes;
          }
        }
      } finally {
        stream.sending = false;
      }
    });
  }
}
