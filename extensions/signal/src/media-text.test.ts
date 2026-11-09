import { describe, expect, it } from "vitest";
import { formatSignalMediaText, withoutDuplicateLongText } from "./media-text.js";

describe("formatSignalMediaText", () => {
  it("uses the shared formatter for one structured fact", () => {
    expect(formatSignalMediaText([{ kind: "audio", contentType: "audio/ogg" }])).toBe(
      "<media:audio>",
    );
  });

  it("preserves Signal's established multi-attachment summary", () => {
    expect(
      formatSignalMediaText([
        { kind: "image", contentType: "image/jpeg" },
        { kind: "document", contentType: "application/pdf" },
      ]),
    ).toBe("[1 image + 1 document attached]");
  });
});

describe("withoutDuplicateLongText", () => {
  const image = { id: "a1", contentType: "image/jpeg", size: 2048 };
  const longText = "Chart notes: the heron counted buoys. ".repeat(70);

  it("drops the long-text attachment once signal-cli put its text in the body", () => {
    const carrier = {
      id: "lt",
      contentType: "text/x-signal-plain",
      size: Buffer.byteLength(longText),
    };
    expect(withoutDuplicateLongText([image, carrier], longText)).toEqual([image]);
  });

  it("keeps the long-text attachment while the body is still truncated", () => {
    const carrier = { id: "lt", contentType: "text/x-signal-plain", size: 2500 };
    expect(withoutDuplicateLongText([carrier], "x".repeat(2000))).toEqual([carrier]);
  });
});
