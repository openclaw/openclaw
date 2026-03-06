import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, type MatrixRawEvent } from "./types.js";

const resolveActionClientMock = vi.fn();
const resolveMatrixRoomIdMock = vi.fn(async (_client: unknown, roomId: string) => roomId);

vi.mock("./client.js", () => ({
  resolveActionClient: (...args: unknown[]) => resolveActionClientMock(...args),
}));

vi.mock("../send.js", () => ({
  resolveMatrixRoomId: (...args: unknown[]) => resolveMatrixRoomIdMock(...args),
  sendMessageMatrix: vi.fn(),
}));

import { readMatrixMessages } from "./messages.js";

describe("readMatrixMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns media metadata when includeMedia=true", async () => {
    const event: MatrixRawEvent = {
      event_id: "$audio",
      sender: "@alice:example.org",
      type: EventType.RoomMessage,
      origin_server_ts: 1700000000000,
      content: {
        msgtype: "m.audio",
        body: "voice.ogg",
        url: "mxc://example.org/audio",
        info: {
          mimetype: "audio/ogg",
          size: 42,
        },
      },
    };

    const client = {
      doRequest: vi.fn().mockResolvedValue({
        chunk: [event],
        start: "start-token",
        end: "end-token",
      }),
      mxcToHttp: vi
        .fn()
        .mockReturnValue("https://matrix.example.org/_matrix/media/v3/download/example.org/audio"),
      stop: vi.fn(),
    };

    resolveActionClientMock.mockResolvedValue({
      client,
      stopOnDone: false,
    });

    const result = await readMatrixMessages("!room:example.org", {
      includeMedia: true,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.media).toEqual({
      mxcUrl: "mxc://example.org/audio",
      downloadUrl: "https://matrix.example.org/_matrix/media/v3/download/example.org/audio",
      encrypted: false,
      contentType: "audio/ogg",
      sizeBytes: 42,
      durationMs: undefined,
    });
  });

  it("preserves old response shape by default", async () => {
    const event: MatrixRawEvent = {
      event_id: "$audio2",
      sender: "@alice:example.org",
      type: EventType.RoomMessage,
      origin_server_ts: 1700000001000,
      content: {
        msgtype: "m.audio",
        body: "voice2.ogg",
        url: "mxc://example.org/audio2",
      },
    };

    const client = {
      doRequest: vi.fn().mockResolvedValue({
        chunk: [event],
        start: "start-token",
        end: "end-token",
      }),
      mxcToHttp: vi.fn(),
      stop: vi.fn(),
    };

    resolveActionClientMock.mockResolvedValue({
      client,
      stopOnDone: false,
    });

    const result = await readMatrixMessages("!room:example.org");

    expect(result.messages[0]?.body).toBe("voice2.ogg");
    expect(result.messages[0]?.msgtype).toBe("m.audio");
    expect(result.messages[0]?.media).toBeUndefined();
    expect(client.mxcToHttp).not.toHaveBeenCalled();
  });
});
