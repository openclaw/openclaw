import type {
  GatewayControlUiIngressPresentationOptionsV1,
  GatewayControlUiIngressV2,
  GatewayIngressMessage,
  GatewayIngressSocketV1,
} from "openclaw/plugin-sdk/gateway-ingress";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { isRetiredBindingError } from "./grant-bindings.js";
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
  UI_CHUNK_BYTES,
  uiError,
  UiTunnelError,
} from "./ui-tunnel-protocol.js";

type Options = {
  open: (
    grantId: string,
    presentation: GatewayControlUiIngressPresentationOptionsV1,
  ) => Promise<GatewayControlUiIngressV2>;
  frameAncestors: readonly string[];
  scheduler: PluginServiceSchedulerV1;
  assertGrantCurrent: (grantId: string) => void;
  send: (frame: unknown) => void;
  closeRelay: () => void;
  retireBinding?: (grantId: string) => void;
};
type Grant = {
  id: string;
  publicOrigin: string;
  sandboxOrigin: string;
  handle: Promise<GatewayControlUiIngressV2>;
};
type StreamBase = {
  sid: string;
  grant: Grant;
  abort: AbortController;
};
type HttpStream = StreamBase & {
  kind: "http";
  input: UiRequestBody;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
};
type SocketStream = StreamBase & {
  kind: "ws";
  socket?: GatewayIngressSocketV1;
  partial?: { kind: "text" | "binary"; bytes: Buffer; length: number };
  sending: Promise<void>;
};
type Stream = HttpStream | SocketStream;

export class UiTunnel {
  readonly #options: Options;
  readonly #grants = new Map<string, Grant>();
  readonly #streams = new Map<string, Stream>();
  #stopping?: Promise<void>;

  constructor(options: Options) {
    this.#options = options;
    options.scheduler.signal.addEventListener("abort", () => void this.close(), { once: true });
  }

  receive(frame: Record<string, unknown>): void {
    if (this.#stopping || this.#options.scheduler.signal.aborted) {
      return;
    }
    const sid = frame.sid;
    if (typeof sid !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(sid)) {
      this.#options.closeRelay();
      return;
    }
    try {
      if (frame.type === "ui.http" || frame.type === "ui.ws.open") {
        if (this.#streams.has(sid)) {
          invalid("The Control UI stream ID is already in use.");
        }
        const kind = frame.type === "ui.http" ? "http" : "ws";
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
          stream.input.push(chunkBytes(frame.b64), moreFlag(frame.more));
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
    this.retire(
      grantId,
      new UiTunnelError(
        "grant_revoked",
        "This connection was revoked. Pair OpenClaw again to reconnect.",
      ),
    );
  }

  retire(grantId: string, error: Error): void {
    const grant = this.#grants.get(grantId);
    if (grant) {
      void this.#retire(grant, error);
    }
  }

  close(): Promise<void> {
    this.#stopping ??= Promise.resolve().then(async () => {
      for (const stream of this.#streams.values()) {
        this.#finish(stream);
      }
      await Promise.all(Array.from(this.#grants.values(), (grant) => this.#retire(grant)));
    });
    return this.#stopping;
  }

  #assert(stream: Stream): void {
    if (
      this.#stopping ||
      this.#options.scheduler.signal.aborted ||
      this.#grants.get(stream.grant.id) !== stream.grant ||
      this.#streams.get(stream.sid) !== stream
    ) {
      throw new UiTunnelError("unavailable", "The Control UI stream has closed.");
    }
    this.#options.assertGrantCurrent(stream.grant.id);
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
      void this.#retire(
        existing,
        new UiTunnelError(
          "unavailable",
          "The relay changed the Control UI origins. Open OpenClaw from ChatGPT again.",
        ),
      );
    }
    const grant: Grant = {
      id: frame.grantId,
      publicOrigin,
      sandboxOrigin,
      handle: this.#options.open(frame.grantId, {
        publicOrigin,
        sandboxOrigin,
        frameAncestors: this.#options.frameAncestors,
      }),
    };
    this.#grants.set(grant.id, grant);
    void grant.handle.catch((error: unknown) => {
      if (this.#grants.get(grant.id) === grant) {
        this.#grants.delete(grant.id);
        if (isRetiredBindingError(error)) {
          this.#options.retireBinding?.(grant.id);
        }
      }
    });
    return grant;
  }

  async #retire(grant: Grant, error?: Error): Promise<void> {
    if (this.#grants.get(grant.id) === grant) {
      this.#grants.delete(grant.id);
    }
    for (const stream of this.#streams.values()) {
      if (stream.grant === grant) {
        if (error) {
          this.#fail(stream.sid, error);
        } else {
          this.#finish(stream);
        }
      }
    }
    await grant.handle.then(
      (handle) => handle.close(),
      () => undefined,
    );
  }

  #fail(sid: string, error: unknown): void {
    let cause = error;
    const stream = this.#streams.get(sid);
    if (
      stream &&
      this.#grants.get(stream.grant.id) === stream.grant &&
      isRetiredBindingError(error)
    ) {
      this.#options.retireBinding?.(stream.grant.id);
      void this.#retire(stream.grant, error);
      return;
    }
    if (stream) {
      try {
        this.#options.assertGrantCurrent(stream.grant.id);
      } catch (authorityError) {
        cause = authorityError;
      }
    }
    const failure = uiError(cause);
    if (stream) {
      this.#finish(
        stream,
        failure.code === "forbidden" || failure.code === "grant_revoked" ? 1008 : 1011,
      );
    }
    if (!this.#stopping && !this.#options.scheduler.signal.aborted) {
      try {
        this.#options.send({ type: "ui.error", sid, code: failure.code, message: failure.message });
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
    stream.abort.abort();
    if (stream.kind === "http") {
      stream.input.discard(new Error("Control UI request closed"));
      void stream.reader?.cancel().catch(() => undefined);
    } else {
      stream.socket?.close(code, code === 1000 ? "" : "Control UI tunnel closed");
      stream.partial = undefined;
    }
  }

  #run(stream: Stream, run: () => Promise<void>): void {
    void run().catch((error: unknown) => {
      if (this.#streams.get(stream.sid) === stream) {
        this.#fail(stream.sid, error);
      }
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
      input: new UiRequestBody(),
    };
    this.#streams.set(sid, stream);
    stream.input.push(chunkBytes(frame.b64), moreFlag(frame.more));
    this.#run(stream, async () => {
      const handle = await grant.handle;
      this.#assert(stream);
      const { response, pluginReadCookies } = await handle.request({
        surface,
        method,
        pathAndQuery,
        headers,
        ...(stream.input.hasBody ? { body: stream.input.stream } : {}),
        signal: stream.abort.signal,
      });
      stream.reader = response.body?.getReader();
      this.#assert(stream);
      this.#options.send({
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
          for (let offset = 0; offset < value.byteLength; offset += UI_CHUNK_BYTES) {
            this.#options.send({
              type: "ui.http.body",
              sid,
              b64: Buffer.from(value.subarray(offset, offset + UI_CHUNK_BYTES)).toString("base64"),
              more: true,
            });
          }
        }
      }
      this.#assert(stream);
      this.#options.send({ type: "ui.http.body", sid, b64: "", more: false });
      this.#finish(stream);
    });
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
      sending: Promise.resolve(),
    };
    this.#streams.set(sid, stream);
    this.#run(stream, async () => {
      const handle = await grant.handle;
      this.#assert(stream);
      const { socket, protocol } = await handle.openWebSocket({
        pathAndQuery,
        origin,
        protocols,
        signal: stream.abort.signal,
      });
      stream.socket = socket;
      this.#assert(stream);
      if (protocol && !protocols.includes(protocol)) {
        throw new UiTunnelError("invalid", "The Gateway selected an unoffered WebSocket protocol.");
      }
      this.#options.send({ type: "ui.ws.opened", sid, ...(protocol ? { protocol } : {}) });
      const drain = async () => {
        for await (const message of socket.messages) {
          this.#assert(stream);
          if (message.kind === "text") {
            for (const chunk of textFrames(sid, message.text)) {
              this.#options.send(chunk);
            }
          } else {
            for (
              let offset = 0;
              offset < Math.max(1, message.bytes.byteLength);
              offset += UI_CHUNK_BYTES
            ) {
              this.#options.send({
                type: "ui.ws.msg",
                sid,
                b64: Buffer.from(message.bytes.subarray(offset, offset + UI_CHUNK_BYTES)).toString(
                  "base64",
                ),
                more: offset + UI_CHUNK_BYTES < message.bytes.byteLength,
              });
            }
          }
        }
      };
      const [, closed] = await Promise.all([drain(), socket.closed]);
      this.#assert(stream);
      this.#options.send({ type: "ui.ws.close", sid, code: closed.code, reason: closed.reason });
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
    const length = (stream.partial?.length ?? 0) + bytes.byteLength;
    const maxBytes = 25 * 1024 * 1024;
    if (length > maxBytes) {
      throw new UiTunnelError("limit_exceeded", "WebSocket messages must not exceed 25 MiB.");
    }
    const partial = stream.partial ?? { kind, bytes, length };
    if (stream.partial) {
      if (length > partial.bytes.byteLength) {
        // Geometric growth avoids recopying every prefix, with constant metadata
        // even for empty or tiny fragments and capacity bounded by the message limit.
        const grown = Buffer.allocUnsafe(
          Math.min(maxBytes, Math.max(length, partial.bytes.byteLength * 2)),
        );
        partial.bytes.copy(grown, 0, 0, partial.length);
        partial.bytes = grown;
      }
      bytes.copy(partial.bytes, partial.length);
      partial.length = length;
    }
    stream.partial = partial;
    if (more) {
      return;
    }
    stream.partial = undefined;
    const complete = partial.bytes.subarray(0, partial.length);
    const message: GatewayIngressMessage =
      kind === "text" ? { kind, text: complete.toString("utf8") } : { kind, bytes: complete };
    stream.sending = stream.sending.then(async () => {
      this.#assert(stream);
      await stream.socket?.send(message);
    });
    this.#run(stream, () => stream.sending);
  }
}
