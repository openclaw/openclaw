import { describe, expect, it } from "vitest";
import {
  describeToolResultMediaPlaceholder,
  describeUnsupportedToolResultMedia,
  extractToolResultText,
  formatToolResultText,
} from "./tool-result-text.js";

describe("formatToolResultText", () => {
  it("falls back to placeholders only for blank tool output", () => {
    expect(formatToolResultText({ text: "   \n\t", isError: false })).toBe("(no tool output)");
    expect(
      formatToolResultText({ text: "", mediaPlaceholder: "(see attached image)", isError: false }),
    ).toBe("(see attached image)");
  });

  it("keeps the error prefix on unmodified output", () => {
    expect(formatToolResultText({ text: "  failed  ", isError: true })).toBe(
      "[tool error]   failed  ",
    );
  });

  it("appends the omitted-media suffix after unmodified output", () => {
    const text = "line with trailing spaces   ";
    expect(
      formatToolResultText({
        text,
        omittedMediaPlaceholder: "[tool image omitted]",
        isError: false,
      }),
    ).toBe(`${text}\n[tool image omitted]`);
  });
});

describe("extractToolResultText", () => {
  it("keeps structured fallback and inclusion after block sanitation", () => {
    const structured = { type: "json", value: "😀漢" };
    const expected = '{"type":"json","value":"😀漢"}';
    expect(extractToolResultText([{ type: "text", text: "\ud800" }, structured])).toBe(expected);
    expect(
      extractToolResultText([{ type: "text", text: "head\ud800" }, structured], {
        includeStructured: true,
      }),
    ).toBe(`head\n${expected}`);
  });

  it.each([8_000])("preserves explicit continuation text beyond %i UTF-16 units", (length) => {
    const text = `${"x".repeat(length)}😀\n[More content follows. Use offset=225 to continue.]\n`;
    const blocks = [{ type: "text", text }];
    expect(extractToolResultText(blocks, { includeStructured: true })).toBe(text);
    expect(extractToolResultText(blocks)).toBe(text);
  });

  it("bounds and redacts aggregate structured additions without truncating explicit text", () => {
    const explicit = `${"numbered file row\n".repeat(900)}[Use offset=225 to continue.]\n`;
    const tail = "  final explicit block 😀  ";
    const result = extractToolResultText(
      [
        {
          type: "json",
          bytes: [1, 2, 3],
          encrypted_content: "opaque-ciphertext",
          preview: "data:image/png;base64,AAECAwQFBgc=",
          value: "x".repeat(5_000),
        },
        { type: "text", text: explicit },
        { type: "json", value: "😀".repeat(5_000) },
        { type: "text", text: tail },
      ],
      { includeStructured: true },
    );

    const prefix = `${explicit}\n${tail}\n`;
    expect(result.startsWith(prefix)).toBe(true);
    const structured = result.slice(prefix.length);
    expect(structured.length).toBeLessThanOrEqual(8_000 + "\n…(truncated)…".length);
    expect(structured).toContain("…(truncated)…");
    expect(structured).toContain("[omitted bytes]");
    expect(structured).toContain("[omitted encrypted_content]");
    expect(structured).toContain("[inline data URI:");
    expect(structured).not.toContain("opaque-ciphertext");
    expect(structured).not.toContain("AAECAwQFBgc=");
    expect(() => encodeURIComponent(result)).not.toThrow();
  });

  it("omits MIME-tagged binary data while preserving textual resource data", () => {
    const text = extractToolResultText([
      { type: "resource", mime_type: "application/octet-stream", data: "AAECAwQFBgc=" },
      { type: "resource", mediaType: "application/json", data: '{"ok":true}' },
    ]);

    expect(text).toContain('"data":"[binary data omitted: 12 chars]"');
    expect(text).toContain('{\\"ok\\":true}');
    expect(text).not.toContain("AAECAwQFBgc=");
  });

  it("truncates structured fallback text before provider replay", () => {
    const tail = "tail-marker";
    const text = extractToolResultText([
      {
        type: "json",
        data: {
          payload: `${"x".repeat(8_200)}${tail}`,
        },
      },
    ]);

    expect(text.length).toBeLessThan(8_100);
    expect(text).toContain("…(truncated)…");
    expect(text).not.toContain(tail);
  });
});

describe("describeToolResultMediaPlaceholder", () => {
  it("describes image-only tool result media", () => {
    expect(
      describeToolResultMediaPlaceholder([{ type: "image", mimeType: "image/png", data: "img" }]),
    ).toBe("(see attached image)");
  });

  it("describes audio-only tool result media", () => {
    expect(
      describeToolResultMediaPlaceholder([
        { type: "audio", mimeType: "audio/mpeg", data: "audio" },
      ]),
    ).toBe("(see attached audio)");
  });

  it("describes mixed image and audio tool result media", () => {
    expect(
      describeToolResultMediaPlaceholder([
        { type: "image", mimeType: "image/png", data: "img" },
        { type: "audio", mimeType: "audio/mpeg", data: "audio" },
      ]),
    ).toBe("(see attached media)");
  });

  it("does not advertise payload-less media husks", () => {
    const husks = [
      { type: "image", mimeType: "image/png", data: "" },
      { type: "image", path: "/tmp/image.png" },
      { type: "audio", mimeType: "audio/mpeg" },
      { type: "text", text: "ordinary text", mimeType: "image/png" },
    ];
    expect(describeToolResultMediaPlaceholder(husks)).toBeUndefined();
    expect(
      describeUnsupportedToolResultMedia(husks, { images: true, audio: false }),
    ).toBeUndefined();
  });
});
