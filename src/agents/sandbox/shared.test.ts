import { describe, expect, it } from "vitest";
import { slugifySessionKey } from "./shared.js";

describe("slugifySessionKey", () => {
  it("produces stable SHA-1 based slugs for existing workspace directories", () => {
    // Hash stability is critical: changing the hash algorithm orphans existing
    // sandbox workspace directories on upgrade (see #18503).
    const slug = slugifySessionKey("agent:clawfront-dev:direct:23057054725");
    expect(slug).toBe("agent-clawfront-dev-direct-23057-906dfaef");
  });

  it("uses fallback for empty input", () => {
    const slug = slugifySessionKey("");
    expect(slug).toContain("session-");
  });

  it("uses fallback for whitespace-only input", () => {
    const slug = slugifySessionKey("   ");
    expect(slug).toContain("session-");
  });

  it("truncates base to 32 chars", () => {
    const long = "a".repeat(100);
    const slug = slugifySessionKey(long);
    // 32 char base + "-" + 8 char hash = 41 chars
    expect(slug.length).toBe(41);
  });
});
