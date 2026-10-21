import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeDailyDreamingPhaseBlock, writeDeepDreamingReport } from "./dreaming-markdown.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

afterEach(() => vi.restoreAllMocks());

describe("dreaming markdown storage", () => {
  const nowMs = Date.parse("2026-04-05T10:00:00Z");
  const timezone = "UTC";
  const defaults = {
    bodyLines: ["- Candidate: replacement"],
    hasContent: true,
    nowMs,
    timezone,
    storage: { mode: "inline" as const, separateReports: false },
  };
  const daily = (
    workspaceDir: string,
    overrides: Partial<Parameters<typeof writeDailyDreamingPhaseBlock>[0]> = {},
  ) => writeDailyDreamingPhaseBlock({ ...defaults, phase: "light", workspaceDir, ...overrides });

  it("falls back when the injected timestamp is outside Date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");

    const result = await daily(workspaceDir, {
      bodyLines: ["- Candidate: bounded fallback"],
      nowMs: 8_640_000_000_000_001,
    });

    expect(result.inlinePath).toBe(path.join(workspaceDir, "memory", "2026-05-30.md"));
  });

  it("replaces the managed deep summary while preserving the diary block", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      `<!-- openclaw:dreaming:diary:start -->
The old diary entry stays.
<!-- openclaw:dreaming:diary:end -->
## Deep Sleep
<!-- openclaw:dreaming:deep:start -->
- Old summary.
<!-- openclaw:dreaming:deep:end -->
`,
      "utf-8",
    );

    await writeDeepDreamingReport({
      ...defaults,
      workspaceDir,
      bodyLines: ["- New summary."],
    });

    const dreamsContent = await fs.readFile(dreamsPath, "utf-8");
    expect(dreamsContent).toContain("The old diary entry stays.");
    expect(dreamsContent).toContain("- New summary.");
    expect(dreamsContent).not.toContain("- Old summary.");
  });

  it.each(["inline", "separate"] as const)(
    "keeps an existing %s report when replacement fails",
    async (mode) => {
      const workspaceDir = await createTempWorkspace("openclaw-dreaming-markdown-atomic-");
      const targetPath = path.join(
        workspaceDir,
        "memory",
        ...(mode === "separate" ? ["dreaming", "light"] : []),
        "2026-04-05.md",
      );
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

      await expect(
        daily(workspaceDir, { storage: { mode, separateReports: false } }),
      ).rejects.toThrow("replace failed");
      await expect(fs.readFile(targetPath)).resolves.toEqual(priorBytes);
      await expect(fs.readdir(path.dirname(targetPath))).resolves.toEqual([
        path.basename(targetPath),
      ]);
    },
  );

  it("preserves read errors from an empty daily report", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-dreaming-read-error-");
    const failure = Object.assign(new Error("daily file unavailable"), { code: "EACCES" });
    vi.spyOn(fs, "access").mockRejectedValue(failure);
    vi.spyOn(fs, "readFile").mockRejectedValue(failure);

    await expect(
      daily(workspaceDir, {
        bodyLines: ["- No notable updates."],
        hasContent: false,
        storage: { mode: "both", separateReports: false },
      }),
    ).rejects.toBe(failure);
  });
});
