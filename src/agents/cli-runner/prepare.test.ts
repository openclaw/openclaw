import { describe, expect, it } from "vitest";
import {
  buildClaudeSystemPromptFileContents,
  splitClaudeSystemPromptIntoChunks,
} from "./prepare.js";

const CHUNK_MAX = 12_000;
const MIN_TAIL = 1_000;

describe("splitClaudeSystemPromptIntoChunks", () => {
  it("returns a single chunk for small prompts", () => {
    const prompt = "hello\nworld\n";
    const chunks = splitClaudeSystemPromptIntoChunks(prompt);
    expect(chunks).toEqual([prompt]);
  });

  it("reassembles losslessly across chunk boundaries", () => {
    const line = "a".repeat(200) + "\n";
    const prompt = line.repeat(200); // ~40k chars
    const chunks = splitClaudeSystemPromptIntoChunks(prompt);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(prompt);
  });

  it("merges orphan tail fragments into the previous chunk (regression)", () => {
    // Reproduce the production bug: a prompt that is just over CHUNK_MAX with a
    // short trailing line would be split into [CHUNK_MAX-ish, tinyTail].
    const body = "x".repeat(CHUNK_MAX - 1) + "\n";
    const orphan = "Reasoning: off (hidden unless on/stream).\n";
    const prompt = body + orphan;

    const chunks = splitClaudeSystemPromptIntoChunks(prompt);

    expect(chunks.join("")).toBe(prompt);
    // The orphan line must not become its own chunk.
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThanOrEqual(MIN_TAIL);
    }
    // In this specific case everything fits into a single chunk.
    expect(chunks).toHaveLength(1);
  });

  it("does not create a tail chunk below the min size even when snapping to newline", () => {
    // Multi-chunk input where the natural snap-to-newline leaves a small tail.
    const bigLine = "b".repeat(CHUNK_MAX - 10) + "\n"; // almost a full chunk
    const middleLine = "c".repeat(CHUNK_MAX - 10) + "\n"; // forces a 2nd chunk
    const tinyTail = "tiny tail line\n"; // ~15 chars, well below MIN_TAIL
    const prompt = bigLine + middleLine + tinyTail;

    const chunks = splitClaudeSystemPromptIntoChunks(prompt);

    expect(chunks.join("")).toBe(prompt);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThanOrEqual(MIN_TAIL);
    }
    // The last chunk should contain the tiny tail.
    expect(chunks[chunks.length - 1]?.endsWith(tinyTail)).toBe(true);
  });

  it("respects the max chunk size for large prompts", () => {
    const line = "d".repeat(500) + "\n";
    const prompt = line.repeat(100); // ~50k chars across many lines
    const chunks = splitClaudeSystemPromptIntoChunks(prompt);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // A chunk can slightly exceed CHUNK_MAX only when absorbing an orphan
      // tail to keep it above MIN_TAIL.
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX + MIN_TAIL);
    }
  });
});

describe("buildClaudeSystemPromptFileContents", () => {
  it("does not emit orphan tail part files for prompts with trailing short lines", () => {
    const body = "y".repeat(CHUNK_MAX - 1) + "\n";
    const orphan = "Reasoning: off (hidden unless on/stream).\n";
    const { contents } = buildClaudeSystemPromptFileContents(body + orphan);

    for (const entry of contents) {
      expect(entry.text.length).toBeGreaterThanOrEqual(MIN_TAIL);
    }
  });
});
