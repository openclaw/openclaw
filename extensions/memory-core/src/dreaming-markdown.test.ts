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

describe("dreaming markdown storage", () => {
  const nowMs = Date.parse("2026-04-05T10:00:00Z");
  const timezone = "UTC";

  it("falls back when the injected timestamp is outside Date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    const result = await writeDailyDreamingPhaseBlock({
      workspaceDir,
      phase: "light",
      bodyLines: ["- Candidate: bounded fallback"],
      hasContent: true,
      nowMs: 8_640_000_000_000_001,
      timezone,
      storage: {
        mode: "inline",
        separateReports: false,
      },
    });

    expect(requireInlinePath(result)).toBe(path.join(workspaceDir, "memory", "2026-05-30.md"));
  });

  it("replaces the managed deep summary while preserving the diary block", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      [
        "# Dream Diary",
        "",
        "<!-- openclaw:dreaming:diary:start -->",
        "",
        "---",
        "",
        "*April 4, 2026, 3:00 AM*",
        "",
        "The old diary entry stays.",
        "",
        "<!-- openclaw:dreaming:diary:end -->",
        "",
        "## Deep Sleep",
        "<!-- openclaw:dreaming:deep:start -->",
        "- Old summary.",
        "<!-- openclaw:dreaming:deep:end -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    await writeDeepDreamingReport({
      workspaceDir,
      bodyLines: ["- New summary."],
      hasContent: true,
      storage: {
        mode: "inline",
        separateReports: false,
      },
      nowMs,
      timezone,
    });

    const dreamsContent = await fs.readFile(dreamsPath, "utf-8");
    expect(dreamsContent).toContain("The old diary entry stays.");
    expect(dreamsContent).toContain("- New summary.");
    expect(dreamsContent).not.toContain("- Old summary.");
  });

  it.each([
    {
      label: "daily inline phase",
      relativePath: path.join("memory", "2026-04-05.md"),
      run: async (workspaceDir: string) =>
        await writeDailyDreamingPhaseBlock({
          workspaceDir,
          phase: "light",
          bodyLines: ["- Candidate: replacement"],
          hasContent: true,
          nowMs,
          timezone,
          storage: { mode: "inline", separateReports: false },
        }),
    },
    {
      label: "separate light report",
      relativePath: path.join("memory", "dreaming", "light", "2026-04-05.md"),
      run: async (workspaceDir: string) =>
        await writeDailyDreamingPhaseBlock({
          workspaceDir,
          phase: "light",
          bodyLines: ["- Candidate: replacement"],
          hasContent: true,
          nowMs,
          timezone,
          storage: { mode: "separate", separateReports: false },
        }),
    },
  ])("keeps an existing $label when replacement fails", async ({ relativePath, run }) => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-atomic-");
    const targetPath = path.join(workspaceDir, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, "# Previous dreaming artifact\n", "utf-8");
    const priorBytes = await fs.readFile(targetPath);
    const realRename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (
        typeof destination === "string" &&
        path.resolve(destination) === path.resolve(targetPath)
      ) {
        throw Object.assign(new Error("replace failed"), { code: "ENOSPC" });
      }
      await realRename(source, destination);
    });

    await expect(run(workspaceDir)).rejects.toThrow("replace failed");
    await expect(fs.readFile(targetPath)).resolves.toEqual(priorBytes);
    await expect(fs.readdir(path.dirname(targetPath))).resolves.toEqual([
      path.basename(targetPath),
    ]);
  });

  it("preserves read errors from an empty daily report", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-read-error-");
    const failure = Object.assign(new Error("daily file unavailable"), { code: "EACCES" });
    vi.spyOn(fs, "access").mockRejectedValue(failure);
    vi.spyOn(fs, "readFile").mockRejectedValue(failure);

    await expect(
      writeDailyDreamingPhaseBlock({
        workspaceDir,
        phase: "light",
        bodyLines: ["- No notable updates."],
        hasContent: false,
        nowMs,
        timezone,
        storage: { mode: "both", separateReports: false },
      }),
    ).rejects.toBe(failure);
  });
});
