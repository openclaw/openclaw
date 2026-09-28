import { describe, expect, it } from "vitest";
import { formatMatrixMessageText, resolveMatrixMessageAttachment } from "./media-text.js";
import { summarizeMatrixMessageContextEvent } from "./monitor/context-summary.js";
import type { MatrixRawEvent } from "./monitor/types.js";

describe("Matrix media kind resolution", () => {
  it("treats an inherited prototype property as a non-media message", () => {
    const content = { body: "report.pdf", msgtype: "__proto__" };
    expect(resolveMatrixMessageAttachment(content)).toBeUndefined();
    expect(formatMatrixMessageText(content)).toBe("report.pdf");
  });

  it("summarizes a remote event with an Object.prototype msgtype as plain text", () => {
    const event: MatrixRawEvent = {
      event_id: "$evt",
      sender: "@mallory:example.org",
      type: "m.room.message",
      origin_server_ts: 1,
      content: { body: "hello", msgtype: "toString" },
    };
    expect(summarizeMatrixMessageContextEvent(event)).toBe("hello");
  });

  it.each([
    ["m.audio", "audio"],
    ["m.file", "file"],
    ["m.image", "image"],
    ["m.sticker", "sticker"],
    ["m.video", "video"],
  ])("preserves declared %s attachments", (msgtype, kind) => {
    expect(resolveMatrixMessageAttachment({ body: "media.dat", msgtype })).toEqual({
      kind,
      caption: undefined,
      filename: "media.dat",
    });
  });
});
