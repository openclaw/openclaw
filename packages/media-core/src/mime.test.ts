import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";
import { mediaKindFromMime } from "./constants.js";
import {
  detectMime,
  extensionForMime,
  FILE_TYPE_SNIFF_MAX_BYTES,
  getFileExtension,
  imageMimeFromFormat,
  isAudioFileName,
  isGifMedia,
  kindFromMime,
  mimeTypeFromFilePath,
  normalizeMimeType,
  sliceMimeSniffBuffer,
} from "./mime.js";

// file-type classifies this generic ISO-BMFF brand as video/mp4 without track metadata.
const ISOM_BRAND_BUFFER = Buffer.from(
  "0000001c6674797069736f6d0000000069736f6d0000000000000000",
  "hex",
);
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("mime detection", () => {
  let zipBuffer: Buffer;
  beforeAll(async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
  });

  it("normalizes byte-detected AVI without filename or header hints", async () => {
    const buffer = Buffer.from("524946463800000041564920" + "00".repeat(52), "hex");
    const detected = await detectMime({ buffer });
    expect(detected).toBe("video/x-msvideo");
    expect(extensionForMime(detected)).toBe(".avi");
  });

  it("normalizes byte-detected Matroska to the filename MIME spelling", async () => {
    const buffer = Buffer.from("1a45dfa38b4282886d6174726f736b61", "hex");
    const detected = await detectMime({ buffer, filePath: "clip.bin" });
    expect(detected).toBe("video/x-matroska");
    expect(extensionForMime(detected)).toBe(".mkv");
  });

  it.each([
    ["avif", "image/avif"],
    ["webp", "image/webp"],
    ["unknown", undefined],
  ])("maps %s image format", (format, expected) => {
    expect(imageMimeFromFormat(format)).toBe(expected);
  });

  it.each([
    { hints: { headerMime: "application/epub+zip" }, expected: "application/epub+zip" },
    { hints: { filePath: "upload.pdf", headerMime: DOCX_MIME }, expected: DOCX_MIME },
  ])(
    "refines generic ZIP bytes only with compatible metadata: $hints",
    async ({ hints, expected }) => {
      expect(await detectMime({ buffer: zipBuffer, ...hints })).toBe(expected);
    },
  );

  it.each([{ headerMime: "application/pdf", additionalMimeHints: ["audio/webm"] }])(
    "preserves primary or fallback audio hints for ambiguous WebM bytes: %j",
    async (hints) => {
      const buffer = Buffer.from("1a45dfa3874282847765626d", "hex");
      expect(await detectMime({ buffer, filePath: "voice.webm", ...hints })).toBe("audio/webm");
    },
  );

  it("preserves the declared hint ahead of a generic fallback when bytes are inconclusive", async () => {
    expect(
      await detectMime({
        buffer: Buffer.alloc(16),
        headerMime: "audio/mp4",
        additionalMimeHints: ["application/octet-stream"],
      }),
    ).toBe("audio/mp4");
  });

  it.each([["voice.m4a", undefined, "audio/x-m4a"]])(
    "resolves ambiguous isom-brand bytes with %s and %s",
    async (filePath, headerMime, expected) => {
      expect(await detectMime({ buffer: ISOM_BRAND_BUFFER, filePath, headerMime })).toBe(expected);
    },
  );

  it("detects MIME types from encoded URL extensions", async () => {
    expect(
      await detectMime({ filePath: "https://cdn.example.com/render%2Emp4?download=1#preview" }),
    ).toBe("video/mp4");
  });

  it("detects CAF voice memos by magic bytes without file-type support", async () => {
    const buffer = Buffer.concat([Buffer.from("caff", "ascii"), Buffer.alloc(60)]);
    expect(await detectMime({ buffer })).toBe("audio/x-caf");
  });

  it("caps dependency sniffing to a bounded prefix", () => {
    const small = Buffer.alloc(32);
    const large = Buffer.alloc(FILE_TYPE_SNIFF_MAX_BYTES + 16);
    expect(sliceMimeSniffBuffer(small)).toBe(small);
    expect(sliceMimeSniffBuffer(large)).toHaveLength(FILE_TYPE_SNIFF_MAX_BYTES);
  });
});

describe("getFileExtension", () => {
  it.each([[String.raw`C:\media.folder\clip`, undefined]])(
    "extracts extensions from %s",
    (filePath, expected) => {
      expect(getFileExtension(filePath)).toBe(expected);
    },
  );
});

describe("mimeTypeFromFilePath", () => {
  it.each([
    ["voice.aifc", "audio/aiff"],
    ["https://cdn.example.com/bad%E0%A4%A%2Emp4", undefined],
  ])("maps %s", (filePath, expected) => {
    expect(mimeTypeFromFilePath(filePath)).toBe(expected);
  });
});

describe("extensionForMime", () => {
  it.each([
    ["image/heic-sequence", ".heic"],
    ["image/heif-sequence", ".heif"],
    ["AUDIO/X-AIFF; codecs=pcm", ".aiff"],
    [undefined, undefined],
  ])("maps %s to extension", (mime, expected) => {
    expect(extensionForMime(mime)).toBe(expected);
  });
});

describe("isAudioFileName", () => {
  it.each([
    ["audiobook.M4B", true],
    ["voice.caf", true],
    ["voice.webm", false],
    ["voice.bin", false],
  ] as const)("matches audio extension for %s", (fileName, expected) => {
    expect(isAudioFileName(fileName)).toBe(expected);
  });
});

describe("isGifMedia", () => {
  it.each([
    [{ contentType: " IMAGE/GIF; charset=binary " }, true],
    [{ fileName: "animation.GIF" }, true],
  ] as const)("detects GIF media from normalized metadata %j", (opts, expected) => {
    expect(isGifMedia(opts)).toBe(expected);
  });
});

describe("normalizeMimeType", () => {
  it.each([["   ", undefined]])("normalizes %s", (input, expected) => {
    expect(normalizeMimeType(input)).toBe(expected);
  });
});

describe("prototype-named mime keys", () => {
  it.each(["constructor"])("kindFromMime(%s) returns undefined", (input) => {
    expect(kindFromMime(input)).toBeUndefined();
  });
  it.each(["constructor"])("extensionForMime(%s) returns undefined", (input) => {
    expect(extensionForMime(input)).toBeUndefined();
  });
});

describe("mediaKindFromMime", () => {
  it.each([["text/html; charset=utf-8", "document"]])("classifies %s", (mime, expected) => {
    expect(mediaKindFromMime(mime)).toBe(expected);
  });
});
