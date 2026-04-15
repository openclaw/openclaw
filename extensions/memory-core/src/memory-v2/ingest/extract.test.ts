import { describe, expect, it } from "vitest";
import { extractCandidates } from "./extract.js";

describe("extractCandidates", () => {
  it("returns no candidates for empty input", () => {
    expect(extractCandidates("")).toEqual([]);
    expect(extractCandidates("   ")).toEqual([]);
  });

  it("identity: 'my name is Alex'", () => {
    const out = extractCandidates("Hi, my name is Alex.");
    expect(out[0]?.memoryType).toBe("identity");
    expect(out[0]?.text.toLowerCase()).toContain("alex");
  });

  it("identity: 'call me Sam'", () => {
    const out = extractCandidates("You can call me Sam.");
    expect(out[0]?.memoryType).toBe("identity");
  });

  it("identity: ignores 'i am tired'", () => {
    const out = extractCandidates("I am tired today.");
    const types = out.map((c) => c.memoryType);
    expect(types).not.toContain("identity");
  });

  it("preference: 'I prefer dark mode'", () => {
    const out = extractCandidates("I prefer dark mode in my editor.");
    expect(out.some((c) => c.memoryType === "preference")).toBe(true);
  });

  it("preference: 'I always use vim'", () => {
    const out = extractCandidates("I always use vim for quick edits.");
    expect(out.some((c) => c.memoryType === "preference")).toBe(true);
  });

  it("preference: ignores 'they prefer X'", () => {
    const out = extractCandidates("They prefer dark mode.");
    expect(out.some((c) => c.memoryType === "preference")).toBe(false);
  });

  it("constraint: 'never push to main when CI is red because it breaks'", () => {
    const out = extractCandidates(
      "Never push to main when CI is red because it breaks downstream.",
    );
    expect(out.some((c) => c.memoryType === "constraint")).toBe(true);
  });

  it("constraint: ignores 'don't worry'", () => {
    const out = extractCandidates("Don't worry about it.");
    expect(out.some((c) => c.memoryType === "constraint")).toBe(false);
  });

  it("todo: 'remind me to call the bank'", () => {
    const out = extractCandidates("Please remind me to call the bank tomorrow.");
    expect(out.some((c) => c.memoryType === "todo")).toBe(true);
  });

  it("todo: 'todo: ship release'", () => {
    const out = extractCandidates("todo: ship the release on Friday");
    expect(out.some((c) => c.memoryType === "todo")).toBe(true);
  });

  it("todo: ignores plain 'I called the bank'", () => {
    const out = extractCandidates("I called the bank.");
    expect(out.some((c) => c.memoryType === "todo")).toBe(false);
  });

  it("decision: 'let's use sqlite for the sidecar'", () => {
    const out = extractCandidates("Let's use sqlite for the sidecar.");
    expect(out.some((c) => c.memoryType === "decision")).toBe(true);
  });

  it("decision: ignores 'we used sqlite' (past tense, no decision verb)", () => {
    const out = extractCandidates("We used sqlite last quarter.");
    expect(out.some((c) => c.memoryType === "decision")).toBe(false);
  });

  it("caps candidates at maxCandidates", () => {
    const text =
      "My name is Alex. I prefer dark mode. Remind me to ship. Let's use sqlite. Never deploy to prod when CI is red because it breaks.";
    const out = extractCandidates(text);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it("orders by importance descending", () => {
    const text = "Let's ship it. My name is Alex.";
    const out = extractCandidates(text);
    expect(out[0]?.memoryType).toBe("identity");
  });

  it("truncates very long candidate text", () => {
    const long = `I prefer ${"x ".repeat(500)}`;
    const out = extractCandidates(long, { maxLength: 50 });
    const pref = out.find((c) => c.memoryType === "preference");
    expect(pref).toBeDefined();
    expect((pref?.text.length ?? 0) <= 50).toBe(true);
  });
});
