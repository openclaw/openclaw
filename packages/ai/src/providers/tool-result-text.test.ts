import { expect, it } from "vitest";
import {
  describeToolResultMediaPlaceholder as mediaPlaceholder,
  describeUnsupportedToolResultMedia as unsupportedMedia,
  extractToolResultText as extract,
  formatToolResultText,
} from "./tool-result-text.js";
const textBlock = (text: string) => ({ type: "text", text });
const withStructured = { includeStructured: true };

it.each([
  [{ text: "   \n\t", isError: false }, "(no tool output)"],
  [{ text: "", mediaPlaceholder: "(see attached image)", isError: false }, "(see attached image)"],
  [{ text: "  failed  ", isError: true }, "[tool error]   failed  "],
  [
    { text: "line   ", omittedMediaPlaceholder: "[tool image omitted]", isError: false },
    "line   \n[tool image omitted]",
  ],
] satisfies [Parameters<typeof formatToolResultText>[0], string][])(
  "formats blank and nonblank tool output: %j",
  (input, expected) => {
    expect(formatToolResultText(input)).toBe(expected);
  },
);

it("keeps structured fallback and inclusion after block sanitation", () => {
  const structured = { type: "json", value: "😀漢" };
  const expected = '{"type":"json","value":"😀漢"}';
  expect([
    extract([textBlock("\ud800"), structured]),
    extract([textBlock("head\ud800"), structured], withStructured),
  ]).toEqual([expected, `head\n${expected}`]);
});

it("preserves explicit continuation text beyond 8000 UTF-16 units", () => {
  const text = `${"x".repeat(8_000)}😀\n[More content follows. Use offset=225 to continue.]\n`;
  const blocks = [textBlock(text)];
  expect(extract(blocks, withStructured)).toBe(text);
  expect(extract(blocks)).toBe(text);
});

it("bounds and redacts aggregate structured additions without truncating explicit text", () => {
  const explicit = `${"numbered file row\n".repeat(900)}[Use offset=225 to continue.]\n`;
  const tail = "  final explicit block 😀  ";
  const result = extract(
    [
      {
        type: "json",
        bytes: [1, 2, 3],
        encrypted_content: "opaque-ciphertext",
        preview: "data:image/png;base64,AAECAwQFBgc=",
        value: "x".repeat(5_000),
      },
      textBlock(explicit),
      { type: "json", value: "😀".repeat(5_000) },
      textBlock(tail),
    ],
    withStructured,
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
  const text = extract([
    { type: "resource", mime_type: "application/octet-stream", data: "AAECAwQFBgc=" },
    { type: "resource", mediaType: "application/json", data: '{"ok":true}' },
  ]);

  expect(text).toContain('"data":"[binary data omitted: 12 chars]"');
  expect(text).toContain('{\\"ok\\":true}');
  expect(text).not.toContain("AAECAwQFBgc=");
});

it("truncates structured fallback text before provider replay", () => {
  const text = extract([{ type: "json", data: { payload: `${"x".repeat(8_200)}tail-marker` } }]);

  expect(text.length).toBeLessThan(8_100);
  expect(text).toContain("…(truncated)…");
  expect(text).not.toContain("tail-marker");
});
const image = { type: "image", mimeType: "image/png", data: "img" };
const audio = { type: "audio", mimeType: "audio/mpeg", data: "audio" };
it.each([
  [[image], "image"],
  [[audio], "audio"],
  [[image, audio], "media"],
] as const)("describes %j as %s", (blocks, label) => {
  expect(mediaPlaceholder(blocks)).toBe(`(see attached ${label})`);
});

it("does not advertise payload-less media husks", () => {
  const husks = [
    { type: "image", mimeType: "image/png", data: "" },
    { type: "image", path: "/tmp/image.png" },
    { type: "audio", mimeType: "audio/mpeg" },
    { type: "text", text: "ordinary text", mimeType: "image/png" },
  ];
  expect(mediaPlaceholder(husks)).toBeUndefined();
  expect(unsupportedMedia(husks, { images: true, audio: false })).toBeUndefined();
});
