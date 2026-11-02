// Length-prefixed framing and HEAD/WebSocket message codecs (pure; no I/O).
import { concatBytes, type Bytes } from "../bytes.js";
import {
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_HEAD_FRAME_BYTES,
  WS_OPCODE,
} from "./constants.js";
import type { HeaderPair, TunnelRequestHead, TunnelResponseHead, WsMessage } from "./types.js";

/** Thrown for a framing or HEAD violation; the receiver resets the stream with `bad_request`. */
export class TunnelProtocolError extends Error {}

/** Prefixes `payload` with its 4-byte big-endian length. */
export function encodeFrame(payload: Uint8Array, maxBytes = MAX_FRAME_BYTES): Bytes {
  if (payload.length > maxBytes) {
    throw new TunnelProtocolError(`frame of ${payload.length} bytes exceeds ${maxBytes}`);
  }
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

/**
 * Incremental frame decoder for one stream direction. Feed received chunks with
 * `push`; it returns every complete frame. A length above `maxBytes` throws before
 * the payload is buffered.
 */
export class FrameDecoder {
  private buffered: Bytes = new Uint8Array(0);

  constructor(private readonly maxBytes = MAX_FRAME_BYTES) {}

  /** Appends a chunk and returns the frames it completed. */
  push(chunk: Uint8Array): Bytes[] {
    this.buffered = concatBytes(this.buffered, chunk);
    const frames: Bytes[] = [];
    for (;;) {
      if (this.buffered.length < FRAME_HEADER_BYTES) {
        return frames;
      }
      const length = new DataView(this.buffered.buffer, this.buffered.byteOffset).getUint32(0);
      if (length > this.maxBytes) {
        throw new TunnelProtocolError(`frame of ${length} bytes exceeds ${this.maxBytes}`);
      }
      if (this.buffered.length < FRAME_HEADER_BYTES + length) {
        return frames;
      }
      frames.push(this.buffered.slice(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length));
      this.buffered = this.buffered.slice(FRAME_HEADER_BYTES + length);
    }
  }

  /** True when a partial frame is buffered (a stream that finishes now is truncated). */
  get hasPartialFrame(): boolean {
    return this.buffered.length > 0;
  }
}

function isHeaderList(value: unknown): value is HeaderPair[] {
  return (
    Array.isArray(value) &&
    value.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "string" &&
        typeof pair[1] === "string",
    )
  );
}

function parseJsonFrame(frame: Uint8Array): Record<string, unknown> {
  if (frame.length > MAX_HEAD_FRAME_BYTES) {
    throw new TunnelProtocolError("HEAD frame too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
  } catch {
    throw new TunnelProtocolError("HEAD frame is not UTF-8 JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TunnelProtocolError("HEAD frame is not an object");
  }
  return value as Record<string, unknown>;
}

const METHOD_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Encodes a HEAD frame payload (JSON). */
export function encodeHead(head: TunnelRequestHead | TunnelResponseHead): Bytes {
  return new TextEncoder().encode(JSON.stringify(head));
}

/** Parses and validates a client HEAD frame. Unknown fields are ignored for forward compatibility. */
export function parseRequestHead(frame: Uint8Array): TunnelRequestHead {
  const head = parseJsonFrame(frame);
  if (typeof head.path !== "string" || !head.path.startsWith("/") || !isHeaderList(head.headers)) {
    throw new TunnelProtocolError("HEAD needs an absolute path and a header list");
  }
  if (head.kind === "http") {
    if (typeof head.method !== "string" || !METHOD_RE.test(head.method)) {
      throw new TunnelProtocolError("invalid HTTP method");
    }
    return { kind: "http", method: head.method, path: head.path, headers: head.headers };
  }
  if (head.kind === "ws") {
    const protocols = head.protocols ?? [];
    if (!Array.isArray(protocols) || !protocols.every((p) => typeof p === "string")) {
      throw new TunnelProtocolError("invalid WebSocket protocols");
    }
    return { kind: "ws", path: head.path, headers: head.headers, protocols: protocols as string[] };
  }
  throw new TunnelProtocolError("HEAD kind must be http or ws");
}

/** Parses and validates a server HEAD frame. */
export function parseResponseHead(frame: Uint8Array): TunnelResponseHead {
  const head = parseJsonFrame(frame);
  if (
    !Number.isInteger(head.status) ||
    (head.status as number) < 100 ||
    (head.status as number) > 599
  ) {
    throw new TunnelProtocolError("invalid status");
  }
  if (head.status === 101) {
    const protocol = head.protocol ?? null;
    if (protocol !== null && typeof protocol !== "string") {
      throw new TunnelProtocolError("invalid WebSocket protocol");
    }
    return { status: 101, protocol };
  }
  const headers = head.headers ?? [];
  if (!isHeaderList(headers)) {
    throw new TunnelProtocolError("invalid header list");
  }
  return { status: head.status as number, headers };
}

/** Encodes a WebSocket message as a frame payload (opcode byte + data). */
export function encodeWsMessage(message: WsMessage): Bytes {
  if (message.op === "close") {
    const reason = new TextEncoder().encode(message.reason);
    if (message.code === null) {
      return new Uint8Array([WS_OPCODE.close]);
    }
    const out = new Uint8Array(3 + reason.length);
    out[0] = WS_OPCODE.close;
    new DataView(out.buffer).setUint16(1, message.code);
    out.set(reason, 3);
    return out;
  }
  return concatBytes(new Uint8Array([WS_OPCODE[message.op]]), message.data);
}

/** Decodes a WebSocket message frame payload. */
export function decodeWsMessage(payload: Uint8Array): WsMessage {
  const op = payload[0];
  const data = payload.slice(1);
  if (op === WS_OPCODE.text) {
    return { op: "text", data };
  }
  if (op === WS_OPCODE.binary) {
    return { op: "binary", data };
  }
  if (op === WS_OPCODE.close) {
    if (data.length === 0) {
      return { op: "close", code: null, reason: "" };
    }
    if (data.length < 2) {
      throw new TunnelProtocolError("truncated close code");
    }
    const code = new DataView(data.buffer, data.byteOffset).getUint16(0);
    return { op: "close", code, reason: new TextDecoder().decode(data.slice(2)) };
  }
  throw new TunnelProtocolError(`unknown WebSocket opcode ${String(op)}`);
}
