import { describe, expect, it, vi } from "vitest";
import { uploadToConsentUrl } from "./file-consent.js";

describe("uploadToConsentUrl", () => {
  it("sends the OpenClaw User-Agent header with consent uploads", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));

    await uploadToConsentUrl({
      url: "https://upload.example.com/file",
      buffer: Buffer.from("hello"),
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://upload.example.com/file",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "Content-Range": "bytes 0-4/5",
          "Content-Type": "application/octet-stream",
          "User-Agent": expect.stringMatching(/^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/),
        }),
      }),
    );
  });
});
