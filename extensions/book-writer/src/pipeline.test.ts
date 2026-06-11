import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBookWriterConfig } from "./config.js";
import { resolveRunPaths } from "./files.js";
import { generateText } from "./model-adapter.js";
import { runBookWriterPipeline } from "./pipeline.js";
import { buildContinuityReport, buildQualityReport, buildStoryQualityReport } from "./quality.js";

async function tempOutputDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-book-writer-test-"));
}

function requestInfoToUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function requestBodyToJson(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    throw new TypeError("Expected request body to be a string");
  }
  return JSON.parse(body) as unknown;
}

describe("book-writer pipeline", () => {
  it("creates a complete review pack with deterministic offline drafting", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({
      outputDir,
      qualityThresholds: { minWords: 1000 },
    });

    const review = await runBookWriterPipeline({
      config,
      request: {
        topic: "An original clean mystery about a bridge inspector who uncovers invoice fraud",
        targetWords: 1600,
        liveModel: false,
      },
      stages: "review-pack",
    });

    expect(review.runId).toBeTruthy();
    expect(review.recommendation).toBe("revise");
    expect(review.gaps.join(" ")).toContain("Live LM Studio generation disabled");
    await expect(fs.stat(review.artifacts.manuscript)).resolves.toBeTruthy();
    await expect(fs.stat(review.artifacts.ebook)).resolves.toBeTruthy();
    await expect(fs.stat(review.artifacts.printHtml)).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(outputDir, review.runId, "review-pack.json")),
    ).resolves.toBeTruthy();
    expect(review.reports.quality.findings.map((finding) => finding.code)).toContain(
      "epub-structure",
    );
    expect(["pass", "warn"]).toContain(review.reports.storyQuality.status);
    expect(review.artifacts.storyQualityReport).toContain("story-quality-report.json");
    expect(review.artifacts.enduranceReport).toContain("endurance-report.json");
  });

  it("does not downgrade a package for rejected non-selected model alternatives", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({
      outputDir,
      qualityThresholds: { minWords: 1000 },
    });
    const runId = "existing-manuscript-run";

    await runBookWriterPipeline({
      config,
      request: {
        runId,
        topic: "An original clean mystery about a warehouse auditor",
        targetWords: 1600,
        liveModel: false,
      },
      stages: "write",
    });

    const review = await runBookWriterPipeline({
      config,
      request: {
        runId,
        topic: "An original clean mystery about a warehouse auditor",
        targetWords: 1600,
        liveModel: true,
      },
      stages: "package",
    });

    expect(review.gaps.join(" ")).not.toContain("exceeds normal cap");
    expect(review.gaps.join(" ")).not.toContain("exceeds hard reject cap");
  });

  it("blocks copyright-adjacent prompts without producing an approved package", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir, qualityThresholds: { minWords: 100 } });

    const review = await runBookWriterPipeline({
      config,
      request: {
        topic: "Write a cliff notes version of Game of Thrones",
        targetWords: 100,
        liveModel: false,
      },
      stages: "review-pack",
    });

    expect(review.recommendation).toBe("blocked");
    expect(review.reports.originality.status).toBe("blocked");
  });

  it("fails continuity when the protagonist disappears across chapters", () => {
    const report = buildContinuityReport({
      manuscript: [
        "## Chapter 1: The Broken Bell",
        "Evelyn checks the invoice.",
        "## Chapter 2: Receipts in the Rain",
        "Tom studies the receipt.",
      ].join("\n\n"),
      chapterCount: 2,
      expectedProtagonist: "Audrey Vale",
    });

    expect(report.status).toBe("fail");
    expect(
      report.findings.find((finding) => finding.code === "protagonist-continuity")?.status,
    ).toBe("fail");
  });

  it("fails story quality when chapter promises and final closure are missing", () => {
    const report = buildStoryQualityReport({
      bible: {
        runId: "story-quality-test",
        title: "Clean Mystery",
        subtitle: "An Original Clean Mystery",
        slug: "clean-mystery",
        penName: "Northstar House",
        genre: "clean commercial mystery",
        readerPromise: "practical courage",
        premise: "An original clean mystery",
        cast: [
          {
            name: "Audrey Vale",
            role: "protagonist",
            notes: "Lead auditor.",
          },
        ],
        originalityStrategy: [],
        bannedDependencies: [],
        targetWords: 1000,
        createdAt: "2026-05-17T00:00:00.000Z",
      },
      outline: {
        runId: "story-quality-test",
        chapters: [
          {
            number: 1,
            title: "The Broken Bell",
            promise: "A hidden ledger appears.",
            beats: [],
          },
          {
            number: 2,
            title: "Resolution at First Light",
            promise: "The fraud is stopped.",
            beats: [],
          },
        ],
      },
      manuscript: [
        "## Chapter 1: The Broken Bell",
        "Audrey Vale waits in a room without evidence.",
        "## Chapter 2: Resolution at First Light",
        "Audrey Vale wonders what might happen in the next book.",
      ].join("\n\n"),
    });

    expect(report.status).toBe("fail");
    expect(report.findings.find((finding) => finding.code === "final-resolution")?.status).toBe(
      "fail",
    );
  });

  it("fails quality when the manuscript materially misses the requested target words", () => {
    const config = resolveBookWriterConfig({
      outputDir: "/tmp/openclaw-book-writer-target-test",
      qualityThresholds: { minWords: 100 },
    });
    const report = buildQualityReport({
      config,
      manuscript: Array.from({ length: 800 }, (_value, index) => `word${index}`).join(" "),
      targetWords: 1200,
      expectedArtifacts: {
        "book-bible": "book-bible.json",
        outline: "outline.json",
        manuscript: "manuscript.md",
      },
    });

    expect(report.status).toBe("fail");
    expect(report.findings.find((finding) => finding.code === "word-count")?.message).toContain(
      "approval minimum is 1080",
    );
    expect(
      report.findings.find((finding) => finding.code === "target-word-adherence")?.status,
    ).toBe("fail");
  });

  it("fails quality when profanity is off and manuscript language violates it", () => {
    const config = resolveBookWriterConfig({
      outputDir: "/tmp/openclaw-book-writer-profanity-test",
      qualityThresholds: { minWords: 10 },
    });
    const manuscript = [
      "# Test Book",
      "By Northstar House",
      "This clean-language manuscript has enough ordinary words to pass length, but one damn term should violate the Off setting.",
    ].join("\n\n");

    const report = buildQualityReport({
      config,
      manuscript,
      targetWords: 10,
      profanityLevel: "none",
      expectedArtifacts: {
        "book-bible": "book-bible.json",
        outline: "outline.json",
        manuscript: "manuscript.md",
      },
    });

    expect(report.status).toBe("fail");
    expect(report.findings.find((finding) => finding.code === "profanity-control")).toMatchObject({
      status: "fail",
      score: 1,
    });
  });

  it("sends a strict chapter-heading contract to live model drafting", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir, qualityThresholds: { minWords: 1 } });
    const userPrompts: string[] = [];

    await runBookWriterPipeline({
      config,
      request: {
        topic: "An original clean mystery about a warehouse auditor",
        targetWords: 80,
        liveModel: true,
      },
      stages: "review-pack",
      fetchImpl: async (_input, init) => {
        const body = requestBodyToJson(init?.body) as {
          messages?: Array<{ role: string; content: string }>;
        };
        userPrompts.push(body.messages?.find((message) => message.role === "user")?.content ?? "");
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: `## Chapter 1: The Broken Bell\n\n${Array.from(
                    { length: 90 },
                    (_value, index) => `original clue ${index}`,
                  ).join(" ")}`,
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(userPrompts).toHaveLength(8);
    expect(userPrompts[0]).toContain('Start exactly with "## Chapter 1: The Broken Bell"');
    expect(userPrompts[7]).toContain(
      'Start exactly with "## Chapter 8: Resolution at First Light"',
    );
  });

  it("splits long live chapters into multiple model-call segments", async () => {
    const outputDir = await tempOutputDir();
    const config = resolveBookWriterConfig({ outputDir, qualityThresholds: { minWords: 1 } });
    const userPrompts: string[] = [];
    const maxTokens: number[] = [];
    const generatedWords = Array.from({ length: 900 }, (_value, index) => `scene${index}`).join(
      " ",
    );
    const shortGeneratedWords = Array.from(
      { length: 260 },
      (_value, index) => `shortscene${index}`,
    ).join(" ");

    const review = await runBookWriterPipeline({
      config,
      request: {
        topic: "An original clean mystery about a warehouse auditor",
        targetWords: 20000,
        liveModel: true,
      },
      stages: "write",
      fetchImpl: async (_input, init) => {
        const body = requestBodyToJson(init?.body) as {
          max_tokens?: number;
          messages?: Array<{ role: string; content: string }>;
        };
        const prompt = body.messages?.find((message) => message.role === "user")?.content ?? "";
        userPrompts.push(prompt);
        maxTokens.push(body.max_tokens ?? 0);
        const segmentMatch = /segment (\d+) of (\d+)/i.exec(prompt);
        const chapterMatch = /Chapter (\d+): ([^\n".]+)/.exec(prompt);
        const segmentNumber = Number(segmentMatch?.[1] ?? "1");
        const chapterNumber = Number(chapterMatch?.[1] ?? "1");
        const chapterTitle = chapterMatch?.[2] ?? "The Broken Bell";
        const words = segmentNumber === 2 ? shortGeneratedWords : generatedWords;
        const content =
          segmentNumber === 1 ? `## Chapter ${chapterNumber}: ${chapterTitle}\n\n${words}` : words;
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(userPrompts.length).toBeGreaterThan(8);
    expect(userPrompts.some((prompt) => prompt.includes("segment 2 of 3"))).toBe(true);
    expect(userPrompts.some((prompt) => prompt.includes("do not repeat the chapter heading"))).toBe(
      true,
    );
    expect(Math.max(...maxTokens)).toBeLessThan(4096);
    expect(review.gaps.join(" ")).not.toContain("deterministic fallback");
  });

  it("returns a gap when LM Studio is missing", async () => {
    const config = resolveBookWriterConfig();
    const result = await generateText({
      config,
      prompt: "Write one paragraph.",
      liveModel: true,
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });

    expect(result.live).toBe(false);
    expect(result.gaps.join(" ")).toContain("LM Studio generation unavailable");
  });

  it("routes benchmarked Ollama models to the Ollama OpenAI-compatible endpoint", async () => {
    const config = resolveBookWriterConfig();
    let requestUrl = "";
    let requestHeaders: Record<string, string> = {};

    const result = await generateText({
      config,
      model: {
        provider: "ollama",
        model: "qwen3:30b",
        source: "measured",
        peakMemoryGb: 42,
        tokensPerSecond: 18,
        stableContextTokens: 32768,
        crashRate: 0,
        qualityScore: 0.8,
        measuredAt: "2026-05-16T00:00:00.000Z",
        notes: [],
      },
      prompt: "Write one paragraph.",
      liveModel: true,
      fetchImpl: async (input, init) => {
        requestUrl = requestInfoToUrl(input);
        requestHeaders = init?.headers as Record<string, string>;
        return new Response(
          JSON.stringify({ message: { content: "Original local model text." } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(result.live).toBe(true);
    expect(result.provider).toBe("ollama");
    expect(requestUrl).toBe("http://127.0.0.1:11434/api/chat");
    expect(requestHeaders.authorization).toBeUndefined();
  });

  it("asks Ollama Qwen3 models to return final text without thinking output", async () => {
    const config = resolveBookWriterConfig();
    let requestBody: {
      think?: unknown;
      stream?: unknown;
      keep_alive?: unknown;
      messages?: Array<{ role: string; content: string }>;
    } = {};

    await generateText({
      config,
      model: {
        provider: "ollama",
        model: "qwen3:30b",
        source: "measured",
        peakMemoryGb: 42,
        tokensPerSecond: 18,
        stableContextTokens: 32768,
        crashRate: 0,
        qualityScore: 0.8,
        measuredAt: "2026-05-16T00:00:00.000Z",
        notes: [],
      },
      prompt: "Write one paragraph.",
      liveModel: true,
      fetchImpl: async (_input, init) => {
        requestBody = requestBodyToJson(init?.body) as typeof requestBody;
        return new Response(
          JSON.stringify({ message: { content: "Original local model text." } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(requestBody.think).toBe(false);
    expect(requestBody.stream).toBe(false);
    expect(requestBody.keep_alive).toBe("30m");
    expect(requestBody.messages?.at(-1)?.content).toContain("/no_think");
  });

  it("uses the Ollama default base URL when configured as the local provider", () => {
    const config = resolveBookWriterConfig({ localProvider: "ollama" });

    expect(config.localBaseUrl).toBe("http://127.0.0.1:11434");
    expect(config.localModel).toBe("qwen2.5:32b");
  });

  it("uses OpenClaw's configured Ollama model and normalizes the Book Writer endpoint", () => {
    const config = resolveBookWriterConfig(
      { localProvider: "ollama" },
      {
        agents: {
          defaults: {
            model: { primary: "ollama/openclaw-control-qwen25-32b:latest" },
          },
        },
        models: {
          providers: {
            ollama: { baseUrl: "http://127.0.0.1:11434", api: "ollama", models: [] },
          },
        },
      },
    );

    expect(config.localModel).toBe("openclaw-control-qwen25-32b:latest");
    expect(config.localBaseUrl).toBe("http://127.0.0.1:11434");
  });

  it("prevents run paths from escaping the output directory", () => {
    const paths = resolveRunPaths("/tmp/book-writer-root", "../../bad");

    expect(paths.runDir).toContain("book-writer-root");
    expect(paths.runId).toBe("bad");
  });
});
