import { describe, expect, test } from "vitest";
import {
  buildDistillPrompt,
  clusterSeeds,
  DEFAULT_MIN_CLUSTER_SIZE,
  distillAll,
  distillCluster,
  MockProvider,
  parseDistillResponse,
  readCandidatesFile,
  writeCandidatesFile,
  type DistillLLMProvider,
} from "../src/distill.js";
import type { CandidatesFile, ErrorSeed } from "../src/types.js";
import { makeFixture } from "./helpers.js";

function makeSeed(overrides: Partial<ErrorSeed> = {}): ErrorSeed {
  return {
    sessionKey: "sess-001",
    agent: "builder",
    tool: "Bash",
    errorClass: "Permission denied",
    errorMessage: "Permission denied: /etc/shadow",
    fingerprint: "abcdef0123456789",
    domainTags: ["cli", "error-capture", "shell"],
    timestamp: "2026-04-13T10:00:00Z",
    sessionTimestamp: "2026-04-13T09:00:00Z",
    ...overrides,
  };
}

const MOCK_LLM_RESPONSE = JSON.stringify({
  title: "Avoid reading protected files",
  category: "filesystem",
  tags: ["permissions", "security"],
  context: "When the agent tries to read system files",
  mistake: "Attempting to read files without proper permissions",
  lesson: "Always check file permissions before reading",
  fix: "Use stat to check permissions before reading system files",
  severity: "high",
  confidence: 0.85,
});

describe("clusterSeeds", () => {
  test("groups seeds by agent:fingerprint", () => {
    const seeds = [
      makeSeed({ agent: "builder", fingerprint: "fp1" }),
      makeSeed({ agent: "builder", fingerprint: "fp1" }),
      makeSeed({ agent: "builder", fingerprint: "fp2" }),
      makeSeed({ agent: "architect", fingerprint: "fp1" }),
    ];
    const clusters = clusterSeeds(seeds);
    expect(clusters.size).toBe(3);
    expect(clusters.get("builder:fp1")).toHaveLength(2);
    expect(clusters.get("builder:fp2")).toHaveLength(1);
    expect(clusters.get("architect:fp1")).toHaveLength(1);
  });
});

describe("buildDistillPrompt", () => {
  test("includes agent name and error details", () => {
    const cluster = [makeSeed(), makeSeed({ sessionKey: "sess-002" })];
    const prompt = buildDistillPrompt(cluster, "builder");
    expect(prompt).toContain('"builder"');
    expect(prompt).toContain("Permission denied");
    expect(prompt).toContain("2 occurrences");
  });
});

describe("parseDistillResponse", () => {
  test("parses valid JSON response into LessonCandidate", () => {
    const cluster = [makeSeed(), makeSeed({ sessionKey: "sess-002" })];
    const candidate = parseDistillResponse(MOCK_LLM_RESPONSE, "builder", cluster);

    expect(candidate.agent).toBe("builder");
    expect(candidate.title).toBe("Avoid reading protected files");
    expect(candidate.severity).toBe("high");
    expect(candidate.confidence).toBe(0.85);
    expect(candidate.status).toBe("pending");
    expect(candidate.evidenceRefs).toHaveLength(2);
    expect(candidate.id).toMatch(/^cand-/);
    expect(candidate.distillKey).toHaveLength(16);
  });

  test("handles markdown-wrapped JSON", () => {
    const wrapped = "```json\n" + MOCK_LLM_RESPONSE + "\n```";
    const cluster = [makeSeed()];
    const candidate = parseDistillResponse(wrapped, "builder", cluster);
    expect(candidate.title).toBe("Avoid reading protected files");
  });

  test("defaults invalid severity to important", () => {
    const bad = JSON.stringify({ ...JSON.parse(MOCK_LLM_RESPONSE), severity: "mega" });
    const candidate = parseDistillResponse(bad, "builder", [makeSeed()]);
    expect(candidate.severity).toBe("important");
  });

  test("clamps confidence to 0-1 range", () => {
    const high = JSON.stringify({ ...JSON.parse(MOCK_LLM_RESPONSE), confidence: 5.0 });
    const candidate = parseDistillResponse(high, "builder", [makeSeed()]);
    expect(candidate.confidence).toBe(1.0);
  });

  test("gracefully handles non-JSON response with defaults", () => {
    const candidate = parseDistillResponse("no json here", "builder", [makeSeed()]);
    // Should not throw — falls through with defaults
    expect(candidate.status).toBe("pending");
    expect(candidate.confidence).toBe(0);
    expect(candidate.severity).toBe("important");
    expect(candidate.title).toContain("Bash"); // fallback title includes tool name
  });
});

describe("distillCluster", () => {
  test("uses LLM provider and returns candidate", async () => {
    const cluster = [makeSeed(), makeSeed({ sessionKey: "sess-002" })];
    const candidate = await distillCluster(cluster, "builder", new MockProvider(MOCK_LLM_RESPONSE));
    expect(candidate.title).toBe("Avoid reading protected files");
    expect(candidate.agent).toBe("builder");
  });
});

describe("candidates file I/O", () => {
  test("read returns empty file when none exists", () => {
    const fx = makeFixture();
    try {
      const file = readCandidatesFile(fx.root);
      expect(file.version).toBe(1);
      expect(file.candidates).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  test("write + read roundtrips", () => {
    const fx = makeFixture();
    try {
      const cluster = [makeSeed()];
      const candidate = parseDistillResponse(MOCK_LLM_RESPONSE, "builder", cluster);
      const file: CandidatesFile = {
        version: 1,
        promptVersion: "p1.distill.v1",
        updatedAt: "2026-04-13T10:00:00Z",
        candidates: [candidate],
      };
      writeCandidatesFile(file, fx.root);
      const loaded = readCandidatesFile(fx.root);
      expect(loaded.candidates).toHaveLength(1);
      expect(loaded.candidates[0].title).toBe("Avoid reading protected files");
    } finally {
      fx.cleanup();
    }
  });
});

describe("distillAll", () => {
  test("skips clusters below minClusterSize", async () => {
    const seeds = [makeSeed({ fingerprint: "single" })]; // only 1
    const { candidates, skipped } = await distillAll({
      seeds,
      llm: new MockProvider(MOCK_LLM_RESPONSE),
      minClusterSize: DEFAULT_MIN_CLUSTER_SIZE,
    });
    expect(candidates).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  test("distills clusters at or above minClusterSize", async () => {
    const seeds = [
      makeSeed({ fingerprint: "fp1" }),
      makeSeed({ fingerprint: "fp1", sessionKey: "sess-002" }),
    ];
    const { candidates, skipped } = await distillAll({
      seeds,
      llm: new MockProvider(MOCK_LLM_RESPONSE),
    });
    expect(candidates).toHaveLength(1);
    expect(skipped).toBe(0);
  });

  test("skips already-distilled clusters (idempotency)", async () => {
    const fx = makeFixture();
    try {
      const seeds = [
        makeSeed({ fingerprint: "fp1" }),
        makeSeed({ fingerprint: "fp1", sessionKey: "sess-002" }),
      ];

      // First run
      const result1 = await distillAll({
        seeds,
        llm: new MockProvider(MOCK_LLM_RESPONSE),
        root: fx.root,
      });
      expect(result1.candidates).toHaveLength(1);

      // Write to file
      writeCandidatesFile(
        {
          version: 1,
          promptVersion: "p1.distill.v1",
          updatedAt: "2026-04-13T10:00:00Z",
          candidates: result1.candidates,
        },
        fx.root,
      );

      // Second run — same seeds should be skipped
      const result2 = await distillAll({
        seeds,
        llm: new MockProvider(MOCK_LLM_RESPONSE),
        root: fx.root,
      });
      expect(result2.candidates).toHaveLength(0);
      expect(result2.skipped).toBe(1);
    } finally {
      fx.cleanup();
    }
  });
});
