import { describe, expect, it } from "vitest";
import { attachmentClassFromMime, classifyAttachmentBytes } from "./attachment-classify.js";
import { normalizeMimeType } from "./mime.js";

it.each([
  ["application/pdf", "document"],
  ["audio/mpeg", "audio"],
  ["video/mp4", "video"],
] as const)("classifies %s as %s", (mime, expected) => {
  expect(attachmentClassFromMime(mime)).toBe(expected);
});

describe("classifyAttachmentBytes", () => {
  const completeUtf8 = Buffer.from("验证".repeat(700), "utf8");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
    "base64",
  );

  it.each([
    ["input truncated mid-character at 4,096 bytes", completeUtf8.subarray(0, 4096)],
    ["empty input", Buffer.alloc(0)],
  ] as const)("classifies %s as binary", async (_name, buffer) => {
    const result = await classifyAttachmentBytes({ buffer, name: "notes" });
    expect(result).toEqual({ mime: undefined, class: "binary" });
  });

  it.each([
    ["two-byte sequence", 4095, [0xc2, 0xa3]],
    ["four-byte sequence after its third byte", 4093, [0xf0, 0x9f, 0xa6, 0x80]],
  ] as const)("bounds UTF-8 completion for a %s", async (_name, prefixLength, bytes) => {
    const buffer = Buffer.concat([
      completeUtf8.subarray(0, 4092),
      Buffer.alloc(prefixLength - 4092, 0x61),
      Buffer.from(bytes),
    ]);
    const result = await classifyAttachmentBytes({ buffer, name: "notes" });
    expect(result).toEqual({ mime: "text/plain", class: "text" });
  });

  it.each([
    ["clean JSON", '{"name":"openclaw","stars":1}', "application/json", "application/json"],
    ["an unpaired surrogate", "a,\ud800b", "text/plain", "text/csv"],
  ])("resolves UTF-16 BOM bytes with %s", async (_label, text, declaredMime, mime) => {
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const result = await classifyAttachmentBytes({ buffer, declaredMime });
    expect(result).toEqual({ mime, class: "text", charset: "utf-16le" });
  });

  it("keeps the charset when a BOM-less UTF-16 file resolves text by extension", async () => {
    const buffer = Buffer.from("meeting notes for tomorrow", "utf16le");
    const result = await classifyAttachmentBytes({ buffer, name: "notes.txt" });
    expect(result).toEqual({ mime: "text/plain", class: "text", charset: "utf-16le" });
  });

  describe("byte-detected binary signatures", () => {
    const sqlitePage = (fill: (page: Buffer) => void) => {
      const page = Buffer.alloc(4096);
      Buffer.from("SQLite format 3\0", "latin1").copy(page);
      fill(page);
      return page;
    };
    const elf = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]),
      Buffer.alloc(4088),
    ]);
    const schema = Buffer.from(
      Array.from({ length: 100 }, (_, i) => `CREATE TABLE t${i}(name text, notes text);`).join(
        "\n",
      ),
    );
    it.each([
      ["NUL-heavy SQLite", sqlitePage(() => {}), "t.db"],
      [
        "SQLite with a text-heavy schema page",
        sqlitePage((page) => schema.copy(page, 100)),
        "t.sqlite",
      ],
      ["ELF with zero blocks", elf, undefined],
    ] as const)("keeps %s binary", async (_name, buffer, name) => {
      const result = await classifyAttachmentBytes({
        buffer,
        declaredMime: "application/octet-stream",
        name,
      });
      expect(result.class).toBe("binary");
      expect(result).not.toHaveProperty("charset");
    });

    it("keeps NUL-heavy bytes without a known signature from decoding as UTF-16", async () => {
      const buffer = Buffer.concat([Buffer.alloc(1024), Buffer.from([0x9c, 0xfe, 0x01, 0x80])]);
      await expect(classifyAttachmentBytes({ buffer })).resolves.toEqual({
        mime: undefined,
        class: "binary",
      });
    });

    it.each([
      ["utf-16le", Buffer.from("meeting notes for tomorrow", "utf16le")],
      ["utf-16be", Buffer.from("meeting notes for tomorrow", "utf16le").swap16()],
    ] as const)("still decodes unnamed BOM-less %s text", async (charset, buffer) => {
      await expect(classifyAttachmentBytes({ buffer })).resolves.toEqual({
        mime: "text/plain",
        class: "text",
        charset,
      });
    });

    it("still infers Windows-1252 and UTF-8 text", async () => {
      await expect(
        classifyAttachmentBytes({ buffer: Buffer.from("Café notes: résumé et météo.", "latin1") }),
      ).resolves.toEqual({ mime: "text/plain", class: "text", charset: "windows-1252" });
      await expect(
        classifyAttachmentBytes({ buffer: Buffer.from("a,b\n1,2\n"), name: "data" }),
      ).resolves.toEqual({ mime: "text/csv", class: "text" });
    });
  });

  it.each([
    ["image/png", png, "image"],
    ["application/zip", Buffer.from("PK\u0003\u0004payload"), "archive"],
  ] as const)("keeps byte-detected %s ahead of a text filename", async (mime, buffer, kind) => {
    const result = await classifyAttachmentBytes({ buffer, name: "spoof.txt" });
    expect(result).toEqual({ mime, class: kind });
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
});

it("matches a configured text/yaml allowlist against classified .yaml files", async () => {
  const classified = await classifyAttachmentBytes({
    buffer: Buffer.from("key: value\nitems:\n  - one\n", "utf8"),
    name: "config.yaml",
  });
  expect(classified.mime).toBe("application/yaml");
  expect(normalizeMimeType("text/yaml")).toBe(classified.mime);
  expect(normalizeMimeType("application/xml")).toBe("text/xml");
});
