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
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["png", "image/png"],
    ["webp", "image/webp"],
    ["gif", "image/gif"],
    ["unknown", undefined],
  ])("maps %s image format", (format, expected) => {
    expect(imageMimeFromFormat(format)).toBe(expected);
  });

  it.each([
    ["/word/document.xml", DOCX_MIME],
    [
      "/ppt/presentation.xml",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
  ])("detects OOXML from %s package metadata", async (partPath, mainMime) => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      `<Types><Override PartName="${partPath}" ContentType="${mainMime}.main+xml"/></Types>`,
    );
    zip.file(partPath.slice(1), "<xml/>");
    expect(
      await detectMime({
        buffer: await zip.generateAsync({ type: "nodebuffer" }),
        filePath: "file.bin",
      }),
    ).toBe(mainMime);
  });

  it.each([
    { hints: { filePath: "file.xlsx" }, expected: XLSX_MIME },
    { hints: { filePath: "fake.png" }, expected: "application/zip" },
    { hints: { headerMime: "image/png" }, expected: "application/zip" },
    { hints: { headerMime: "application/epub+zip" }, expected: "application/epub+zip" },
    { hints: { headerMime: "application/java-archive" }, expected: "application/java-archive" },
    { hints: { headerMime: "application/pdf" }, expected: "application/zip" },
    {
      hints: { headerMime: "application/vnd.oasis.opendocument.text-flat-xml" },
      expected: "application/zip",
    },
    { hints: { headerMime: "application/vnd.visio" }, expected: "application/zip" },
    { hints: { filePath: "upload.pdf", headerMime: DOCX_MIME }, expected: DOCX_MIME },
  ])(
    "refines generic ZIP bytes only with compatible metadata: $hints",
    async ({ hints, expected }) => {
      expect(await detectMime({ buffer: zipBuffer, ...hints })).toBe(expected);
    },
  );

  it.each([
    ["a2ui.bundle.js", "text/javascript"],
    ["config.yml", "application/yaml"],
    ["config.yaml", "application/yaml"],
    ["report.html", "text/html"],
    ["page.htm", "text/html"],
    ["data.xml", "text/xml"],
    ["style.css", "text/css"],
    ["voice.aac", "audio/aac"],
  ])("uses the extension when byte sniffing is inconclusive: %s", async (filePath, expected) => {
    expect(await detectMime({ buffer: Buffer.alloc(16), filePath })).toBe(expected);
  });

  it.each([
    { headerMime: "audio/webm" },
    { headerMime: "application/pdf", additionalMimeHints: ["audio/webm"] },
  ])("preserves primary or fallback audio hints for ambiguous WebM bytes: %j", async (hints) => {
    const buffer = Buffer.from("1a45dfa3874282847765626d", "hex");
    expect(await detectMime({ buffer, filePath: "voice.webm", ...hints })).toBe("audio/webm");
  });

  it("preserves the declared hint ahead of a generic fallback when bytes are inconclusive", async () => {
    expect(
      await detectMime({
        buffer: Buffer.alloc(16),
        headerMime: "audio/mp4",
        additionalMimeHints: ["application/octet-stream"],
      }),
    ).toBe("audio/mp4");
  });

  it.each([
    ["voice.mp4", "audio/mp4", "audio/mp4"],
    ["voice.m4a", "audio/x-m4a", "audio/x-m4a"],
    ["voice.m4a", "audio/m4a", "audio/m4a"],
    ["voice.m4a", undefined, "audio/x-m4a"],
    ["clip.mp4", undefined, "video/mp4"],
    ["voice.aac", "audio/aac", "video/mp4"],
  ])(
    "resolves ambiguous isom-brand bytes with %s and %s",
    async (filePath, headerMime, expected) => {
      expect(await detectMime({ buffer: ISOM_BRAND_BUFFER, filePath, headerMime })).toBe(expected);
    },
  );

  it.each([
    ["avif", "image/avif"],
    ["avis", "image/avif"],
    ["M4B ", "audio/mp4"],
    ["M4V ", "video/x-m4v"],
    ["hevc", "image/heic-sequence"],
    ["msf1", "image/heif-sequence"],
  ])("preserves the file-type MIME for ISO-BMFF %s media", async (brand, expected) => {
    const buffer = Buffer.alloc(24);
    buffer.writeUInt32BE(buffer.length, 0);
    buffer.write("ftyp", 4, "ascii");
    buffer.write(brand, 8, "ascii");
    expect(await detectMime({ buffer })).toBe(expected);
  });

  it("does not let conflicting audio metadata override MPEG video bytes", async () => {
    const buffer = Buffer.from([0x00, 0x00, 0x01, 0xba, 0x00, 0x00, 0x00, 0x00]);
    expect(await detectMime({ buffer, headerMime: "audio/mpeg" })).toBe("video/mpeg");
  });

  it("detects MIME types from encoded URL extensions", async () => {
    expect(
      await detectMime({ filePath: "https://cdn.example.com/render%2Emp4?download=1#preview" }),
    ).toBe("video/mp4");
  });

  it.each([
    ["AIFF", "voice.aiff"],
    ["AIFC", "voice.aifc"],
  ])("detects %s audio from its authentic container signature", async (form, filePath) => {
    const buffer = Buffer.alloc(64);
    buffer.write("FORM", 0, "ascii");
    buffer.writeUInt32BE(buffer.length - 8, 4);
    buffer.write(form, 8, "ascii");
    expect(await detectMime({ buffer, filePath })).toBe("audio/aiff");
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
  it.each([
    ["https://cdn.example.com/render.mp4/", undefined],
    ["https://cdn.example.com/render.mp4%2Fpreview", ".mp4%2fpreview"],
    ["https://cdn.example.com/render.mp4%5Cpreview", ".mp4%5cpreview"],
    ["https://cdn.example.com/bad%ZZ%2Emp4", undefined],
    [String.raw`C:\media.folder\clip`, undefined],
    [String.raw`C:\media.folder\clip.MP4`, ".mp4"],
  ])("extracts extensions from %s", (filePath, expected) => {
    expect(getFileExtension(filePath)).toBe(expected);
  });
});

describe("mimeTypeFromFilePath", () => {
  it.each([
    ["photo.JPG", "image/jpeg"],
    ["voice.mp3", "audio/mpeg"],
    ["voice.AIFF", "audio/aiff"],
    ["voice.aif", "audio/aiff"],
    ["voice.aifc", "audio/aiff"],
    ["voice.m2a", "audio/mpeg"],
    ["voice.oga", "audio/ogg"],
    ["voice.wav", "audio/wav"],
    ["clip.avi", "video/x-msvideo"],
    ["clip.mkv", "video/x-matroska"],
    ["clip.webm", "video/webm"],
    ["https://cdn.example.com/render%2Em%70%34", "video/mp4"],
    ["https://cdn.example.com/bad%ZZ/render%2Emp4", "video/mp4"],
    ["https://cdn.example.com/archive%2Fclip%2Emp4", "video/mp4"],
    ["https://cdn.example.com/archive%5Cclip%2Emp4", "video/mp4"],
    ["https://cdn.example.com/render.mp4%2Fpreview", undefined],
    ["https://cdn.example.com/render.mp4%5Cpreview", undefined],
    ["https://cdn.example.com/bad%E0%A4%A%2Emp4", undefined],
    ["unknown.bin", undefined],
  ])("maps %s", (filePath, expected) => {
    expect(mimeTypeFromFilePath(filePath)).toBe(expected);
  });
});

describe("extensionForMime", () => {
  it.each([
    ["image/jpeg", ".jpg"],
    ["image/jpg", ".jpg"],
    ["image/heic-sequence", ".heic"],
    ["image/heif-sequence", ".heif"],
    ["audio/aiff", ".aiff"],
    ["AUDIO/X-AIFF; codecs=pcm", ".aiff"],
    ["audio/mpeg", ".mp3"],
    ["audio/mp3", ".mp3"],
    ["audio/x-wav", ".wav"],
    ["audio/x-m4a", ".m4a"],
    ["audio/m4a", ".m4a"],
    ["audio/mp4", ".m4a"],
    [" VIDEO/VND.AVI; codec=DIVX ", ".avi"],
    ["application/xml", ".xml"],
    ["video/unknown", undefined],
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
    [{ contentType: "image/png" }, false],
    [{ fileName: "animation.GIF" }, true],
  ] as const)("detects GIF media from normalized metadata %j", (opts, expected) => {
    expect(isGifMedia(opts)).toBe(expected);
  });
});

describe("normalizeMimeType", () => {
  it.each([
    ["Audio/MP4; codecs=mp4a.40.2", "audio/mp4"],
    ["image/apng", "image/png"],
    ["   ", undefined],
    [undefined, undefined],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeMimeType(input)).toBe(expected);
  });
});

describe("prototype-named mime keys", () => {
  // Untrusted headers must not resolve inherited Object.prototype members.
  it.each(["__proto__", "constructor"])("normalizeMimeType(%s) stays a plain string", (input) => {
    expect(normalizeMimeType(input)).toBe(input);
  });
  it.each(["__proto__", "constructor"])("kindFromMime(%s) returns undefined", (input) => {
    expect(kindFromMime(input)).toBeUndefined();
  });
  it.each(["__proto__", "constructor"])("extensionForMime(%s) returns undefined", (input) => {
    expect(extensionForMime(input)).toBeUndefined();
  });
});

describe("mediaKindFromMime", () => {
  it.each([
    ["text/html; charset=utf-8", "document"],
    ["model/gltf+json", undefined],
    [undefined, undefined],
  ])("classifies %s", (mime, expected) => {
    expect(mediaKindFromMime(mime)).toBe(expected);
  });

  it.each([
    [" Audio/Ogg; codecs=opus ", "audio"],
    [undefined, undefined],
    ["model/gltf+json", undefined],
  ])("maps kindFromMime(%s) => %s", (mime, expected) => {
    expect(kindFromMime(mime)).toBe(expected);
  });
});
