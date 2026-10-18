/**
 * Regression coverage for human-readable session slug generation.
 * Verifies deterministic choices, collision numbering, and fallback suffixes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCrustaceanSlug, createSessionSlug } from "./session-slug.js";

const randomMocks = vi.hoisted(() => ({
  generateSecureInt: vi.fn(),
}));

vi.mock("../infra/secure-random.js", () => ({
  generateSecureInt: randomMocks.generateSecureInt,
}));

describe("session slug", () => {
  beforeEach(() => {
    randomMocks.generateSecureInt.mockReset();
  });

  it("generates a two-word slug by default", () => {
    randomMocks.generateSecureInt.mockReturnValue(0);
    const slug = createSessionSlug();
    expect(slug).toBe("amber-atlas");
  });

  it("generates a crustacean-themed slug for worktrees", () => {
    randomMocks.generateSecureInt.mockReturnValue(0);
    expect(createCrustaceanSlug()).toBe("amber-barnacle");
  });

  it.each([undefined, []])("keeps crustacean nouns when configured nouns are %j", (nouns) => {
    randomMocks.generateSecureInt.mockReturnValue(0);
    expect(createCrustaceanSlug({ nouns })).toBe("amber-barnacle");
  });

  it("draws fallback nouns from a custom list", () => {
    randomMocks.generateSecureInt.mockReturnValueOnce(0).mockReturnValueOnce(1);
    expect(createCrustaceanSlug({ nouns: ["falcon", "otter", "badger"] })).toBe("amber-otter");
  });

  it("applies collision numbering and three-word fallbacks to custom nouns", () => {
    randomMocks.generateSecureInt.mockReturnValue(0);
    const nouns = ["falcon"];
    expect(createCrustaceanSlug({ nouns, isTaken: (id) => id === "amber-falcon" })).toBe(
      "amber-falcon-2",
    );
    expect(createCrustaceanSlug({ nouns, isTaken: (id) => /^amber-falcon(-\d+)?$/.test(id) })).toBe(
      "amber-falcon-falcon",
    );
  });

  it("adds a numeric suffix when the base slug is taken", () => {
    randomMocks.generateSecureInt.mockReturnValue(0);
    const slug = createSessionSlug((id) => id === "amber-atlas");
    expect(slug).toBe("amber-atlas-2");
  });

  it("falls back to three words when collisions persist", () => {
    randomMocks.generateSecureInt.mockReturnValue(0);
    const slug = createSessionSlug((id) => /^amber-atlas(-\d+)?$/.test(id));
    expect(slug).toBe("amber-atlas-atlas");
  });

  it("uses secure fallback suffix entropy when word collisions persist", () => {
    randomMocks.generateSecureInt.mockReturnValue(0);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_717_171_717_171);
    const slug = createSessionSlug(
      (id) => /^amber-atlas(?:-\d+)?$/.test(id) || /^amber-atlas-atlas(?:-\d+)?$/.test(id),
    );
    expect(slug).toBe("amber-atlas-atlas-aaa");
    nowSpy.mockRestore();
  });
});
