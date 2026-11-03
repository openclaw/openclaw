import { describe, expect, it } from "vitest";
import { utf8 } from "../bytes.js";
import { MAX_FRAME_BYTES, WS_OPCODE } from "./constants.js";
import {
  decodeWsMessage,
  encodeFrame,
  encodeHead,
  encodeWsMessage,
  FrameDecoder,
  parseRequestHead,
  parseResponseHead,
  TunnelProtocolError,
} from "./framing.js";
import { stripClientHeaders, syntheticPeerAddress } from "./headers.js";

describe("framing", () => {
  it("decodes frames split across arbitrary chunk boundaries", () => {
    const wire = new Uint8Array([
      ...encodeFrame(utf8("hello")),
      ...encodeFrame(new Uint8Array(0)),
      ...encodeFrame(utf8("!")),
    ]);
    const decoder = new FrameDecoder();
    const frames = [...wire].flatMap((byte) => decoder.push(new Uint8Array([byte])));
    expect(frames.map((frame) => new TextDecoder().decode(frame))).toEqual(["hello", "", "!"]);
    expect(decoder.hasPartialFrame).toBe(false);
  });

  it("refuses a declared length above 32 MiB before buffering the payload", () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1);
    expect(() => new FrameDecoder().push(header)).toThrow(TunnelProtocolError);
    expect(() => encodeFrame(new Uint8Array(5), 4)).toThrow(TunnelProtocolError);
  });
});

describe("HEAD frames", () => {
  it("round-trips request and response heads", () => {
    const http = {
      kind: "http",
      method: "POST",
      path: "/claw/api",
      headers: [["content-type", "application/json"]],
    } as const;
    expect(
      parseRequestHead(encodeHead({ ...http, headers: [["content-type", "application/json"]] })),
    ).toEqual(http);
    expect(
      parseRequestHead(
        encodeHead({ kind: "ws", path: "/ws", headers: [], protocols: ["openclaw"] }),
      ),
    ).toMatchObject({ kind: "ws" });
    expect(parseResponseHead(encodeHead({ status: 101, protocol: null }))).toEqual({
      status: 101,
      protocol: null,
    });
    expect(parseResponseHead(encodeHead({ status: 404, headers: [] }))).toEqual({
      status: 404,
      headers: [],
    });
  });

  it("rejects relative paths, bad methods and non-JSON", () => {
    expect(() =>
      parseRequestHead(utf8('{"kind":"http","method":"GET","path":"claw","headers":[]}')),
    ).toThrow(TunnelProtocolError);
    expect(() =>
      parseRequestHead(utf8('{"kind":"http","method":"G T","path":"/","headers":[]}')),
    ).toThrow(TunnelProtocolError);
    expect(() => parseRequestHead(utf8("not json"))).toThrow(TunnelProtocolError);
  });
});

describe("WebSocket messages", () => {
  it("encodes opcode-prefixed messages and close frames", () => {
    expect(encodeWsMessage({ op: "text", data: utf8("hi") })[0]).toBe(WS_OPCODE.text);
    expect(decodeWsMessage(encodeWsMessage({ op: "close", code: 1000, reason: "bye" }))).toEqual({
      op: "close",
      code: 1000,
      reason: "bye",
    });
    expect(() => decodeWsMessage(new Uint8Array([9]))).toThrow(TunnelProtocolError);
  });
});

describe("ingress headers", () => {
  it("strips client identity, forwarding, ingress-owned and Connection-listed headers", () => {
    const kept = stripClientHeaders(
      [
        ["Connection", "keep-alive, X-Custom"],
        ["X-Custom", "1"],
        ["X-Forwarded-User", "admin"],
        ["X-OpenClaw-Id-Peer-Key", "iroh:00"],
        ["Forwarded", "for=1.2.3.4"],
        ["Origin", "https://studio-k7x2q.crabd.me"],
        ["Sec-WebSocket-Key", "abc"],
      ],
      "ws",
    );
    expect(kept).toEqual([["Origin", "https://studio-k7x2q.crabd.me"]]);
  });

  it("derives the spike-compatible synthetic peer address", async () => {
    // Expected value produced by the spike ingress (iroh-ingress/src/headers.js peerAddress).
    expect(await syntheticPeerAddress(`iroh:${"ab".repeat(32)}`)).toBe(
      "fd69:726f:6800:271a:413b:d339:c570:9fdc",
    );
  });
});
