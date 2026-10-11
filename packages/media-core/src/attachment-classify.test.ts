import { describe, expect, it } from "vitest";
import { attachmentClassFromMime, classifyAttachmentBytes } from "./attachment-classify.js";
import { normalizeMimeType } from "./mime.js";

describe("attachmentClassFromMime", () => {
  it.each([
    ["application/vnd.api+json", "text"],
    ["application/pdf", "document"],
    ["application/msword", "document"],
    ["audio/mpeg", "audio"],
    ["video/mp4", "video"],
  ] as const)("classifies %s as %s", (mime, expected) => {
    expect(attachmentClassFromMime(mime)).toBe(expected);
  });
});

describe("classifyAttachmentBytes", () => {
  const completeUtf8 = Buffer.from("验证".repeat(700), "utf8");

  it.each([
    ["complete 4,092-byte UTF-8 text", completeUtf8.subarray(0, 4092), "text"],
    ["complete 4,200-byte UTF-8 text with a split sniff prefix", completeUtf8, "text"],
    ["input truncated mid-character at 4,096 bytes", completeUtf8.subarray(0, 4096), "binary"],
    [
      "an invalid continuation after the sniff boundary",
      Buffer.concat([completeUtf8.subarray(0, 4095), Buffer.from([0xe2, 0x28])]),
      "binary",
    ],
    [
      "an incomplete sequence at the actual 4,097-byte EOF",
      Buffer.concat([completeUtf8.subarray(0, 4095), Buffer.from([0xe2, 0x82])]),
      "binary",
    ],
    [
      "an invalid byte before the sniff boundary",
      Buffer.concat([
        completeUtf8.subarray(0, 1200),
        Buffer.from([0xff]),
        completeUtf8.subarray(1200),
      ]),
      "binary",
    ],
    ["empty input", Buffer.alloc(0), "binary"],
  ] as const)("classifies %s", async (_name, buffer, expectedClass) => {
    await expect(classifyAttachmentBytes({ buffer, name: "notes" })).resolves.toEqual({
      mime: expectedClass === "text" ? "text/plain" : undefined,
      class: expectedClass,
    });
  });

  it.each([
    ["two-byte sequence", 4095, [0xc2, 0xa3], "text"],
    ["three-byte sequence", 4095, [0xe2, 0x82, 0xac], "text"],
    ["four-byte sequence after its first byte", 4095, [0xf0, 0x9f, 0xa6, 0x80], "text"],
    ["four-byte sequence after its second byte", 4094, [0xf0, 0x9f, 0xa6, 0x80], "text"],
    ["four-byte sequence after its third byte", 4093, [0xf0, 0x9f, 0xa6, 0x80], "text"],
    ["overlong sequence crossing the boundary", 4095, [0xe0, 0x80, 0x80], "binary"],
    ["invalid byte outside a complete sample", 4096, [0xff], "text"],
  ] as const)(
    "bounds UTF-8 completion for a %s",
    async (_name, prefixLength, bytes, expectedClass) => {
      const buffer = Buffer.concat([
        completeUtf8.subarray(0, 4092),
        Buffer.alloc(prefixLength - 4092, 0x61),
        Buffer.from(bytes),
      ]);
      await expect(classifyAttachmentBytes({ buffer, name: "notes" })).resolves.toEqual({
        mime: expectedClass === "text" ? "text/plain" : undefined,
        class: expectedClass,
      });
    },
  );

  it("infers delimited text from otherwise untyped bytes", async () => {
    await expect(
      classifyAttachmentBytes({ buffer: Buffer.from("name,value\nopenclaw,1"), name: "data.bin" }),
    ).resolves.toEqual({ mime: "text/csv", class: "text" });
  });

  it("returns the UTF-16 charset with text classification", async () => {
    await expect(
      classifyAttachmentBytes({
        buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello", "utf16le")]),
        name: "notes.bin",
      }),
    ).resolves.toEqual({ mime: "text/plain", class: "text", charset: "utf-16le" });
  });

  it.each([
    ["text/plain", "Dear team, the meeting moved to 3pm."],
    ["application/json", '{"name":"openclaw","stars":1}'],
  ] as const)("keeps declared %s for UTF-16 bytes with a BOM", async (declaredMime, text) => {
    await expect(
      classifyAttachmentBytes({
        buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
        declaredMime,
      }),
    ).resolves.toEqual({ mime: declaredMime, class: "text", charset: "utf-16le" });
  });

  it.each([
    ["a NUL run", `,${"\0".repeat(32)}`],
    ["an unpaired surrogate", "a,\ud800b"],
  ])("does not keep declared text/plain for UTF-16 BOM bytes with %s", async (_label, text) => {
    await expect(
      classifyAttachmentBytes({
        buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
        declaredMime: "text/plain",
      }),
    ).resolves.toEqual({ mime: "text/csv", class: "text", charset: "utf-16le" });
  });

  it("keeps the charset when a BOM-less UTF-16 file resolves text by extension", async () => {
    await expect(
      classifyAttachmentBytes({
        buffer: Buffer.from("meeting notes for tomorrow", "utf16le"),
        name: "notes.txt",
      }),
    ).resolves.toEqual({ mime: "text/plain", class: "text", charset: "utf-16le" });
  });

  it("keeps byte-detected media ahead of a text filename", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
      "base64",
    );
    await expect(classifyAttachmentBytes({ buffer: png, name: "spoof.txt" })).resolves.toEqual({
      mime: "image/png",
      class: "image",
    });
  });

  it("does not let a text filename override ZIP bytes", async () => {
    await expect(
      classifyAttachmentBytes({ buffer: Buffer.from("PK\u0003\u0004payload"), name: "spoof.txt" }),
    ).resolves.toEqual({ mime: "application/zip", class: "archive" });
  });

  it("keeps declared octet-stream content binary without a text extension", async () => {
    await expect(
      classifyAttachmentBytes({
        buffer: Buffer.from("printable but explicitly binary"),
        declaredMime: "application/octet-stream",
        name: "payload.bin",
      }),
    ).resolves.toEqual({ mime: "application/octet-stream", class: "binary" });
  });

  it.each([
    ["payload.xml", "text/xml"],
    ["debug.log", "text/plain"],
  ] as const)("uses the canonical extension MIME for %s", async (name, mime) => {
    await expect(
      classifyAttachmentBytes({ buffer: Buffer.from("key=value"), name }),
    ).resolves.toEqual({ mime, class: "text" });
  });
});

describe("mime synonym folding", () => {
  it("matches a configured text/yaml allowlist against classified .yaml files", async () => {
    const classified = await classifyAttachmentBytes({
      buffer: Buffer.from("key: value\nitems:\n  - one\n", "utf8"),
      name: "config.yaml",
    });
    expect(classified.mime).toBe("application/yaml");
    expect(normalizeMimeType("text/yaml")).toBe(classified.mime);
    expect(normalizeMimeType("application/xml")).toBe("text/xml");
  });
});
