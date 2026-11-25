import { describe, expect, it, vi, type Mock } from "vitest";
import type { MatrixClient } from "./sdk.js";
import type { sendMessageMatrix } from "./send.js";

export function createEncryptedMediaPayload() {
  return {
    buffer: Buffer.from("encrypted"),
    file: {
      key: {
        kty: "oct",
        key_ops: ["encrypt", "decrypt"],
        alg: "A256CTR",
        k: "secret",
        ext: true,
      },
      iv: "iv",
      hashes: { sha256: "hash" },
      v: "v2",
    },
  };
}

export const makeClient = () => {
  const sendMessage = vi.fn().mockResolvedValue("evt1");
  const sendEvent = vi.fn().mockResolvedValue("evt-poll-vote");
  const getEvent = vi.fn();
  const getRelations = vi.fn().mockResolvedValue({ events: [], nextBatch: null });
  const getJoinedRoomMembers = vi.fn().mockResolvedValue([]);
  const uploadContent = vi.fn().mockResolvedValue("mxc://example/file");
  const prepareRoomForMessageSend = vi
    .fn<MatrixClient["prepareRoomForMessageSend"]>()
    .mockResolvedValue("m.room.message");
  // SAFETY: This test fixture implements the Matrix client methods exercised by outbound sends.
  const client = {
    sendMessage,
    sendEvent,
    getEvent,
    getRelations,
    getJoinedRoomMembers,
    uploadContent,
    prepareRoomForMessageSend,
    getTransactionScopeId: vi.fn().mockResolvedValue("scope-1"),
    getMessageWireEventType: vi.fn().mockResolvedValue("m.room.message"),
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    prepareForOneOff: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(() => undefined),
    stopAndPersist: vi.fn(async () => undefined),
  } as unknown as MatrixClient;
  return {
    client,
    sendMessage,
    sendEvent,
    getEvent,
    getRelations,
    getJoinedRoomMembers,
    uploadContent,
    prepareRoomForMessageSend,
  };
};

export function makeEncryptedMediaClient() {
  const result = makeClient();
  // SAFETY: The fixture replaces only the crypto methods used by these media-send tests.
  const client = result.client as { crypto?: object };
  client.crypto = {
    encryptMedia: vi.fn().mockResolvedValue(createEncryptedMediaPayload()),
  };
  result.prepareRoomForMessageSend.mockResolvedValue("m.room.encrypted");
  return result;
}

const AIFC_SAMPLE_RATE = 44_100;
const AIFC_PACKET_COUNT = 441;

function buildAiffChunk(type: string, content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(content.length, 4);
  return Buffer.concat([header, content, ...(content.length % 2 ? [Buffer.alloc(1)] : [])]);
}

function buildAifcFixture(
  params: {
    channels?: number;
    codec?: string;
    decodedFrameCount?: boolean;
    malformedSoundData?: boolean;
  } = {},
): Buffer {
  const channels = params.channels ?? 1;
  const codec = params.codec ?? "ima4";
  const compressed = codec === "ima4";
  const samplesPerPacket = compressed ? 64 : 1;
  const bytesPerPacket = compressed ? channels * 34 : channels;
  const declaredFrameCount =
    params.decodedFrameCount || !compressed
      ? AIFC_PACKET_COUNT * samplesPerPacket
      : AIFC_PACKET_COUNT;
  const common = Buffer.alloc(22);
  common.writeUInt16BE(channels, 0);
  common.writeUInt32BE(declaredFrameCount, 2);
  common.writeUInt16BE(compressed ? 0 : 8, 6);
  common.writeUInt16BE(0x400e, 8);
  common.writeUInt16BE(AIFC_SAMPLE_RATE, 10);
  common.write(codec, 18, "ascii");

  const sound = Buffer.alloc(
    8 + AIFC_PACKET_COUNT * bytesPerPacket + (params.malformedSoundData ? 1 : 0),
  );
  const chunks = Buffer.concat([
    // Odd-sized chunks exercise the IFF padding rule before locating COMM.
    buildAiffChunk("JUNK", Buffer.from([0])),
    buildAiffChunk("COMM", common),
    buildAiffChunk("SSND", sound),
  ]);
  const form = Buffer.alloc(12);
  form.write("FORM", 0, "ascii");
  form.writeUInt32BE(chunks.length + 4, 4);
  form.write("AIFC", 8, "ascii");
  return Buffer.concat([form, chunks]);
}

export function registerMatrixMediaTests(context: {
  send: (
    text: string,
    opts?: Partial<Parameters<typeof sendMessageMatrix>[2]>,
  ) => ReturnType<typeof sendMessageMatrix>;
  sentContent: (index?: number) => Record<string, unknown>;
  loadOutboundMediaFromUrlMock: Mock;
  mediaKindFromMimeMock: Mock;
  isVoiceCompatibleAudioMock: Mock;
  readonly sendMessage: ReturnType<typeof makeClient>["sendMessage"];
}) {
  describe("sendMessageMatrix media", () => {
    it("propagates initial room preparation failure before loading or reporting dispatch", async () => {
      const { client, uploadContent, sendMessage, prepareRoomForMessageSend } = makeClient();
      const failure = new Error("room preparation failed");
      prepareRoomForMessageSend.mockRejectedValue(failure);
      const onPlatformSendDispatch = vi.fn();
      await expect(
        context.send("secret", {
          client,
          mediaUrl: "file:///tmp/photo.png",
          onPlatformSendDispatch,
        }),
      ).rejects.toBe(failure);
      expect(onPlatformSendDispatch).not.toHaveBeenCalled();
      expect(context.loadOutboundMediaFromUrlMock).not.toHaveBeenCalled();
      expect(uploadContent).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      "rechecks room preparation after media loading (crypto=%s)",
      async (crypto) => {
        const failure = new Error("room preparation failed after media loading");
        const { client, uploadContent, sendMessage, prepareRoomForMessageSend } = crypto
          ? makeEncryptedMediaClient()
          : makeClient();
        prepareRoomForMessageSend.mockResolvedValue("m.room.message");
        context.loadOutboundMediaFromUrlMock.mockImplementationOnce(async () => {
          if (crypto) {
            prepareRoomForMessageSend.mockResolvedValue("m.room.encrypted");
          } else {
            prepareRoomForMessageSend.mockRejectedValue(failure);
          }
          return {
            buffer: Buffer.from("secret media"),
            fileName: "secret.png",
            contentType: "image/png",
            kind: "image",
          };
        });
        const onPlatformSendDispatch = vi.fn();
        const sending = context.send("secret", {
          client,
          mediaUrl: "file:///tmp/secret.png",
          onPlatformSendDispatch,
        });
        if (crypto) {
          await sending;
          expect(uploadContent).toHaveBeenCalledWith(
            Buffer.from("encrypted"),
            "application/octet-stream",
          );
          const content = sendMessage.mock.calls[0]?.[1];
          expect(content).toHaveProperty("file", expect.anything());
          expect(content).not.toHaveProperty("url");
        } else {
          await expect(sending).rejects.toBe(failure);
          expect(uploadContent).not.toHaveBeenCalled();
          expect(sendMessage).not.toHaveBeenCalled();
          expect(onPlatformSendDispatch).not.toHaveBeenCalled();
        }
      },
    );
  });

  describe("sendMessageMatrix media metadata", () => {
    it.each([
      ["mono IMA4 packet count", { channels: 1 }, 640],
      ["stereo IMA4 packet count", { channels: 2 }, 640],
      ["already decoded IMA4 frames", { decodedFrameCount: true }, 640],
      ["non-IMA4 alaw", { codec: "alaw" }, 10],
      ["non-IMA4 ulaw", { codec: "ulaw" }, 10],
      ["malformed IMA4 packets", { malformedSoundData: true }, 10],
    ] as const)("sends AIFC media with %s duration", async (_name, options, duration) => {
      context.loadOutboundMediaFromUrlMock.mockResolvedValueOnce({
        buffer: buildAifcFixture(options),
        contentType: "audio/aiff",
        fileName: "clip.aifc",
        kind: "audio",
      });
      context.mediaKindFromMimeMock.mockReturnValue("audio");
      await context.send("", { mediaUrl: "clip.aifc" });
      expect(context.sentContent().info).toMatchObject({ duration });
    });

    it("preserves zero media sizes and rounded durations without mutating loaded media", async () => {
      const samples = [
        { buffer: Buffer.alloc(0), fileName: undefined, contentType: "video/webm", kind: "video" },
        {
          // One 16-bit mono PCM sample at 44,100 Hz rounds to zero milliseconds.
          buffer: Buffer.from(
            "524946462600000057415645666d7420100000000100010044ac0000885801000200100064617461020000000000",
            "hex",
          ),
          fileName: "sample.wav",
          contentType: "audio/wav",
          kind: "audio",
        },
      ];
      for (const [index, media] of samples.entries()) {
        const before = { ...media, buffer: Buffer.from(media.buffer) };
        context.mediaKindFromMimeMock.mockReturnValue(media.kind);
        context.loadOutboundMediaFromUrlMock.mockResolvedValueOnce(media);
        await context.send("", { mediaUrl: "synthetic-media" });
        expect(context.sentContent(index).msgtype).toBe(index === 0 ? "m.video" : "m.audio");
        expect(context.sentContent(index).info).toStrictEqual(
          index === 0
            ? { size: 0, mimetype: "video/webm" }
            : { size: 46, mimetype: "audio/wav", duration: 0 },
        );
        expect(media).toStrictEqual(before);
      }
      expect(context.sentContent(0)).toHaveProperty("filename", undefined);
      expect(context.sentContent(0).body).toBe("(file)");
    });

    it.each([false, true])(
      "preserves audio delivery and voice transcript relations (compatible=%s)",
      async (compatible) => {
        context.mediaKindFromMimeMock.mockReturnValue("audio");
        context.isVoiceCompatibleAudioMock.mockReturnValue(compatible);
        const fileName = compatible ? "clip.mp3" : "clip.wav";
        context.loadOutboundMediaFromUrlMock.mockResolvedValueOnce({
          buffer: Buffer.from("audio"),
          fileName,
          contentType: compatible ? "audio/mpeg" : "audio/wav",
          kind: "audio",
        });
        context.sendMessage
          .mockReset()
          .mockResolvedValueOnce("$voice")
          .mockResolvedValueOnce("$transcript");
        const result = await context.send("voice caption", {
          mediaUrl: `file:///tmp/${fileName}`,
          audioAsVoice: true,
          replyToId: compatible ? "$reply" : undefined,
        });
        if (compatible) {
          expect(context.sentContent(1).body).toBe("voice caption");
          expect(context.sentContent(1)["m.relates_to"]).toEqual({
            "m.in_reply_to": { event_id: "$reply" },
          });
          expect(result.receipt.parts).toMatchObject([
            { platformMessageId: "$voice", kind: "voice", index: 0, replyToId: "$reply" },
            { platformMessageId: "$transcript", kind: "text", index: 1, replyToId: "$reply" },
          ]);
        } else {
          expect(context.sendMessage).toHaveBeenCalledTimes(1);
          expect(context.sentContent()).toMatchObject({
            msgtype: "m.audio",
            body: "voice caption",
          });
          expect(context.sentContent()["org.matrix.msc3245.voice"]).toBeUndefined();
        }
      },
    );
  });
}
