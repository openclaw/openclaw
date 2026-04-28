import { describe, expect, it } from "vitest";
import { toDiscordFileBlob } from "./send.shared.js";

describe("toDiscordFileBlob", () => {
  it("preserves a detected MIME type on upload blobs", () => {
    const blob = toDiscordFileBlob(Buffer.from("webp"), "image/webp");

    expect(blob.type).toBe("image/webp");
  });

  it("keeps an existing blob MIME type when reusing interaction reply files", () => {
    const blob = toDiscordFileBlob(new Blob([Buffer.from("apng")], { type: "image/apng" }));

    expect(blob.type).toBe("image/apng");
  });
});
