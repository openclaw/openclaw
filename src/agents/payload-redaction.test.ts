import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sanitizeDiagnosticPayload } from "./payload-redaction.js";

describe("sanitizeDiagnosticPayload", () => {
  const mediaData = "dmlkZW8tYnl0ZXM=";
  const mediaDigest = createHash("sha256").update(mediaData).digest("hex");

  it.each([
    { type: "image", mimeType: "image/png" },
    { type: "video", mimeType: "video/mp4" },
    { type: "video", label: "native video without MIME metadata" },
    { type: "base64", mimeType: "video/webm" },
    { type: "base64", media_type: "video/mp4" },
    { type: "base64", mime_type: "video/quicktime" },
  ])("redacts inline image and video data while preserving metadata: %j", (metadata) => {
    const redacted = sanitizeDiagnosticPayload({
      messages: [{ role: "user", content: [{ ...metadata, data: mediaData }] }],
    });

    expect(redacted).toEqual({
      messages: [
        {
          role: "user",
          content: [
            {
              ...metadata,
              data: "<redacted>",
              bytes: 11,
              sha256: mediaDigest,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(redacted)).not.toContain(mediaData);
  });

  it("redacts nested video sources without dropping surrounding metadata", () => {
    const redacted = sanitizeDiagnosticPayload({
      type: "video",
      source: { type: "base64", media_type: "video/mp4", data: mediaData },
      durationSeconds: 12,
    });

    expect(redacted).toEqual({
      type: "video",
      source: {
        type: "base64",
        media_type: "video/mp4",
        data: "<redacted>",
        bytes: 11,
        sha256: mediaDigest,
      },
      durationSeconds: 12,
    });
    expect(JSON.stringify(redacted)).not.toContain(mediaData);
  });

  it.each([
    {
      block: {
        type: "video_url",
        video_url: { url: `data:video/mp4;base64,${mediaData}`, detail: "high" },
      },
      expected: {
        type: "video_url",
        video_url: {
          url: "<redacted>",
          detail: "high",
          mimeType: "video/mp4",
          bytes: 11,
          sha256: mediaDigest,
        },
      },
    },
    {
      block: { type: "input_video", video_url: `data:video/webm;base64,${mediaData}` },
      expected: {
        type: "input_video",
        video_url: "<redacted>",
        mimeType: "video/webm",
        bytes: 11,
        sha256: mediaDigest,
      },
    },
    {
      block: {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${mediaData}`, detail: "auto" },
      },
      expected: {
        type: "image_url",
        image_url: {
          url: "<redacted>",
          detail: "auto",
          mimeType: "image/png",
          bytes: 11,
          sha256: mediaDigest,
        },
      },
    },
    {
      block: { type: "input_image", image_url: `data:image/jpeg;base64,${mediaData}` },
      expected: {
        type: "input_image",
        image_url: "<redacted>",
        mimeType: "image/jpeg",
        bytes: 11,
        sha256: mediaDigest,
      },
    },
  ])("redacts provider wire data URLs without losing MIME metadata: %j", ({ block, expected }) => {
    const redacted = sanitizeDiagnosticPayload({ content: [block] });

    expect(redacted).toEqual({ content: [expected] });
    expect(JSON.stringify(redacted)).not.toContain(mediaData);
  });

  it("preserves remote media URLs and unrelated textual or document data URLs", () => {
    const payload = {
      content: [
        { type: "video_url", video_url: { url: "https://example.test/video.mp4" } },
        { type: "input_image", image_url: "https://example.test/image.png" },
        { type: "text", text: `data:video/mp4;base64,${mediaData}` },
        { type: "document", document_url: `data:application/pdf;base64,${mediaData}` },
        { type: "image_url", image_url: { url: `data:video/mp4;base64,${mediaData}` } },
      ],
    };

    expect(sanitizeDiagnosticPayload(payload)).toEqual(payload);
  });

  it("preserves non-media data fields", () => {
    const document = { type: "document", mimeType: "application/pdf", data: mediaData };

    expect(sanitizeDiagnosticPayload(document)).toEqual(document);
  });
});
