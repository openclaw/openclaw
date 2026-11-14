import { describe, expect, it, vi, type Mock } from "vitest";
import type { MatrixClient, MessageEventContent } from "./sdk.js";
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
  const prepareRoomForMessageSend = vi.fn();
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
  prepareRoomForMessageSend.mockImplementation(
    async (roomId: string, content?: MessageEventContent) => {
      const eventType = await client.getMessageWireEventType(roomId);
      if (eventType === "m.room.encrypted" && !client.crypto) {
        throw new Error("Encrypted Matrix room: enable encryption before sending messages");
      }
      if (
        eventType === "m.room.encrypted" &&
        (typeof content?.url === "string" ||
          (content?.info &&
            "thumbnail_url" in content.info &&
            typeof content.info.thumbnail_url === "string"))
      ) {
        throw new Error("Encrypted Matrix room contains unencrypted media; retry the send");
      }
      return eventType;
    },
  );
  return {
    client,
    sendMessage,
    sendEvent,
    getEvent,
    getRelations,
    getJoinedRoomMembers,
    uploadContent,
  };
};

export function makeEncryptedMediaClient() {
  const result = makeClient();
  // SAFETY: The fixture replaces only the crypto methods used by these media-send tests.
  const client = result.client as { crypto?: object };
  client.crypto = {
    encryptMedia: vi.fn().mockResolvedValue(createEncryptedMediaPayload()),
  };
  vi.spyOn(result.client, "getMessageWireEventType").mockResolvedValue("m.room.encrypted");
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

export function registerMatrixMediaMetadataTests(context: {
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
