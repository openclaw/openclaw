import { describe, expect, it } from "vitest";
import { attachmentClassFromMime, classifyAttachmentBytes } from "./attachment-classify.js";
import { normalizeMimeType } from "./mime.js";

describe("attachmentClassFromMime", () => {
  it.each([
    ["application/pdf", "document"],
    ["audio/mpeg", "audio"],
    ["video/mp4", "video"],
  ] as const)("classifies %s as %s", (mime, expected) => {
    expect(attachmentClassFromMime(mime)).toBe(expected);
  });
});

describe("classifyAttachmentBytes", () => {
  const completeUtf8 = Buffer.from("验证".repeat(700), "utf8");

  it.each([
    ["input truncated mid-character at 4,096 bytes", completeUtf8.subarray(0, 4096), "binary"],
    ["empty input", Buffer.alloc(0), "binary"],
  ] as const)("classifies %s", async (_name, buffer, expectedClass) => {
    await expect(classifyAttachmentBytes({ buffer, name: "notes" })).resolves.toEqual({
      mime: undefined,
      class: expectedClass,
    });
  });

  it.each([
    ["two-byte sequence", 4095, [0xc2, 0xa3], "text"],
    ["four-byte sequence after its third byte", 4093, [0xf0, 0x9f, 0xa6, 0x80], "text"],
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

  it.each([["application/json", '{"name":"openclaw","stars":1}']] as const)(
    "keeps declared %s for UTF-16 bytes with a BOM",
    async (declaredMime, text) => {
      await expect(
        classifyAttachmentBytes({
          buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
          declaredMime,
        }),
      ).resolves.toEqual({ mime: declaredMime, class: "text", charset: "utf-16le" });
    },
  );

  it.each([["an unpaired surrogate", "a,\ud800b"]])(
    "does not keep declared text/plain for UTF-16 BOM bytes with %s",
    async (_label, text) => {
      await expect(
        classifyAttachmentBytes({
          buffer: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
          declaredMime: "text/plain",
        }),
      ).resolves.toEqual({ mime: "text/csv", class: "text", charset: "utf-16le" });
    },
  );

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
