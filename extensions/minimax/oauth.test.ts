import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeOAuthExpires } from "./oauth.js";

describe("normalizeOAuthExpires", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("converts relative expiry seconds into an absolute millisecond timestamp", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    expect(normalizeOAuthExpires(86_400)).toBe(1_700_086_400_000);
  });

  it("converts Unix second timestamps into milliseconds", () => {
    expect(normalizeOAuthExpires(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it("preserves absolute millisecond timestamps", () => {
    expect(normalizeOAuthExpires(1_700_000_000_000)).toBe(1_700_000_000_000);
  });
});
