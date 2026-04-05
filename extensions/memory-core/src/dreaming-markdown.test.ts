import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDailyDreamingPhaseBlock, writeDeepDreamingReport } from "./dreaming-markdown.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dreaming-markdown-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("dreaming markdown storage", () => {
  it("writes inline light dreaming output into top-level DREAMS.md", async () => {
    const workspaceDir = await createTempWorkspace();

    const result = await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: remember the API key is fake"],
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      timezone: "UTC",
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    expect(result.inlinePath).toBe(path.join(workspaceDir, "DREAMS.md"));
    const content = await fs.readFile(result.inlinePath!, "utf-8");
    expect(content).toContain("## 2026-04-05 - Light Sleep");
    expect(content).toContain("- Candidate: remember the API key is fake");
  });

  it("keeps multiple inline phases in the shared top-level DREAMS.md file", async () => {
    const workspaceDir = await createTempWorkspace();

    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: first block"],
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      timezone: "UTC",
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });
    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "rem",
      bodyLines: ["- Theme: `focus` kept surfacing."],
      nowMs: Date.parse("2026-04-05T11:00:00Z"),
      timezone: "UTC",
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    const content = await fs.readFile(dreamsPath, "utf-8");
    expect(content).toContain("## 2026-04-05 - Light Sleep");
    expect(content).toContain("## 2026-04-05 - REM Sleep");
    expect(content).toContain("- Candidate: first block");
    expect(content).toContain("- Theme: `focus` kept surfacing.");
  });

  it("preserves prior days when writing later inline dreaming output", async () => {
    const workspaceDir = await createTempWorkspace();

    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: day one"],
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      timezone: "UTC",
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });
    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: day two"],
      nowMs: Date.parse("2026-04-06T10:00:00Z"),
      timezone: "UTC",
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).toContain("## 2026-04-05 - Light Sleep");
    expect(content).toContain("## 2026-04-06 - Light Sleep");
    expect(content).toContain("- Candidate: day one");
    expect(content).toContain("- Candidate: day two");
  });

  it("replaces the same day and phase block instead of appending duplicates", async () => {
    const workspaceDir = await createTempWorkspace();

    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "rem",
      bodyLines: ["- Theme: initial pass"],
      nowMs: Date.parse("2026-04-05T10:00:00Z"),
      timezone: "UTC",
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });
    await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "rem",
      bodyLines: ["- Theme: refreshed pass"],
      nowMs: Date.parse("2026-04-05T14:00:00Z"),
      timezone: "UTC",
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).toContain("## 2026-04-05 - REM Sleep");
    expect(content).toContain("- Theme: refreshed pass");
    expect(content).not.toContain("- Theme: initial pass");
    expect(content.match(/## 2026-04-05 - REM Sleep/g)).toHaveLength(1);
  });

  it("still writes deep reports to the per-phase report directory", async () => {
    const workspaceDir = await createTempWorkspace();

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

    expect(reportPath).toBe(path.join(workspaceDir, "memory", "dreaming", "deep", "2026-04-05.md"));
    const content = await fs.readFile(reportPath!, "utf-8");
    expect(content).toContain("# Deep Sleep");
    expect(content).toContain("- Promoted: durable preference");
  });
});
