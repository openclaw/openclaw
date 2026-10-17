// Voice Call tests cover stream frame adapter plugin behavior.
import { describe, expect, it } from "vitest";
import { StreamFrameAdapter } from "./stream-frame-adapter.js";

describe("Twilio stream frames", () => {
  it("parses Twilio start, media, mark, stop, and ignores junk", () => {
    const adapter = new StreamFrameAdapter("twilio");

    expect(
      adapter.parseInbound(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-stream", callSid: "CA-call" },
        }),
      ),
    ).toEqual({ kind: "start", streamId: "MZ-stream", providerCallId: "CA-call" });

    expect(
      adapter.parseInbound(
        JSON.stringify({
          event: "media",
          media: { payload: "AAA=", timestamp: "20", track: "inbound" },
        }),
      ),
    ).toEqual({
      kind: "media",
      payloadBase64: "AAA=",
      timestampMs: 20,
    });

    expect(
      adapter.parseInbound(JSON.stringify({ event: "mark", mark: { name: "audio-1" } })),
    ).toEqual({ kind: "mark", name: "audio-1" });

    expect(adapter.parseInbound(JSON.stringify({ event: "stop" }))).toEqual({ kind: "stop" });

    expect(adapter.parseInbound("not json")).toEqual({ kind: "ignored" });
    expect(adapter.parseInbound(JSON.stringify({ event: "media" }))).toEqual({ kind: "ignored" });
    expect(
      adapter.parseInbound(JSON.stringify({ event: "start", start: { streamSid: "MZ-only" } })),
    ).toEqual({ kind: "ignored" });
    expect(
      adapter.parseInbound(JSON.stringify({ event: "media", media: { payload: "AAA@@@" } })),
    ).toEqual({ kind: "ignored" });
    expect(
      adapter.parseInbound(JSON.stringify({ event: "media", media: { payload: "-_8" } })),
    ).toEqual({ kind: "media", payloadBase64: "+/8=" });
    expect(
      adapter.parseInbound(
        JSON.stringify({ event: "media", media: { payload: "AAA=", timestamp: "20ms" } }),
      ),
    ).toEqual({ kind: "media", payloadBase64: "AAA=" });
  });
});

describe("Telnyx stream frames", () => {
  it("parses media, mark, and stop with no streamSid", () => {
    const adapter = new StreamFrameAdapter("telnyx");

    expect(
      adapter.parseInbound(
        JSON.stringify({
          event: "media",
          stream_id: "telnyx-stream-7",
          media: { payload: "AAA=", timestamp: 40, track: "inbound_track" },
        }),
      ),
    ).toEqual({
      kind: "media",
      payloadBase64: "AAA=",
      timestampMs: 40,
    });

    expect(
      adapter.parseInbound(JSON.stringify({ event: "mark", mark: { name: "audio-1" } })),
    ).toEqual({ kind: "mark", name: "audio-1" });

    expect(adapter.parseInbound(JSON.stringify({ event: "stop" }))).toEqual({ kind: "stop" });
  });

  it("surfaces Telnyx WS error frames so failures don't get swallowed", () => {
    const adapter = new StreamFrameAdapter("telnyx");

    expect(
      adapter.parseInbound(
        JSON.stringify({
          event: "error",
          stream_id: "telnyx-stream-7",
          payload: {
            code: 100002,
            title: "WebSocket error",
            detail: "Unable to decode payload",
          },
        }),
      ),
    ).toEqual({
      kind: "error",
      code: "100002",
      title: "WebSocket error",
      detail: "Unable to decode payload",
    });
  });

  it("ignores junk and unknown events", () => {
    const adapter = new StreamFrameAdapter("telnyx");
    expect(adapter.parseInbound("not json")).toEqual({ kind: "ignored" });
    expect(adapter.parseInbound(JSON.stringify({ event: "media" }))).toEqual({ kind: "ignored" });
    expect(
      adapter.parseInbound(JSON.stringify({ event: "media", media: { payload: "AAA@@@" } })),
    ).toEqual({ kind: "ignored" });
    expect(adapter.parseInbound(JSON.stringify({ event: "something-else" }))).toEqual({
      kind: "ignored",
    });
  });
});
