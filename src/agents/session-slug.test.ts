import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionSlug } from "./session-slug.js";

vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getRandomValues: vi.fn((array) => {
      if (array instanceof Uint32Array) {
        array[0] = 0; // Always returns 0, which maps to index 0
      }
      return array;
    }),
  };
});

describe("session slug", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates a two-word slug by default", () => {
    const slug = createSessionSlug();
    expect(slug).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("adds a numeric suffix when the base slug is taken", () => {
    // With getRandomValues mocked to return 0, both word selections pick index 0
    // This makes "amber-atlas" the deterministic result
    const slug = createSessionSlug((id) => id === "amber-atlas");
    expect(slug).toMatch(/^[a-z]+-[a-z]+-\d+$/);
  });

  it("falls back to three words when collisions persist", () => {
    // Mock to force fallback to three-word slug by accepting all 2-word patterns and 2-word patterns with numeric suffixes
    const slug = createSessionSlug((id) => {
      // Accept any pattern that looks like adjective-noun or adjective-noun-number to force three-word fallback
      return /^([a-z]+-[a-z]+|[a-z]+-[a-z]+-\d+)$/.test(id);
    });
    expect(slug).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });
});
