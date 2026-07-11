// Discord tests cover thread title plugin behavior.
import { describe, expect, it } from "vitest";
import { normalizeGeneratedThreadTitle } from "./thread-title.js";

describe("normalizeGeneratedThreadTitle", () => {
  it("strips quotes and keeps the first non-empty line", () => {
    expect(normalizeGeneratedThreadTitle(' "Weekly Release Summary"\nExtra text')).toBe(
      "Weekly Release Summary",
    );
  });

  it("skips leading blank lines before selecting a title", () => {
    expect(normalizeGeneratedThreadTitle('\n\n "Weekly Release Summary"\nExtra text')).toBe(
      "Weekly Release Summary",
    );
  });

  it("skips leading markdown fence lines before selecting a title", () => {
    expect(normalizeGeneratedThreadTitle("```markdown\nWeekly Release Summary\n```")).toBe(
      "Weekly Release Summary",
    );
  });

  it("strips markdown emphasis wrappers around the full title", () => {
    expect(normalizeGeneratedThreadTitle("**Scaling ArcherScore Development Roadmap**")).toBe(
      "Scaling ArcherScore Development Roadmap",
    );
    expect(normalizeGeneratedThreadTitle('"__Weekly Release Summary__"')).toBe(
      "Weekly Release Summary",
    );
  });

  it("leaves a title with two separate emphasis spans intact", () => {
    // Not a single wrapped span, so the outer markers must not be stripped.
    expect(normalizeGeneratedThreadTitle("*Plan* for *project*")).toBe("*Plan* for *project*");
    expect(normalizeGeneratedThreadTitle("**Bold** vs **Strong**")).toBe("**Bold** vs **Strong**");
    expect(normalizeGeneratedThreadTitle("_intro_ and _outro_")).toBe("_intro_ and _outro_");
  });

  it("unwraps nested same-marker emphasis inside bold without stranding markers", () => {
    // Italic inside bold (`**…*plan*…**`) is valid emphasis nesting, so the
    // outer bold pair is stripped while the inner italic stays intact.
    expect(normalizeGeneratedThreadTitle("**Release *plan***")).toBe("Release *plan*");
    // Bold+italic combined wrappers unwrap to plain text in one pass.
    expect(normalizeGeneratedThreadTitle("***Release plan***")).toBe("Release plan");
    // Underscore bold wrapping underscore italic unwraps the same way.
    expect(normalizeGeneratedThreadTitle("__Release _plan___")).toBe("Release _plan_");
  });
});
