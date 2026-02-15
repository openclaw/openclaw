import { describe, expect, it, vi } from "vitest";
import { summarizeMatrixRawEvent } from "./summary.js";
import { EventType, type MatrixRawEvent } from "./types.js";

describe("summarizeMatrixRawEvent", () => {
  it("keeps legacy payload when includeMedia is omitted", () => {
    const event: MatrixRawEvent = {
      event_id: "$event1",
      sender: "@alice:example.org",
      type: EventType.RoomMessage,
      origin_server_ts: 1700000000000,
      content: {
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example.org/audio1",
      },
    };

    const summary = summarizeMatrixRawEvent(event);
    expect(summary.media).toBeUndefined();
    expect(summary.body).toBe("voice.ogg");
    expect(summary.msgtype).toBe("m.audio");
  });

  it("includes mxc and downloadable url when includeMedia=true", () => {
    const event: MatrixRawEvent = {
      event_id: "$event2",
      sender: "@alice:example.org",
      type: EventType.RoomMessage,
      origin_server_ts: 1700000001000,
      content: {
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example.org/audio2",
        info: {
          mimetype: "audio/ogg",
          size: 12345,
          duration: 6789,
        },
      },
    };

    const mxcToHttp = vi
      .fn()
      .mockReturnValue("https://matrix.example.org/_matrix/media/v3/download/example.org/audio2");

    const summary = summarizeMatrixRawEvent(event, {
      includeMedia: true,
      client: { mxcToHttp },
    });

    expect(summary.media).toEqual({
      mxcUrl: "mxc://example.org/audio2",
      downloadUrl: "https://matrix.example.org/_matrix/media/v3/download/example.org/audio2",
      encrypted: false,
      contentType: "audio/ogg",
      sizeBytes: 12345,
      durationMs: 6789,
    });
    expect(mxcToHttp).toHaveBeenCalledWith("mxc://example.org/audio2");
  });

  it("extracts encrypted media url from content.file", () => {
    const event: MatrixRawEvent = {
      event_id: "$event3",
      sender: "@alice:example.org",
      type: EventType.RoomMessage,
      origin_server_ts: 1700000002000,
      content: {
        msgtype: "m.audio",
        body: "secret.ogg",
        file: {
          url: "mxc://example.org/encrypted-audio",
          iv: "x",
        },
      },
    };

    const summary = summarizeMatrixRawEvent(event, {
      includeMedia: true,
      client: { mxcToHttp: (mxc) => `https://download/${mxc}` },
    });

    expect(summary.media?.mxcUrl).toBe("mxc://example.org/encrypted-audio");
    expect(summary.media?.encrypted).toBe(true);
    expect(summary.media?.downloadUrl).toBe("https://download/mxc://example.org/encrypted-audio");
  });

  it("prioritizes plain mxc if both present, setting encrypted=false", () => {
    const event: MatrixRawEvent = {
      event_id: "$event4",
      sender: "@bob:example.org",
      type: EventType.RoomMessage,
      origin_server_ts: 1700000003000,
      content: {
        msgtype: "m.image",
        body: "image.png",
        url: "mxc://example.org/plain-image",
        file: {
          url: "mxc://example.org/encrypted-image",
          iv: "y",
        },
      },
    };

    const summary = summarizeMatrixRawEvent(event, {
      includeMedia: true,
      client: { mxcToHttp: (mxc) => `https://download/${mxc}` },
    });

    expect(summary.media?.mxcUrl).toBe("mxc://example.org/plain-image");
    expect(summary.media?.encrypted).toBe(false);
  });
});
