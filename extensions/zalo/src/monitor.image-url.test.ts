import { describe, expect, it } from "vitest";
import { resolveInboundZaloPhotoUrl } from "./monitor.js";

describe("resolveInboundZaloPhotoUrl", () => {
  it("prefers the inbound photo_url field from Zalo image events", () => {
    expect(
      resolveInboundZaloPhotoUrl("https://example.com/photo.jpg", "https://example.com/legacy.jpg"),
    ).toBe("https://example.com/photo.jpg");
  });

  it("falls back to the legacy photo field when photo_url is absent", () => {
    expect(resolveInboundZaloPhotoUrl(undefined, "https://example.com/legacy.jpg")).toBe(
      "https://example.com/legacy.jpg",
    );
  });

  it("returns undefined when neither photo_url nor photo is present", () => {
    expect(resolveInboundZaloPhotoUrl(undefined, undefined)).toBeUndefined();
  });

  it("ignores malformed non-string payload values", () => {
    expect(resolveInboundZaloPhotoUrl(123, { bad: true })).toBeUndefined();
  });
});
