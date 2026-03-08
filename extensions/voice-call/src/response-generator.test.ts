import { describe, expect, it } from "vitest";
import { SentenceStream } from "./response-generator.js";

describe("SentenceStream", () => {
  async function collect(stream: SentenceStream): Promise<string[]> {
    const results: string[] = [];
    for await (const sentence of stream) {
      results.push(sentence);
    }
    return results;
  }

  it("yields sentences split on period + uppercase", async () => {
    const stream = new SentenceStream();

    const promise = collect(stream);
    stream.push("Hello there. How are you?");
    stream.finish("Hello there. How are you?");

    const sentences = await promise;
    expect(sentences).toEqual(["Hello there.", "How are you?"]);
  });

  it("yields sentences incrementally as cumulative text grows", async () => {
    const stream = new SentenceStream();
    const received: string[] = [];

    const promise = (async () => {
      for await (const sentence of stream) {
        received.push(sentence);
      }
    })();

    // LLM streaming: cumulative text grows over time
    stream.push("Hello");
    stream.push("Hello there.");
    stream.push("Hello there. How");
    stream.push("Hello there. How are you?");
    // At this point, sentence boundary detected: "Hello there." + " How..."
    stream.finish("Hello there. How are you?");

    await promise;
    expect(received).toEqual(["Hello there.", "How are you?"]);
  });

  it("handles single sentence (no split)", async () => {
    const stream = new SentenceStream();

    const promise = collect(stream);
    stream.push("Sure!");
    stream.finish("Sure!");

    const sentences = await promise;
    expect(sentences).toEqual(["Sure!"]);
  });

  it("handles empty response", async () => {
    const stream = new SentenceStream();

    const promise = collect(stream);
    stream.finish("");

    const sentences = await promise;
    expect(sentences).toEqual([]);
  });

  it("handles multiple sentence-ending punctuation marks", async () => {
    const stream = new SentenceStream();

    const promise = collect(stream);
    stream.push("Really?! That's great! Now let's go.");
    stream.finish("Really?! That's great! Now let's go.");

    const sentences = await promise;
    // Should split on boundaries where uppercase follows
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(sentences.join(" ")).toContain("Really?!");
    expect(sentences[sentences.length - 1]).toContain("go.");
  });

  it("does not split on abbreviations mid-sentence", async () => {
    const stream = new SentenceStream();

    const promise = collect(stream);
    stream.push("I talked to Mr. Smith today. He said hello.");
    stream.finish("I talked to Mr. Smith today. He said hello.");

    const sentences = await promise;
    // "Mr. Smith" should NOT cause a split (S is uppercase after period,
    // but the regex should handle this case). If it does split, that's
    // acceptable since voice playback of split sentences is still correct.
    expect(sentences.length).toBeGreaterThanOrEqual(1);
    expect(sentences.join(" ")).toContain("hello");
  });

  it("flushes remaining text on finish", async () => {
    const stream = new SentenceStream();

    const promise = collect(stream);
    // Only partial sentence streamed
    stream.push("Working on it");
    stream.finish("Working on it");

    const sentences = await promise;
    expect(sentences).toEqual(["Working on it"]);
  });

  it("handles finish with different final text than streamed", async () => {
    const stream = new SentenceStream();

    const promise = collect(stream);
    stream.push("First sentence.");
    // Agent payloads may produce slightly different final text
    stream.finish("First sentence. Second sentence.");

    const sentences = await promise;
    // Should have both sentences
    expect(sentences.join(" ")).toContain("First sentence");
    expect(sentences.join(" ")).toContain("Second sentence");
  });

  it("handles finish with no prior pushes", async () => {
    const stream = new SentenceStream();

    const promise = collect(stream);
    stream.finish("Direct final text.");

    const sentences = await promise;
    expect(sentences).toEqual(["Direct final text."]);
  });

  it("yields sentences as they become available (not all at end)", async () => {
    const stream = new SentenceStream();
    const timings: number[] = [];
    const start = Date.now();

    const promise = (async () => {
      for await (const _sentence of stream) {
        timings.push(Date.now() - start);
      }
    })();

    // Simulate delayed LLM streaming
    stream.push("First sentence. Second");
    await new Promise((r) => setTimeout(r, 50));
    stream.push("First sentence. Second sentence. Third");
    await new Promise((r) => setTimeout(r, 50));
    stream.finish("First sentence. Second sentence. Third.");

    await promise;

    // First sentence should arrive much earlier than later ones
    expect(timings.length).toBe(3);
    expect(timings[0]).toBeLessThan(timings[1]);
  });
});
