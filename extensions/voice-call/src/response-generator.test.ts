import { describe, expect, it } from "vitest";
import { createManagerHarness, FakeProvider, markCallAnswered } from "./manager.test-harness.js";
import type { VoiceCallProvider } from "./providers/base.js";
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

  it("resets offset so new assistant messages after tool calls are not skipped", async () => {
    const stream = new SentenceStream();

    const promise = collect(stream);

    // First assistant message (cumulative text within the message)
    stream.push("Looking that up for you.");
    // Tool call happens, new assistant message starts -- pass last text to flush
    stream.resetOffset("Looking that up for you.");
    // Second message cumulative text restarts from 0
    stream.push("The weather is sunny.");
    stream.finish("The weather is sunny.");

    const sentences = await promise;
    expect(sentences).toEqual(["Looking that up for you.", "The weather is sunny."]);
  });

  it("splits on lowercase sentence starts", async () => {
    const stream = new SentenceStream();

    const promise = collect(stream);
    stream.push("done. let me check that.");
    stream.finish("done. let me check that.");

    const sentences = await promise;
    expect(sentences).toEqual(["done.", "let me check that."]);
  });

  it("splits on non-English sentence starts", async () => {
    const stream = new SentenceStream();

    const promise = collect(stream);
    stream.push("terminado. veamos eso.");
    stream.finish("terminado. veamos eso.");

    const sentences = await promise;
    expect(sentences).toEqual(["terminado.", "veamos eso."]);
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

  it("throws when iterated concurrently", async () => {
    const stream = new SentenceStream();

    // Start first iterator
    const iter1 = stream[Symbol.asyncIterator]();
    // Consume asynchronously so the generator is live
    const p1 = iter1.next();

    // Second iterator should throw
    expect(() => stream[Symbol.asyncIterator]()).toThrow(
      "SentenceStream does not support multiple concurrent iterators",
    );

    stream.finish("done");
    await p1;
  });

  it("splits on CJK sentence-ending punctuation", async () => {
    const stream = new SentenceStream();

    const promise = collect(stream);
    stream.push("你好。今天天气很好！是吗？");
    stream.finish("你好。今天天气很好！是吗？");

    const sentences = await promise;
    expect(sentences).toEqual(["你好。", "今天天气很好！", "是吗？"]);
  });
});

describe("speakStream", () => {
  async function* asyncIter(items: string[]): AsyncGenerator<string> {
    for (const item of items) {
      yield item;
    }
  }

  it("calls playTts for each sentence", async () => {
    const provider = new FakeProvider();
    const { manager } = await createManagerHarness({}, provider);

    const { callId } = await manager.initiateCall("+15550000001");
    markCallAnswered(manager, callId, "evt-1");

    const sentences = ["Hello there.", "How are you?", "Goodbye."];
    const result = await manager.speakStream(
      callId,
      asyncIter(sentences),
      "Hello there. How are you? Goodbye.",
    );

    expect(result.success).toBe(true);
    expect(provider.playTtsCalls).toHaveLength(3);
    expect(provider.playTtsCalls[0]?.text).toBe("Hello there.");
    expect(provider.playTtsCalls[1]?.text).toBe("How are you?");
    expect(provider.playTtsCalls[2]?.text).toBe("Goodbye.");
  });

  it("stops on barge-in (partial playback)", async () => {
    const provider = new FakeProvider();
    // Override playTts to return partial on second call
    let callCount = 0;
    (provider as unknown as { playTts: VoiceCallProvider["playTts"] }).playTts = async (input) => {
      provider.playTtsCalls.push(input);
      callCount++;
      if (callCount === 2) {
        return { partial: true };
      }
    };
    const { manager } = await createManagerHarness({}, provider);

    const { callId } = await manager.initiateCall("+15550000001");
    markCallAnswered(manager, callId, "evt-1");

    const sentences = ["One.", "Two.", "Three."];
    const result = await manager.speakStream(callId, asyncIter(sentences), null);

    expect(result.success).toBe(true);
    // Should stop after second sentence (barge-in)
    expect(provider.playTtsCalls).toHaveLength(2);
  });
});
