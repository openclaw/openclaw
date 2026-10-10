import { describe, expect, it } from "vitest";
import { DEFAULT_VIDEO_MAX_BASE64_BYTES } from "./defaults.js";
import { resolveVideoMaxBase64Bytes } from "./video.js";

describe("resolveVideoMaxBase64Bytes", () => {
  it("allows raw byte limits that expand to valid base64 boundaries", () => {
    expect(resolveVideoMaxBase64Bytes(1)).toBe(4);
    expect(resolveVideoMaxBase64Bytes(2)).toBe(4);
    expect(resolveVideoMaxBase64Bytes(3)).toBe(4);
    expect(resolveVideoMaxBase64Bytes(4)).toBe(8);
  });

  it("keeps the shared maximum base64 payload cap", () => {
    expect(resolveVideoMaxBase64Bytes(DEFAULT_VIDEO_MAX_BASE64_BYTES)).toBe(
      DEFAULT_VIDEO_MAX_BASE64_BYTES,
    );
  });
});
