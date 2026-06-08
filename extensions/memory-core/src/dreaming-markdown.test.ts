// Memory Core tests cover dreaming markdown plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEEP_SLEEP_START_MARKER,
  DEEP_SLEEP_END_MARKER,
  writeDailyDreamingPhaseBlock,
  writeDeepDreamingReport,
} from "./dreaming-markdown.js";
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

function requireReportPath(reportPath: string | undefined): string {
  if (!reportPath) {
    throw new Error("Expected deep dreaming report path");
  }
  return reportPath;
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

    const reportPath = await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- Promoted: durable preference"],
      storage: {
        mode: "separate",
        separateReports: false,
      },
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      timezone: "UTC",
    });

    const requiredReportPath = requireReportPath(reportPath);
    expect(requiredReportPath).toBe(
      path.join(workspaceDir, "memory", "dreaming", "deep", "2026-04-05.md"),
    );
    const content = await fs.readFile(requiredReportPath, "utf-8");
    expect(content).toContain("# Deep Sleep");
    expect(content).toContain("- Promoted: durable preference");
  });

  it("writes ## Deep Sleep summary into DREAMS.md after deep dreaming report", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    // Pre-populate DREAMS.md with an existing diary section so the
    // deep-sleep block is inserted under that heading, not appended to an
    // empty file.
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(dreamsPath, "# Dream Diary\n\n<!-- openclaw:dreaming:diary:start -->\n<!-- openclaw:dreaming:diary:end -->\n", "utf-8");

    const reportPath = await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- Ranked 3 candidate(s) for durable promotion.", "- Promoted 1 candidate(s) into MEMORY.md."],
      storage: {
        mode: "separate",
        separateReports: false,
      },
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      timezone: "UTC",
    });

    expect(reportPath).toBeTruthy();
    const dreamsContent = await fs.readFile(dreamsPath, "utf-8");
    expect(dreamsContent).toContain("## Deep Sleep");
    expect(dreamsContent).toContain(DEEP_SLEEP_START_MARKER);
    expect(dreamsContent).toContain(DEEP_SLEEP_END_MARKER);
    expect(dreamsContent).toContain("- Ranked 3 candidate(s) for durable promotion.");
    expect(dreamsContent).toContain("- Promoted 1 candidate(s) into MEMORY.md.");
  });

  it("deep sleep DREAMS.md section is idempotent across multiple runs", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(dreamsPath, "# Dream Diary\n\n<!-- openclaw:dreaming:diary:start -->\n<!-- openclaw:dreaming:diary:end -->\n", "utf-8");

    const nowMs = Date.parse("2026-04-05T10:00:00Z");
    await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- First sweep: 2 promotions."],
      storage: { mode: "separate", separateReports: false },
      nowMs,
      timezone: "UTC",
    });

    const firstContent = await fs.readFile(dreamsPath, "utf-8");

    // Second run with updated bodyLines replaces the managed block.
    await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- Second sweep: 5 promotions."],
      storage: { mode: "separate", separateReports: false },
      nowMs,
      timezone: "UTC",
    });

    const secondContent = await fs.readFile(dreamsPath, "utf-8");
    expect(secondContent).toContain("- Second sweep: 5 promotions.");
    expect(secondContent).not.toContain("First sweep: 2 promotions.");
    // Only one managed block should exist.
    const startOccurrences = (secondContent.match(new RegExp(DEEP_SLEEP_START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    expect(startOccurrences).toBe(1);
  });
});
