import { randomInt } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionSlug } from "./session-slug.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

describe("session slug", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates a two-word slug by default", () => {
    vi.mocked(randomInt).mockReturnValue(0);
    const slug = createSessionSlug();
    expect(slug).toBe("amber-atlas");
  });

  it("adds a numeric suffix when the base slug is taken", () => {
    vi.mocked(randomInt).mockReturnValue(0);
    const slug = createSessionSlug((id) => id === "amber-atlas");
    expect(slug).toBe("amber-atlas-2");
  });

  it("falls back to three words when collisions persist", () => {
    vi.mocked(randomInt).mockReturnValue(0);
    const slug = createSessionSlug((id) => /^amber-atlas(-\d+)?$/.test(id));
    expect(slug).toBe("amber-atlas-atlas");
  });
});
