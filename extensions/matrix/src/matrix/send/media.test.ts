import { expect, it } from "vitest";
import { buildMediaContent, resolveMediaDurationMs } from "./media.js";

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

it.each([
  ["mono IMA4 packet count", { channels: 1 }, 640],
  ["stereo IMA4 packet count", { channels: 2 }, 640],
  ["already decoded IMA4 frames", { decodedFrameCount: true }, 640],
  ["non-IMA4 alaw", { codec: "alaw" }, 10],
  ["non-IMA4 ulaw", { codec: "ulaw" }, 10],
  ["malformed IMA4 packets", { malformedSoundData: true }, 10],
] as const)("resolveMediaDurationMs: %s", async (_name, options, duration) => {
  await expect(
    resolveMediaDurationMs({
      buffer: buildAifcFixture(options),
      contentType: "audio/aiff",
      fileName: "clip.aifc",
      kind: "audio",
    }),
  ).resolves.toBe(duration);
});

it.each([
  {
    name: "zero duration",
    metadata: { size: 0, mimetype: "video/webm", durationMs: 0 },
    info: { size: 0, mimetype: "video/webm", duration: 0 },
  },
  {
    name: "image field precedence before the duration override",
    metadata: {
      size: 10,
      mimetype: "video/webm",
      imageInfo: { size: undefined, mimetype: "image/webp", w: 2, h: 1 },
      durationMs: 0,
    },
    info: { size: undefined, mimetype: "image/webp", w: 2, h: 1, duration: 0 },
  },
])("buildMediaContent preserves $name", ({ metadata, info }) => {
  const before = structuredClone(metadata);

  expect(buildMediaContent({ msgtype: "m.video", body: "clip", ...metadata })).toStrictEqual({
    msgtype: "m.video",
    body: "clip",
    filename: undefined,
    info,
  });
  expect(metadata).toStrictEqual(before);
});
