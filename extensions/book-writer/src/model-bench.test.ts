import { describe, expect, it } from "vitest";
import { resolveBookWriterConfig } from "./config.js";
import { parsePsMemorySamples, runLiveModelBench } from "./model-bench.js";

describe("book-writer live model benchmark", () => {
  it("parses provider process memory samples", () => {
    const samples = parsePsMemorySamples(
      [
        "123 1048576 /Applications/LM Studio.app/Contents/MacOS/LM Studio",
        "124 2097152 /usr/local/bin/llama-server --model qwen",
        "125 100 /usr/bin/other",
      ].join("\n"),
      "lmstudio",
    );

    expect(samples).toHaveLength(2);
    expect(samples.reduce((sum, sample) => sum + sample.rssKb, 0)).toBe(3145728);
  });

  it("records measured live benchmark facts from an OpenAI-compatible response", async () => {
    const config = resolveBookWriterConfig({ outputDir: "/tmp/book-writer-bench-test" });

    const record = await runLiveModelBench({
      config,
      model: "Qwen/Qwen3-30B-A3B-Instruct-2507",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            usage: { completion_tokens: 120 },
            choices: [{ message: { content: "Original benchmark prose with enough words." } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      processSampler: async () => [
        { pid: 101, rssKb: 52 * 1024 * 1024, command: "llama-server qwen" },
      ],
    });

    expect(record.source).toBe("measured");
    expect(record.peakMemoryGb).toBe(52);
    expect(record.tokensPerSecond).toBeGreaterThan(0);
    expect(record.crashRate).toBe(0);
    expect(record.notes.join(" ")).toContain("Live benchmark completed");
  });

  it("records unavailable benchmark facts when the local provider fails", async () => {
    const config = resolveBookWriterConfig({ outputDir: "/tmp/book-writer-bench-test" });

    const record = await runLiveModelBench({
      config,
      model: "missing-model",
      fetchImpl: async () => new Response("missing", { status: 404 }),
      processSampler: async () => [],
    });

    expect(record.source).toBe("unavailable");
    expect(record.tokensPerSecond).toBe(0);
    expect(record.crashRate).toBe(1);
    expect(record.notes.join(" ")).toContain("failed");
  });
});
