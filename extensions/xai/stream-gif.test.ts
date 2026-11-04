import { expect, it } from "vitest";
import { xaiGifRequestMimes } from "./stream-gif.fixture.js";
it("converts a fresh GIF to JPEG on the xAI request and leaves it for other providers", async () => {
  await expect(xaiGifRequestMimes()).resolves.toEqual({ xai: "image/jpeg", other: "image/gif" });
});
