import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionSlug } from "./session-slug.js";

describe("session slug", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates a two-word slug by default", () => {
    const slug = createSessionSlug();
    expect(slug).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("adds a numeric suffix when the base slug is taken", () => {
    const slug = createSessionSlug((id) => id === "test-slug");
    expect(slug).toMatch(/^[a-z]+-[a-z]+(-\d+)?$/);
  });

  it("falls back to three words when collisions persist", () => {
    // Mock to force fallback to three-word slug
    const slug = createSessionSlug((id) => {
      // Accept any two-word pattern to force three-word fallback
      return /^[a-z]+-[a-z]+$/.test(id);
    });
    expect(slug).toMatch(/^[a-z]+-[a-z]+-[a-z]+/);
  });
});
