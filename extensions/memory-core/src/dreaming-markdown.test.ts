// Memory Core tests cover dreaming markdown plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeDailyDreamingPhaseBlock, writeDeepDreamingReport } from "./dreaming-markdown.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

async function expectPathMissing(targetPath: string): Promise<void> {
  const error = await fs.access(targetPath).then(
    () => undefined,
    (accessError: unknown) => accessError,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
}

function requireInlinePath(result: { inlinePath?: string }): string {
  if (!result.inlinePath) {
    throw new Error("Expected inline dreaming markdown path");
  }
  return result.inlinePath;
}

describe("dreaming markdown storage", () => {
  const nowMs = Date.parse("2026-04-05T10:00:00Z");
  const timezone = "UTC";

  it("writes inline light dreaming output into the daily memory file", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    const result = await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: remember the API key is fake"],
      nowMs,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const inlinePath = requireInlinePath(result);
    expect(inlinePath).toBe(path.join(workspaceDir, "memory", "2026-04-05.md"));
    const content = await fs.readFile(inlinePath, "utf-8");
    expect(content).toContain("## Light Sleep");
    expect(content).toContain("- Candidate: remember the API key is fake");
  });

  it("falls back when the injected timestamp is outside Date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    const result = await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: bounded fallback"],
      nowMs: 8_640_000_000_000_001,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    expect(requireInlinePath(result)).toBe(path.join(workspaceDir, "memory", "2026-05-30.md"));
  });

  it("keeps multiple inline phases in the shared daily memory file", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: first block"],
      nowMs,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });
    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "rem",
      bodyLines: ["- Theme: `focus` kept surfacing."],
      nowMs,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const dreamsPath = path.join(workspaceDir, "memory", "2026-04-05.md");
    const content = await fs.readFile(dreamsPath, "utf-8");
    expect(content).toContain("## Light Sleep");
    expect(content).toContain("## REM Sleep");
    expect(content).toContain("- Candidate: first block");
    expect(content).toContain("- Theme: `focus` kept surfacing.");
  });

  it("keeps daily phase output separate from lowercase dreams.md diaries", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const lowercasePath = path.join(workspaceDir, "dreams.md");
    await fs.writeFile(lowercasePath, "# Scratch\n\n", "utf-8");

    const result = await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "rem",
      bodyLines: ["- Theme: `glacier` kept surfacing."],
      nowMs,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const inlinePath = requireInlinePath(result);
    expect(inlinePath).toBe(path.join(workspaceDir, "memory", "2026-04-05.md"));
    const content = await fs.readFile(inlinePath, "utf-8");
    expect(content).toContain("## REM Sleep");
    expect(content).toContain("- Theme: `glacier` kept surfacing.");
    await expect(fs.readFile(lowercasePath, "utf-8")).resolves.toBe("# Scratch\n\n");
  });

  it("still writes deep reports to the per-phase report directory", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    const result = await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- Promoted: durable preference"],
      storage: {
        mode: "separate",
        separateReports: false,
      },
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      timezone: "UTC",
    });

    expect(result?.reportPath).toBe(
      path.join(workspaceDir, "memory", "dreaming", "deep", "2026-04-05.md"),
    );
    const content = await fs.readFile(result!.reportPath!, "utf-8");
    expect(content).toContain("# Deep Sleep");
    expect(content).toContain("- Promoted: durable preference");

    // separate mode does not write inline DREAMS.md
    await expectPathMissing(path.join(workspaceDir, "DREAMS.md"));
  });

  it("writes deep sleep summary into DREAMS.md with inline storage", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    const result = await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- Ranked 3 candidates", "- Promoted 1 candidate(s) into MEMORY.md."],
      storage: {
        mode: "inline",
        separateReports: false,
      },
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      timezone: "UTC",
    });

    expect(result?.inlinePath).toBe(path.join(workspaceDir, "DREAMS.md"));
    const content = await fs.readFile(result!.inlinePath!, "utf-8");
    expect(content).toContain("## Deep Sleep");
    expect(content).toContain("- Ranked 3 candidates");
    expect(content).toContain("- Promoted 1 candidate(s) into MEMORY.md.");
    expect(content).toContain("<!-- openclaw:dreaming:deep:start -->");
    expect(content).toContain("<!-- openclaw:dreaming:deep:end -->");

    // inline mode does not write separate deep report
    expect(result?.reportPath).toBeUndefined();
  });

  it("updates an existing DREAMS.md deep sleep block on subsequent runs", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- First run: promoted 2 candidates."],
      storage: { mode: "inline", separateReports: false },
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      timezone: "UTC",
    });

    await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- Second run: promoted 1 candidate."],
      storage: { mode: "inline", separateReports: false },
      nowMs: Date.parse("2026-04-06T10:00:00Z"),
      timezone: "UTC",
    });

    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).toContain("## Deep Sleep");
    expect(content).toContain("- Second run: promoted 1 candidate.");
    // Old content should be replaced, not appended
    expect(content).not.toContain("- First run: promoted 2 candidates.");
    // Should still have exactly one heading and one marker pair
    expect(content.match(/## Deep Sleep/g)?.length).toBe(1);
    expect(content.match(/openclaw:dreaming:deep:start/g)?.length).toBe(1);
    expect(content.match(/openclaw:dreaming:deep:end/g)?.length).toBe(1);
  });

  it("preserves DREAMS.md diary marker blocks when writing deep sleep summary", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");

    // Pre-populate DREAMS.md with a diary block (simulating narrative output)
    await fs.writeFile(
      dreamsPath,
      [
        "# Dreams",
        "",
        "## Deep Sleep",
        "<!-- openclaw:dreaming:deep:start -->",
        "- Pre-existing deep summary.",
        "<!-- openclaw:dreaming:deep:end -->",
        "",
        "## Dream Diary",
        "<!-- openclaw:dreaming:diary:start -->",
        "I walked through a forest of data structures...",
        "<!-- openclaw:dreaming:diary:end -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- New deep summary."],
      storage: { mode: "inline", separateReports: false },
      nowMs: Date.parse("2026-04-07T10:00:00Z"),
      timezone: "UTC",
    });

    const content = await fs.readFile(dreamsPath, "utf-8");
    // Deep sleep block updated
    expect(content).toContain("- New deep summary.");
    expect(content).not.toContain("- Pre-existing deep summary.");
    // Diary block preserved
    expect(content).toContain("<!-- openclaw:dreaming:diary:start -->");
    expect(content).toContain("I walked through a forest of data structures...");
    expect(content).toContain("<!-- openclaw:dreaming:diary:end -->");
  });
});
