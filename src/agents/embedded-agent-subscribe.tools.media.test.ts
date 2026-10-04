import { describe, expect, it } from "vitest";
import {
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
} from "./embedded-agent-tool-media.js";
import { markCoreTtsToolResult } from "./tools/tts-tool-result-provenance.js";

describe("extractToolResultMediaArtifact", () => {
  it("does not deliver explicitly private image results", () => {
    expect(
      extractToolResultMediaArtifact({
        content: [{ type: "image", data: "base64data", mimeType: "image/png" }],
        details: { path: "/tmp/browser-screenshot.png", media: { outbound: false } },
      }),
    ).toBeUndefined();
  });

  it("aligns generated attachment metadata with deduplicated media references", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            mediaUrls: [" /tmp/song.mp3 ", "/tmp/cover.png", "/tmp/song.mp3"],
            audioAsVoice: true,
            trustedLocalMedia: true,
            attachments: [
              { type: "image", path: "/tmp/cover.png", name: "cover.png", width: 640, height: 480 },
              {
                type: "audio",
                path: "/tmp/song.mp3",
                name: "friendly-song.mp3",
                mimeType: "audio/mpeg",
                durationMs: 2_000,
                trustedLocalMedia: true,
              },
            ],
          },
        },
      }),
    ).toEqual({
      mediaUrls: ["/tmp/song.mp3", "/tmp/cover.png"],
      audioAsVoice: true,
      trustedLocalMedia: true,
      attachments: [
        {
          type: "audio",
          path: "/tmp/song.mp3",
          name: "friendly-song.mp3",
          mimeType: "audio/mpeg",
          durationMs: 2_000,
        },
        { type: "image", path: "/tmp/cover.png", name: "cover.png", width: 640, height: 480 },
      ],
    });
  });

  it("drops malformed metadata while preserving valid media references", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            attachments: [
              {
                type: "document",
                path: "/tmp/generated.mp3",
                url: false,
                mediaUrl: {},
                filePath: 12,
                mimeType: 7,
                name: 1,
                sizeBytes: Infinity,
                durationMs: -1,
                width: "1920",
                height: Number.NaN,
                trustedLocalMedia: true,
              },
              {
                type: "audio",
                path: "/tmp/empty.mp3",
                sizeBytes: 0,
                durationMs: 0,
                width: 0,
                height: 0,
              },
            ],
          },
        },
      }),
    ).toEqual({
      mediaUrls: ["/tmp/generated.mp3", "/tmp/empty.mp3"],
      attachments: [
        { path: "/tmp/generated.mp3" },
        { type: "audio", path: "/tmp/empty.mp3", sizeBytes: 0, durationMs: 0 },
      ],
    });
  });

  it("uses the image fallback path rather than media-looking text", () => {
    expect(
      extractToolResultMediaArtifact({
        content: [
          { type: "text", text: "MEDIA:/tmp/unrelated.png" },
          { type: "image", data: "base64data", mimeType: "image/png" },
        ],
        details: { path: " /tmp/screenshot.png " },
      }),
    ).toEqual({ mediaUrls: ["/tmp/screenshot.png"] });
  });

  it("ignores details.path and media-looking text without an image", () => {
    expect(
      extractToolResultMediaArtifact({
        content: [null, undefined, { type: "text", text: "MEDIA:/tmp/ok.png" }],
        details: { path: "/tmp/data.json" },
      }),
    ).toBeUndefined();
  });

  it("does not deliver empty structured media or image content without a fallback path", () => {
    expect(
      extractToolResultMediaArtifact({
        details: { media: {} },
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", data: "base64data", mimeType: "image/png" },
        ],
      }),
    ).toBeUndefined();
  });
});

describe("filterToolResultMediaUrls", () => {
  it("trusts core image generation without a run-local tool set", () => {
    expect(filterToolResultMediaUrls("image_generate", ["/tmp/image.png"])).toEqual([
      "/tmp/image.png",
    ]);
  });

  it("keeps only attested TTS local media when the raw built-in name is absent", () => {
    const result = markCoreTtsToolResult(
      { details: { media: { mediaUrl: "/tmp/reply.opus", trustedLocalMedia: true } } },
      ["/tmp/reply.opus"],
    );
    expect(
      filterToolResultMediaUrls(
        "tts",
        ["/tmp/reply.opus", "/tmp/unattested.opus", "https://example.com/audio.opus"],
        result,
        new Set(["web_search"]),
      ),
    ).toEqual(["/tmp/reply.opus", "https://example.com/audio.opus"]);
  });

  it("filters local media from unregistered plugin tools", () => {
    expect(
      filterToolResultMediaUrls("plugin_media_tool", [
        "/tmp/private.png",
        "https://example.com/image.png",
      ]),
    ).toEqual(["https://example.com/image.png"]);
  });

  it("keeps local media for exact plugin names trusted in this run", () => {
    expect(
      filterToolResultMediaUrls(
        "plugin_media_tool",
        ["/tmp/meeting.wav"],
        undefined,
        new Set(["plugin_media_tool"]),
      ),
    ).toEqual(["/tmp/meeting.wav"]);
  });

  it("does not let trustedLocalMedia bypass the exact-name gate", () => {
    expect(
      filterToolResultMediaUrls(
        "Web_Search",
        ["/etc/passwd", "https://example.com/file.png"],
        { details: { media: { mediaUrl: "/etc/passwd", trustedLocalMedia: true } } },
        new Set(["web_search"]),
      ),
    ).toEqual(["https://example.com/file.png"]);
  });

  it("does not trust external TTS results with trustedLocalMedia", () => {
    expect(
      filterToolResultMediaUrls("tts", ["/tmp/reply.opus", "https://example.com/audio.opus"], {
        details: {
          mcpServer: "probe",
          mcpTool: "tts",
          media: { mediaUrl: "/tmp/reply.opus", trustedLocalMedia: true },
        },
      }),
    ).toEqual(["https://example.com/audio.opus"]);
  });
});
