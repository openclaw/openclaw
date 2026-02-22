import { describe, expect, it } from "vitest";
import { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";

describe("EmbeddedBlockChunker sentence preference", () => {
  // Reproduces actual Teams email summary output where the chunker broke
  // between "**Zoom" and "Access**" instead of at a nearby sentence boundary.
  const EMAIL_CONTENT = [
    "Here's a concise summary of your top 5 unread emails:",
    "",
    "**LinkedIn Update**",
    "From: updates-noreply@linkedin.com",
    "Subject: Steve Johnson posted: I was very impressed with Dr. West's story...",
    "Summary: Insightful comment on a story shared at GIS-Pro event.",
    "**Job Alert**",
    "From: jobs-noreply@linkedin.com",
    "Subject: New Principal Software Architect jobs matching your profile",
    "Summary: Opportunities for senior tech roles.",
    "**Zoom Access**",
    "From: michael.moosman@gmail.com",
    "Subject: New Zoom Account for Riverview Ward",
    "Summary: Credentials provided for ward meetings; requires forwarding to relevant parties.",
    "**FamilySearch Notice**",
    "From: reply@e.familysearch.org",
    "Subject: Temple ordinance available in your family tree",
    "Summary: Available for a relative in your family records.",
    "**TechCon Reminder**",
    "From: events@techcon365.com",
    "Subject: LAST CHANCE for Super Early Bird registration",
    "Summary: Workshops underway with limited early-bird benefits.",
    "Would you like details or actions on any of these?",
  ].join("\n");

  it("bulk append: sentence mode finds sentence breaks", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 300,
      maxChars: 800,
      breakPreference: "sentence",
    });

    chunker.append(EMAIL_CONTENT);

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });
    chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });

    // No chunk should split inside bold headers
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/\*\*\w+$/); // ends mid-bold
      expect(chunk).not.toMatch(/^\w+\*\*/); // starts mid-bold
    }
  });

  it("token-by-token streaming: sentence mode finds sentence breaks", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 300,
      maxChars: 800,
      breakPreference: "sentence",
    });

    // Simulate streaming: append one character at a time, drain after each
    const chunks: string[] = [];
    for (const char of EMAIL_CONTENT) {
      chunker.append(char);
      chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });
    }
    // Force flush remaining
    chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });

    // No chunk should split inside bold headers
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/\*\*Zoom$/);
      expect(chunk).not.toMatch(/^Access\*\*/);
      expect(chunk).not.toMatch(/\*\*\w+$/);
      expect(chunk).not.toMatch(/^\w+\*\*/);
    }
  });

  it("token-by-token: paragraph mode for comparison", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 300,
      maxChars: 800,
      breakPreference: "paragraph",
    });

    const chunks: string[] = [];
    for (const char of EMAIL_CONTENT) {
      chunker.append(char);
      chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });
    }
    chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });

    // Should never split inside bold headers
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/\*\*\w+$/);
      expect(chunk).not.toMatch(/^\w+\*\*/);
    }
  });

  it("breakFallbacks: sentence with paragraph fallback finds paragraph breaks", () => {
    // Content without sentence-ending punctuation but with paragraph breaks
    const content = [
      "**Section One**",
      "First line of section one",
      "Second line of section one",
      "",
      "**Section Two**",
      "First line of section two",
      "Second line of section two",
      "",
      "**Section Three**",
      "First line of section three",
      "Second line of section three",
    ].join("\n");

    const chunker = new EmbeddedBlockChunker({
      minChars: 50,
      maxChars: 200,
      breakPreference: "sentence",
      breakFallbacks: ["paragraph"],
    });

    const chunks: string[] = [];
    for (const char of content) {
      chunker.append(char);
      chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });
    }
    chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });

    // With paragraph fallback, should break at paragraph boundaries
    // instead of arbitrary whitespace
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/\*\*\w+$/);
      expect(chunk).not.toMatch(/^\w+\*\*/);
    }
  });

  it("no breakFallbacks: sentence mode without fallback uses whitespace at maxChars", () => {
    // Content without sentence-ending punctuation — should wait for maxChars
    // then fall back to whitespace
    const content = "word ".repeat(100); // 500 chars, no punctuation

    const chunkerWithFallback = new EmbeddedBlockChunker({
      minChars: 50,
      maxChars: 200,
      breakPreference: "sentence",
      breakFallbacks: ["paragraph", "newline"],
    });

    const chunkerWithout = new EmbeddedBlockChunker({
      minChars: 50,
      maxChars: 200,
      breakPreference: "sentence",
    });

    chunkerWithFallback.append(content);
    chunkerWithout.append(content);

    const chunksWithFallback: string[] = [];
    const chunksWithout: string[] = [];
    chunkerWithFallback.drain({ force: false, emit: (c) => chunksWithFallback.push(c) });
    chunkerWithout.drain({ force: false, emit: (c) => chunksWithout.push(c) });

    // Both should produce the same output since there are no paragraph/newline
    // breaks either — both fall through to whitespace at maxChars
    expect(chunksWithFallback.length).toBe(chunksWithout.length);
    for (let i = 0; i < chunksWithFallback.length; i++) {
      expect(chunksWithFallback[i]).toBe(chunksWithout[i]);
    }
  });
});
