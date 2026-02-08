import { describe, expect, it } from "vitest";
import { extractZulipUploadUrls } from "./uploads.js";

describe("extractZulipUploadUrls", () => {
  it("extracts absolute and relative /user_uploads URLs", () => {
    const urls = extractZulipUploadUrls({
      baseUrl: "https://zulip.rafaelreis.org",
      contentHtml:
        '<p>hi</p><a href="/user_uploads/2/30/abc/image.png">x</a> <img src="https://zulip.rafaelreis.org/user_uploads/2/30/def/other.jpg" />',
    });
    expect(urls).toEqual([
      "https://zulip.rafaelreis.org/user_uploads/2/30/def/other.jpg",
      "https://zulip.rafaelreis.org/user_uploads/2/30/abc/image.png",
    ]);
  });

  it("dedupes URLs", () => {
    const urls = extractZulipUploadUrls({
      baseUrl: "https://zulip.rafaelreis.org",
      contentHtml:
        '<a href="/user_uploads/2/30/abc/image.png">x</a> <a href="https://zulip.rafaelreis.org/user_uploads/2/30/abc/image.png">y</a>',
    });
    expect(urls).toEqual(["https://zulip.rafaelreis.org/user_uploads/2/30/abc/image.png"]);
  });
});
