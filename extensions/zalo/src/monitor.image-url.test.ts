import { describe, expect, it } from "vitest";
import { __testing } from "./monitor.js";

const { resolveZaloImageUrl } = __testing;

describe("resolveZaloImageUrl", () => {
  it("prefers photo_url over photo when both are present", () => {
    expect(
      resolveZaloImageUrl({
        photo: "https://old.example.com/img.jpg",
        photo_url: "https://new.example.com/img.jpg",
      }),
    ).toBe("https://new.example.com/img.jpg");
  });

  it("falls back to photo when photo_url is absent", () => {
    expect(resolveZaloImageUrl({ photo: "https://example.com/img.jpg" })).toBe(
      "https://example.com/img.jpg",
    );
  });

  it("uses photo_url when photo is absent", () => {
    expect(resolveZaloImageUrl({ photo_url: "https://example.com/img.jpg" })).toBe(
      "https://example.com/img.jpg",
    );
  });

  it("returns undefined when neither field is present", () => {
    expect(resolveZaloImageUrl({})).toBeUndefined();
  });

  it("falls back to photo when photo_url is an empty string", () => {
    expect(
      resolveZaloImageUrl({
        photo: "https://example.com/img.jpg",
        photo_url: "",
      }),
    ).toBe("https://example.com/img.jpg");
  });
});
