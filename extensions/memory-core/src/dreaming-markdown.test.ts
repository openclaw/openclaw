// Memory Core tests cover dreaming markdown plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  writeDailyDreamingPhaseBlock,
  writeDeepDreamingReport,
  writeDeepDreamingToDreamsMd,
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

    await expectPathMissing(path.join(workspaceDir, "DREAMS.md"));
  });

  describe("writeDeepDreamingToDreamsMd", () => {
    const deepNowMs = Date.parse("2026-04-05T10:00:00Z");
    const deepTimezone = "UTC";

    it("writes a Deep Sleep managed block into DREAMS.md", async () => {
      const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

      const dreamsPath = await writeDeepDreamingToDreamsMd({
        workspaceDir,
        bodyLines: ["- Ranked 5 candidate(s).", "- Promoted 2 candidate(s)."],
        nowMs: deepNowMs,
        timezone: deepTimezone,
      });

      expect(dreamsPath).toBe(path.join(workspaceDir, "DREAMS.md"));
      const content = await fs.readFile(dreamsPath, "utf-8");
      expect(content).toContain("## Deep Sleep");
      expect(content).toContain("<!-- openclaw:dreaming:deep:start -->");
      expect(content).toContain("- Ranked 5 candidate(s).");
      expect(content).toContain("- Promoted 2 candidate(s).");
      expect(content).toContain("<!-- openclaw:dreaming:deep:end -->");
    });

    it("idempotently replaces the managed block on subsequent writes", async () => {
      const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

      await writeDeepDreamingToDreamsMd({
        workspaceDir,
        bodyLines: ["- First write."],
        nowMs: deepNowMs,
        timezone: deepTimezone,
      });
      await writeDeepDreamingToDreamsMd({
        workspaceDir,
        bodyLines: ["- Second write."],
        nowMs: deepNowMs,
        timezone: deepTimezone,
      });

      const dreamsPath = path.join(workspaceDir, "DREAMS.md");
      const content = await fs.readFile(dreamsPath, "utf-8");
      expect(content).toContain("- Second write.");
      // Must not contain the first block content
      expect(content).not.toContain("- First write.");
      // Must have exactly one managed block
      const startCount = [...content.matchAll(/<!-- openclaw:dreaming:deep:start -->/g)].length;
      expect(startCount).toBe(1);
    });

    it("preserves existing DREAMS.md content outside the managed block", async () => {
      const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
      const existingContent = "# Dream Diary\n\nSome diary content\n";
      await fs.writeFile(path.join(workspaceDir, "DREAMS.md"), existingContent, "utf-8");

      await writeDeepDreamingToDreamsMd({
        workspaceDir,
        bodyLines: ["- Ranked 3 candidate(s)."],
        nowMs: deepNowMs,
        timezone: deepTimezone,
      });

      const dreamsPath = path.join(workspaceDir, "DREAMS.md");
      const content = await fs.readFile(dreamsPath, "utf-8");
      expect(content).toContain("# Dream Diary");
      expect(content).toContain("Some diary content");
      expect(content).toContain("## Deep Sleep");
    });

    it("creates DREAMS.md when it does not exist", async () => {
      const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

      await writeDeepDreamingToDreamsMd({
        workspaceDir,
        bodyLines: ["- Ranked 1 candidate(s)."],
        nowMs: deepNowMs,
        timezone: deepTimezone,
      });

      const dreamsPath = path.join(workspaceDir, "DREAMS.md");
      const content = await fs.readFile(dreamsPath, "utf-8");
      expect(content).toContain("## Deep Sleep");
      expect(content).toContain("- Ranked 1 candidate(s).");
    });

    it("uses lowercase dreams.md when it already exists", async () => {
      const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
      await fs.writeFile(path.join(workspaceDir, "dreams.md"), "# Diary\n", "utf-8");

      const dreamsPath = await writeDeepDreamingToDreamsMd({
        workspaceDir,
        bodyLines: ["- Ranked 1 candidate(s)."],
        nowMs: deepNowMs,
        timezone: deepTimezone,
      });

      expect(dreamsPath).toBe(path.join(workspaceDir, "dreams.md"));
      const content = await fs.readFile(dreamsPath, "utf-8");
      expect(content).toContain("# Diary");
      expect(content).toContain("## Deep Sleep");
    });

    it("rejects a symlinked DREAMS.md", async () => {
      const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
      const realPath = path.join(workspaceDir, "real-dreams.md");
      await fs.writeFile(realPath, "# Real diary\n", "utf-8");
      const symlinkPath = path.join(workspaceDir, "DREAMS.md");
      await fs.symlink("real-dreams.md", symlinkPath);

      await expect(
        writeDeepDreamingToDreamsMd({
          workspaceDir,
          bodyLines: ["- Should fail."],
          nowMs: deepNowMs,
          timezone: deepTimezone,
        }),
      ).rejects.toThrow("Refusing to write symlinked DREAMS.md");
    });
  });
});
