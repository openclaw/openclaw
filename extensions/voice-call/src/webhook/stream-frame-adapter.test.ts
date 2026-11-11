import { describe, expect, it } from "vitest";
import { StreamFrameAdapter } from "./stream-frame-adapter.js";

function parseWith(provider: "twilio" | "telnyx") {
  const adapter = new StreamFrameAdapter(provider);
  return (frame: unknown) => adapter.parseInbound(JSON.stringify(frame));
}

describe("StreamFrameAdapter", () => {
  it("parses Twilio start, media, mark, stop, and ignores junk", () => {
    const parse = parseWith("twilio");

    expect(
      parse({ event: "start", start: { streamSid: "MZ-stream", callSid: "CA-call" } }),
    ).toEqual({ kind: "start", streamId: "MZ-stream", providerCallId: "CA-call" });

    expect(
      parse({ event: "media", media: { payload: "AAA=", timestamp: "20", track: "inbound" } }),
    ).toEqual({ kind: "media", payloadBase64: "AAA=", timestampMs: 20 });
    expect(parse({ event: "mark", mark: { name: "audio-1" } })).toEqual({
      kind: "mark",
      name: "audio-1",
    });
    expect(parse({ event: "stop" })).toEqual({ kind: "stop" });
    expect(new StreamFrameAdapter("twilio").parseInbound("not json")).toEqual({ kind: "ignored" });
    expect(parse({ event: "media" })).toEqual({ kind: "ignored" });
    expect(parse({ event: "start", start: { streamSid: "MZ-only" } })).toEqual({ kind: "ignored" });
    expect(parse({ event: "media", media: { payload: "AAA@@@" } })).toEqual({ kind: "ignored" });
    expect(parse({ event: "media", media: { payload: "-_8" } })).toEqual({
      kind: "media",
      payloadBase64: "+/8=",
    });
    expect(parse({ event: "media", media: { payload: "AAA=", timestamp: "20ms" } })).toEqual({
      kind: "media",
      payloadBase64: "AAA=",
    });
  });
  it("parses Telnyx media, mark, and stop with no streamSid", () => {
    const parse = parseWith("telnyx");

    expect(
      parse({
        event: "media",
        stream_id: "telnyx-stream-7",
        media: { payload: "AAA=", timestamp: 40, track: "inbound_track" },
      }),
    ).toEqual({ kind: "media", payloadBase64: "AAA=", timestampMs: 40 });
    expect(parse({ event: "mark", mark: { name: "audio-1" } })).toEqual({
      kind: "mark",
      name: "audio-1",
    });
    expect(parse({ event: "stop" })).toEqual({ kind: "stop" });
  });

  it("surfaces Telnyx WS error frames so failures don't get swallowed", () => {
    const parse = parseWith("telnyx");

    expect(
      parse({
        event: "error",
        stream_id: "telnyx-stream-7",
        payload: {
          code: 100002,
          title: "WebSocket error",
          detail: "Unable to decode payload",
        },
      }),
    ).toEqual({
      kind: "error",
      code: "100002",
      title: "WebSocket error",
      detail: "Unable to decode payload",
    });
  });

  it("ignores junk and unknown events", () => {
    const parse = parseWith("telnyx");
    expect(new StreamFrameAdapter("telnyx").parseInbound("not json")).toEqual({ kind: "ignored" });
    expect(parse({ event: "media" })).toEqual({ kind: "ignored" });
    expect(parse({ event: "media", media: { payload: "AAA@@@" } })).toEqual({ kind: "ignored" });
    expect(parse({ event: "something-else" })).toEqual({
      kind: "ignored",
    });
  });
});
