import { describe, expect, it } from "vitest";
import {
  collectAgentHarnessMessagingMediaUrls,
  mapAgentHarnessMessagingMediaValues,
} from "./messaging-media.js";

describe("harness messaging media references", () => {
  it("preserves alias order and repeated references while ignoring metadata and non-strings", () => {
    const args = {
      media: " scalar ",
      mediaUrl: "duplicate",
      media_url: "duplicate",
      path: "path",
      filePath: "filePath",
      fileUrl: "fileUrl",
      imageUrl: "imageUrl",
      image_url: "image_url",
      mediaUrls: ["mediaUrls", null, 42, ""],
      media_urls: ["media_urls"],
      imageUrls: ["imageUrls"],
      image_urls: ["image_urls"],
      url: "top-level url is not a media argument",
      attachments: [
        null,
        "ignored",
        {
          media: " attached ",
          mediaUrl: "duplicate",
          path: "attachment path",
          filePath: "attachment filePath",
          fileUrl: "attachment fileUrl",
          url: "attachment url",
          caption: "not a reference",
        },
      ],
    };
    expect(collectAgentHarnessMessagingMediaUrls(args)).toEqual([
      "scalar",
      "duplicate",
      "duplicate",
      "path",
      "filePath",
      "fileUrl",
      "imageUrl",
      "image_url",
      "mediaUrls",
      "media_urls",
      "imageUrls",
      "image_urls",
      "attached",
      "duplicate",
      "attachment path",
      "attachment filePath",
      "attachment fileUrl",
      "attachment url",
    ]);
  });

  it("rewrites only media references without mutating source arguments or unrelated attachments", () => {
    const unchanged = Object.freeze({ media: "https://example.com/keep.png", caption: "keep" });
    const changed = Object.freeze({
      filePath: "./report.txt",
      caption: "./report.txt",
      sizeBytes: 12,
    });
    const attachments = Object.freeze([unchanged, changed]);
    const args = Object.freeze({
      media: "./report.txt",
      media_urls: Object.freeze(["./report.txt", 3]),
      attachments,
      message: "./report.txt",
    });
    expect(mapAgentHarnessMessagingMediaValues(args, (value) => value)).toBe(args);
    const mapped = mapAgentHarnessMessagingMediaValues(args, (value) =>
      value === "./report.txt" ? "/managed/report.txt" : value,
    );
    expect(mapped).toEqual({
      media: "/managed/report.txt",
      media_urls: ["/managed/report.txt", 3],
      attachments: [unchanged, { ...changed, filePath: "/managed/report.txt" }],
      message: "./report.txt",
    });
    expect(mapped.attachments).not.toBe(attachments);
    expect(Array.isArray(mapped.attachments) && mapped.attachments[0]).toBe(unchanged);
    expect(args.attachments[1]).toBe(changed);
  });
});
