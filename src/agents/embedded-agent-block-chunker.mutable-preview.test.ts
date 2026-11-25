import { describe, expect, it } from "vitest";
import { EmbeddedBlockChunker } from "./embedded-agent-block-chunker.js";

describe("EmbeddedBlockChunker mutable previews", () => {
  it.each([
    {
      name: "below-cap tails",
      steps: [
        { text: "HelloWorld", chunks: ["Hello", "World"], buffered: "" },
        { text: "abcd", chunks: [], buffered: "abcd" },
        { text: "e", chunks: ["abcde"], buffered: "" },
        { text: "!", chunks: [], buffered: "!" },
      ],
    },
    {
      name: "combining continuations",
      steps: [
        { text: "abcde", chunks: ["abcde"], buffered: "" },
        { text: "\u0301fghi", chunks: ["\u0301fghi"], buffered: "" },
      ],
    },
    {
      name: "split surrogate pairs",
      steps: [
        { text: "abcd\ud83d", chunks: ["abcd"], buffered: "\ud83d" },
        { text: "\ude00xyz", chunks: ["😀xyz"], buffered: "" },
      ],
    },
    {
      name: "ZWJ continuations",
      steps: [
        { text: "abc🧑", chunks: ["abc🧑"], buffered: "" },
        { text: "\u200d💻xy", chunks: ["\u200d💻xy"], buffered: "" },
      ],
    },
    {
      name: "fitting emoji",
      steps: [
        { text: "abcd👋🏽", chunks: ["abcd"], buffered: "👋🏽" },
        { text: "x", chunks: ["👋🏽x"], buffered: "" },
      ],
    },
  ])("emits mutable preview batches without losing $name", ({ steps }) => {
    const chunker = new EmbeddedBlockChunker({ minChars: 1, maxChars: 5 });
    const emitted: string[] = [];
    for (const step of steps) {
      chunker.append(step.text);
      const chunks: string[] = [];
      chunker.drain({ force: false, mutablePreview: true, emit: (chunk) => chunks.push(chunk) });
      expect(chunks).toEqual(step.chunks);
      expect(chunker.bufferedText).toBe(step.buffered);
      emitted.push(...chunks);
    }
    chunker.drain({ force: true, emit: (chunk) => emitted.push(chunk) });
    expect(emitted.join("")).toBe(steps.map((step) => step.text).join(""));
    expect(emitted.filter((chunk) => chunk.length > 5)).toEqual([]);
    expect(chunker.hasBuffered()).toBe(false);
  });
});
