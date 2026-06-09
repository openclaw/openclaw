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

  it("writes deep sleep summary to DREAMS.md and optionally to separate report", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    const reportPath = await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- Promoted: durable preference"],
      storage: {
        mode: "separate",
        separateReports: true,
      },
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      timezone: "UTC",
    });

    // Separate report is written when separateReports is true.
    const requiredReportPath = requireReportPath(reportPath);
    expect(requiredReportPath).toBe(
      path.join(workspaceDir, "memory", "dreaming", "deep", "2026-04-05.md"),
    );
    const reportContent = await fs.readFile(requiredReportPath, "utf-8");
    expect(reportContent).toContain("# Deep Sleep");
    expect(reportContent).toContain("- Promoted: durable preference");

    // DREAMS.md is always written with the ## Deep Sleep section.
    const dreamsContent = await fs.readFile(
      path.join(workspaceDir, "DREAMS.md"), "utf-8",
    );
    expect(dreamsContent).toContain("## Deep Sleep");
    expect(dreamsContent).toContain("- Promoted: durable preference");
  });

  it("writes ## Deep Sleep to DREAMS.md even when separateReports is false", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    const reportPath = await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- Promoted: durable preference"],
      storage: {
        mode: "inline",
        separateReports: false,
      },
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      timezone: "UTC",
    });

    // No separate report path is returned when separateReports is false.
    expect(reportPath).toBeUndefined();

    // DREAMS.md is always written with the ## Deep Sleep section.
    const dreamsContent = await fs.readFile(
      path.join(workspaceDir, "DREAMS.md"), "utf-8",
    );
    expect(dreamsContent).toContain("## Deep Sleep");
    expect(dreamsContent).toContain("- Promoted: durable preference");
  });

  it("replaces an existing ## Deep Sleep section in DREAMS.md", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    // Pre-populate DREAMS.md with an existing ## Deep Sleep section
    // flanked by other sections.
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(
      dreamsPath,
      [
        "## Other Section",
        "",
        "- Other item",
        "",
        "## Deep Sleep",
        "- Old stale item",
        "",
        "## Another Section",
        "- Another item",
        "",
      ].join("\n"),
      "utf-8",
    );

    await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- New durable preference"],
      storage: {
        mode: "inline",
        separateReports: false,
      },
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      timezone: "UTC",
    });

    const content = await fs.readFile(dreamsPath, "utf-8");
    // The new content replaces the old ## Deep Sleep section.
    expect(content).toContain("- New durable preference");
    expect(content).not.toContain("- Old stale item");
    // Other sections are preserved intact.
    expect(content).toContain("## Other Section");
    expect(content).toContain("## Another Section");
    // Only one ## Deep Sleep heading remains.
    const deepMatches = content.match(/## Deep Sleep/g);
    expect(deepMatches?.length).toBe(1);
  });

  it("updates lowercase dreams.md when it already exists", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    // Pre-populate lowercase dreams.md — the Dreams resolver prefers
    // the existing file over creating a new DREAMS.md.
    const dreamsPath = path.join(workspaceDir, "dreams.md");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(dreamsPath, "# Dream Diary\n\n- Old diary entry\n", "utf-8");

    await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- Promoted: from lowercase"],
      storage: {
        mode: "inline",
        separateReports: false,
      },
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      timezone: "UTC",
    });

    // The lowercase file was updated, not a new uppercase file created.
    const content = await fs.readFile(dreamsPath, "utf-8");
    expect(content).toContain("## Deep Sleep");
    expect(content).toContain("- Promoted: from lowercase");
    // Original content is preserved.
    expect(content).toContain("- Old diary entry");

    // No uppercase DREAMS.md was created.
    await expect(
      fs.access(path.join(workspaceDir, "DREAMS.md")),
    ).rejects.toThrow(/ENOENT/);
  });

  it("preserves dream diary entries alongside the ## Deep Sleep section", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    // Pre-populate DREAMS.md with diary markers and entries, plus
    // an existing ## Deep Sleep section.
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.mkdir(workspaceDir, { recursive: true });
    const original = [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "",
      "---",
      "",
      "*June 5, 2026 at 10:00 AM EDT*",
      "",
      "A quiet morning of reflection on memory patterns.",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
      "",
      "## Deep Sleep",
      "- Previous: ranked 3, promoted 1",
      "",
    ].join("\n");
    await fs.writeFile(dreamsPath, original, "utf-8");

    await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- Ranked 5, promoted 2"],
      storage: {
        mode: "inline",
        separateReports: false,
      },
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      timezone: "UTC",
    });

    const content = await fs.readFile(dreamsPath, "utf-8");
    // Deep Sleep section was updated.
    expect(content).toContain("- Ranked 5, promoted 2");
    // Diary markers and entries are preserved intact.
    expect(content).toContain("<!-- openclaw:dreaming:diary:start -->");
    expect(content).toContain("<!-- openclaw:dreaming:diary:end -->");
    expect(content).toContain("*June 5, 2026 at 10:00 AM EDT*");
    expect(content).toContain("A quiet morning of reflection on memory patterns.");
    // Only one ## Deep Sleep heading.
    const deepMatches = content.match(/## Deep Sleep/g);
    expect(deepMatches?.length).toBe(1);
  });

  it("rejects a symlinked DREAMS.md when writing deep sleep summary", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    // Create a real target file and symlink DREAMS.md to it.
    const targetPath = path.join(workspaceDir, "real-dreams.md");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(targetPath, "# Real dreams\n", "utf-8");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.symlink("real-dreams.md", dreamsPath);

    await expect(
      writeDeepDreamingReport({
        workspaceDir,
        bodyLines: ["- Should be rejected"],
        storage: {
          mode: "inline",
          separateReports: false,
        },
        nowMs: Date.parse("2026-04-05T10:00:00Z"),
        timezone: "UTC",
      }),
    ).rejects.toThrow(/symlink/i);
  });
});
