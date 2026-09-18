import { describe, expect, it } from "vitest";
import { resolveTelegramMediaMaxBytes } from "./media-limits.js";

const MIB = 1024 * 1024;

describe("resolveTelegramMediaMaxBytes", () => {
  it("falls back from invalid MiB configuration", () => {
    expect(resolveTelegramMediaMaxBytes({ mediaMaxMb: 0, fallbackMediaMaxMb: 25 })).toBe(25 * MIB);
    expect(
      resolveTelegramMediaMaxBytes({
        mediaMaxMb: Number.POSITIVE_INFINITY,
        fallbackMediaMaxMb: 25,
      }),
    ).toBe(25 * MIB);
  });

  it("preserves an explicit zero-byte override", () => {
    expect(resolveTelegramMediaMaxBytes({ maxBytes: 0, mediaMaxMb: 25 })).toBe(0);
  });

  it("floors fractional configured limits to whole bytes", () => {
    expect(resolveTelegramMediaMaxBytes({ mediaMaxMb: 0.001 })).toBe(1048);
  });
});
