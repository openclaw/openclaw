import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SKILLS_WATCH_IGNORED, resolveWatchIgnoredPatterns } from "./refresh.js";

describe("skills watcher ignore patterns", () => {
  describe("resolveWatchIgnoredPatterns", () => {
    it("returns defaults when no custom patterns provided", () => {
      const patterns = resolveWatchIgnoredPatterns(undefined);
      expect(patterns).toEqual(DEFAULT_SKILLS_WATCH_IGNORED);
    });

    it("returns defaults when custom patterns is empty array", () => {
      const patterns = resolveWatchIgnoredPatterns([]);
      expect(patterns).toEqual(DEFAULT_SKILLS_WATCH_IGNORED);
    });

    it("merges custom patterns with defaults", () => {
      const customPatterns = ["/\\.env$/", "/\\.secret$/"];
      const patterns = resolveWatchIgnoredPatterns(customPatterns);

      // Should include all default patterns
      expect(patterns.length).toBeGreaterThan(DEFAULT_SKILLS_WATCH_IGNORED.length);

      // Should include custom patterns (converted to RegExp)
      const patternStrings = patterns.map((p) => p.toString());
      expect(patternStrings).toContain("/\\.env$/");
      expect(patternStrings).toContain("/\\.secret$/");
    });

    it("handles invalid regex patterns gracefully", () => {
      // Suppress the log warning during test
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const customPatterns = ["valid-pattern", "[invalid-regex"];
      const patterns = resolveWatchIgnoredPatterns(customPatterns);

      // Should still include defaults
      expect(patterns.length).toBeGreaterThanOrEqual(DEFAULT_SKILLS_WATCH_IGNORED.length);

      // Valid pattern should be included
      const patternStrings = patterns.map((p) => p.toString());
      expect(patternStrings.some((p) => p.includes("valid-pattern"))).toBe(true);

      vi.restoreAllMocks();
    });

    it("filters out empty and whitespace-only patterns", () => {
      const customPatterns = ["valid-pattern", "", "  ", "\t"];
      const patterns = resolveWatchIgnoredPatterns(customPatterns);

      // Should have defaults + 1 valid custom pattern
      expect(patterns.length).toBe(DEFAULT_SKILLS_WATCH_IGNORED.length + 1);
    });

    it("parses regex patterns with flags", () => {
      const customPatterns = ["/test/i", "/another/gi"];
      const patterns = resolveWatchIgnoredPatterns(customPatterns);

      // Should include custom patterns with flags
      expect(patterns.length).toBe(DEFAULT_SKILLS_WATCH_IGNORED.length + 2);

      // Verify the patterns work correctly
      const testPattern = patterns.find((p) => p.source === "test");
      expect(testPattern).toBeDefined();
      expect(testPattern?.flags).toBe("i");

      const anotherPattern = patterns.find((p) => p.source === "another");
      expect(anotherPattern).toBeDefined();
      expect(anotherPattern?.flags).toBe("gi");
    });

    it("handles non-string values gracefully", () => {
      // @ts-expect-error Testing invalid input
      const patterns = resolveWatchIgnoredPatterns([123, null, undefined, "valid"]);

      // Should have defaults + 1 valid pattern
      expect(patterns.length).toBe(DEFAULT_SKILLS_WATCH_IGNORED.length + 1);
    });
  });
});
