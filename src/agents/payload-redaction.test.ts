import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { sanitizeDiagnosticPayload } from "./payload-redaction.js";

const MEDIA_DATA = "QUJDRA==";
const MEDIA_BYTES = [65, 66, 67, 68];
const MEDIA_SUMMARY = {
  bytes: 4,
  sha256: crypto.createHash("sha256").update(MEDIA_DATA).digest("hex"),
};
const BYTE_MEDIA_SUMMARY = {
  bytes: 4,
  sha256: crypto.createHash("sha256").update(new Uint8Array(MEDIA_BYTES)).digest("hex"),
};

describe("sanitizeDiagnosticPayload", () => {
  it("redacts typed media bytes without changing ordinary data and blob fields", () => {
    expect(
      sanitizeDiagnosticPayload({
        media: [
          { type: "audio", data: MEDIA_DATA },
          { mimeType: "video/mp4", blob: MEDIA_DATA },
          { type: "image", source: { data: MEDIA_DATA } },
          { type: "video", data: MEDIA_BYTES },
          { type: "video_frame", data: MEDIA_DATA },
          { type: "image_generation_call", result: MEDIA_DATA },
        ],
        wrappers: [
          { videos: [{ url: "https://media.invalid/private/path-token" }] },
          { audio: { data: MEDIA_DATA } },
          { video: { blob: MEDIA_DATA } },
          { video_frame: { data: MEDIA_DATA } },
          { videoFrame: { data: MEDIA_DATA } },
          { inputVideoFrame: { data: MEDIA_DATA } },
          { output_audio: { data: MEDIA_DATA } },
        ],
        ordinary: { audioCodec: { data: [...MEDIA_BYTES] }, data: MEDIA_BYTES, blob: MEDIA_DATA },
      }),
    ).toEqual({
      media: [
        { type: "audio", data: "<redacted>", ...MEDIA_SUMMARY },
        { mimeType: "video/mp4", blob: "<redacted>", ...MEDIA_SUMMARY },
        { type: "image", source: { data: "<redacted>", ...MEDIA_SUMMARY } },
        { type: "video", data: "<redacted>", ...BYTE_MEDIA_SUMMARY },
        { type: "video_frame", data: "<redacted>", ...MEDIA_SUMMARY },
        { type: "image_generation_call", result: "<redacted>", ...MEDIA_SUMMARY },
      ],
      wrappers: [
        { videos: "<redacted>" },
        { audio: { data: "<redacted>", ...MEDIA_SUMMARY } },
        { video: { blob: "<redacted>", ...MEDIA_SUMMARY } },
        { video_frame: { data: "<redacted>", ...MEDIA_SUMMARY } },
        { videoFrame: { data: "<redacted>", ...MEDIA_SUMMARY } },
        { inputVideoFrame: { data: "<redacted>", ...MEDIA_SUMMARY } },
        { output_audio: { data: "<redacted>", ...MEDIA_SUMMARY } },
      ],
      ordinary: { audioCodec: { data: [...MEDIA_BYTES] }, data: MEDIA_BYTES, blob: MEDIA_DATA },
    });
  });

  it.each([{ name: "Uint8Array", payload: new Uint8Array([4, 5, 6]), bytes: [4, 5, 6] }])(
    "redacts a bare $name by value",
    ({ payload, bytes }) => {
      const sanitized = sanitizeDiagnosticPayload(payload);

      expect(sanitized).toEqual({
        redacted: "<redacted>",
        bytes: bytes.length,
        sha256: crypto.createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
      });
      expect(JSON.stringify(sanitized)).not.toMatch(/"[0-9]+":(?:[0-9]+|\{)/u);
    },
  );
});
