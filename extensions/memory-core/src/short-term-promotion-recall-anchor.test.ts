// Memory Core tests cover recall anchor normalization on short term promotion rehydration.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it as baseIt, vi } from "vitest";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
} from "./short-term-promotion.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "./test-helpers.js";

vi.mock("openclaw/plugin-sdk/memory-host-events", () => ({
  appendMemoryHostEvent: vi.fn(async () => {}),
}));

type RecordRecallParams = Parameters<typeof recordShortTermRecalls>[0];
type RecallResult = RecordRecallParams["results"][number];
type RecallResultExtras = Partial<
  Omit<RecallResult, "path" | "startLine" | "endLine" | "score" | "snippet" | "source">
>;
type RankAllOptions = Omit<
  Parameters<typeof rankShortTermPromotionCandidates>[0],
  "workspaceDir" | "minScore" | "minRecallCount" | "minUniqueQueries"
>;
type ApplyAllOptions = Omit<
  Parameters<typeof applyShortTermPromotions>[0],
  "workspaceDir" | "candidates" | "minScore" | "minRecallCount" | "minUniqueQueries"
>;

const allPromotionThresholds = {
  minScore: 0,
  minRecallCount: 0,
  minUniqueQueries: 0,
} as const;

function memoryRecallResult(
  memoryPath: string,
  startLine: number,
  endLine: number,
  score: number,
  snippet: string,
  extras: RecallResultExtras = {},
): RecallResult {
  return { ...extras, path: memoryPath, startLine, endLine, score, snippet, source: "memory" };
}

function recordMemoryRecalls(
  workspaceDir: string,
  query: string,
  results: RecallResult[],
  options: Omit<RecordRecallParams, "workspaceDir" | "query" | "results"> = {},
): Promise<void> {
  return recordShortTermRecalls({ ...options, workspaceDir, query, results });
}

function rankAllCandidates(workspaceDir: string, options: RankAllOptions = {}) {
  return rankShortTermPromotionCandidates({ ...options, workspaceDir, ...allPromotionThresholds });
}

function applyAllCandidates(
  workspaceDir: string,
  candidates: Parameters<typeof applyShortTermPromotions>[0]["candidates"],
  options: ApplyAllOptions = {},
) {
  return applyShortTermPromotions({
    ...options,
    workspaceDir,
    candidates,
    ...allPromotionThresholds,
  });
}

describe("short-term promotion recall anchors", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    await configureMemoryCoreDreamingStateForTests();
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-promote-anchor-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    resetMemoryCoreDreamingStateForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function withTempWorkspace(run: (workspaceDir: string) => Promise<void>) {
    const workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    await run(workspaceDir);
  }

  type WorkspaceTest = (title: string, run: (workspaceDir: string) => Promise<void>) => void;
  const it: WorkspaceTest = (title, run) =>
    baseIt(title, async () => {
      await withTempWorkspace(run);
    });

  async function writeDailyMemoryNote(
    workspaceDir: string,
    date: string,
    lines: string[],
  ): Promise<string> {
    const notePath = path.join(workspaceDir, "memory", `${date}.md`);
    await fs.writeFile(notePath, `${lines.join("\n")}\n`, "utf-8");
    return notePath;
  }

  it("rehydrates snippets whose live range gained an HTML comment", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "intro",
      "summary",
      "Moved backups to S3 Glacier.",
      "Keep cold storage retention at 365 days.",
    ]);
    await recordMemoryRecalls(workspaceDir, "glacier", [
      memoryRecallResult(
        "memory/2026-04-01.md",
        3,
        4,
        0.94,
        "Moved backups to S3 Glacier. Keep cold storage retention at 365 days.",
      ),
    ]);
    // A later tool adds an HTML comment inside the recorded range; the snippet
    // text itself is unchanged, so the same normalization must apply on both
    // sides of the comparison.
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "intro",
      "summary",
      "Moved backups to S3 Glacier.",
      "<!-- updated during review -->",
      "Keep cold storage retention at 365 days.",
    ]);

    const ranked = await rankAllCandidates(workspaceDir);
    const applied = await applyAllCandidates(workspaceDir, ranked);

    expect(applied.applied).toBe(1);
    expect(applied.appliedCandidates[0]?.startLine).toBe(3);
    expect(applied.appliedCandidates[0]?.endLine).toBe(5);
    expect(applied.appliedCandidates[0]?.snippet).toBe(
      "Moved backups to S3 Glacier. Keep cold storage retention at 365 days.",
    );
  });

  it("does not anchor promotion on a fragment when the live range lost content", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "intro",
      "summary",
      "Moved backups to S3 Glacier.",
      "",
    ]);
    await recordMemoryRecalls(workspaceDir, "glacier", [
      memoryRecallResult(
        "memory/2026-04-01.md",
        3,
        4,
        0.94,
        "Moved backups to S3 Glacier. Keep cold storage retention at 365 days.",
      ),
    ]);

    const ranked = await rankAllCandidates(workspaceDir);
    const applied = await applyAllCandidates(workspaceDir, ranked);

    // The stored two-line snippet only survives as its first line, so the
    // scan can only offer a fragment of the recorded content. Promoting that
    // fragment would silently carry the wrong lines into MEMORY.md; the
    // candidate must surface as unresolved instead.
    expect(applied.applied).toBe(0);
  });

  it("keeps eligible text beside a dreaming fence when a marker window matches exactly", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "intro",
      "summary",
      "Moved backups to S3 Glacier.",
    ]);
    await recordMemoryRecalls(workspaceDir, "glacier", [
      memoryRecallResult("memory/2026-04-01.md", 3, 3, 0.94, "Moved backups to S3 Glacier."),
    ]);
    // Dreaming markers land on the lines before the recorded one. Stripping
    // comments turns the window that spans the closing marker and the text
    // into an exact match closer to the recorded coordinates than the text
    // line itself, so selection must not consider managed windows at all;
    // otherwise the fence guard would discard the winning window and the
    // candidate would surface as unresolved even though its complete text is
    // still available right beside the fence.
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "intro",
      "<!-- openclaw:dreaming:scratch:start -->",
      "<!-- openclaw:dreaming:scratch:end -->",
      "Moved backups to S3 Glacier.",
    ]);

    const ranked = await rankAllCandidates(workspaceDir);
    const applied = await applyAllCandidates(workspaceDir, ranked);

    expect(applied.applied).toBe(1);
    expect(applied.appliedCandidates[0]?.startLine).toBe(4);
    expect(applied.appliedCandidates[0]?.endLine).toBe(4);
    expect(applied.appliedCandidates[0]?.snippet).toBe("Moved backups to S3 Glacier.");
  });

  it("scans a large fence-free note in linear time for an unresolved passage", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "intro",
      "summary",
      "Moved backups to S3 Glacier.",
      "Keep cold storage retention at 365 days.",
    ]);
    await recordMemoryRecalls(workspaceDir, "glacier", [
      memoryRecallResult(
        "memory/2026-04-01.md",
        3,
        4,
        0.94,
        "Moved backups to S3 Glacier. Keep cold storage retention at 365 days.",
      ),
    ]);
    const fillerLines = Array.from(
      { length: 4000 },
      (_, index) => `Unrelated filler line ${index + 1} about daily notes.`,
    );
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", fillerLines);

    const startedAt = performance.now();
    const ranked = await rankAllCandidates(workspaceDir);
    const applied = await applyAllCandidates(workspaceDir, ranked);
    const elapsedMs = performance.now() - startedAt;

    // The recorded passage is gone, so every candidate window is compared and
    // the candidate surfaces as unresolved. Managed-range eligibility must not
    // rescan the note from the top per window; the ceiling sits far above the
    // linear cost even on a contended runner, while per-window rescans of a
    // 4000-line note take an order of magnitude longer.
    expect(applied.applied).toBe(0);
    expect(elapsedMs).toBeLessThan(4000);
  });

  it("records complete-text promotion beside an explicit source-rehydration rejection", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "intro",
      "Moved backups to S3 Glacier.",
      "Keep cold storage retention at 365 days.",
      "Vendor renewal signed for two more years.",
    ]);
    await recordMemoryRecalls(workspaceDir, "glacier", [
      memoryRecallResult(
        "memory/2026-04-01.md",
        2,
        3,
        0.94,
        "Moved backups to S3 Glacier. Keep cold storage retention at 365 days.",
      ),
      memoryRecallResult(
        "memory/2026-04-01.md",
        4,
        4,
        0.91,
        "Vendor renewal signed for two more years.",
      ),
    ]);
    // One apply run sees both fates: the first passage survives with a comment
    // gained above it, so rehydration relocates its complete text; the second
    // passage's line was replaced by unrelated content, so rehydration fails
    // and apply must record that rejection instead of promoting the filler.
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "intro",
      "<!-- status refreshed by tooling -->",
      "Moved backups to S3 Glacier.",
      "Keep cold storage retention at 365 days.",
      "Unrelated replacement text now occupies the vendor line.",
    ]);

    const ranked = await rankAllCandidates(workspaceDir);
    const applied = await applyAllCandidates(workspaceDir, ranked);
    const memoryFile = await fs.readFile(applied.memoryPath, "utf-8");

    expect(applied.applied).toBe(1);
    expect(applied.appliedCandidates[0]?.snippet).toBe(
      "Moved backups to S3 Glacier. Keep cold storage retention at 365 days.",
    );
    const rejected = applied.rejectedCandidates.find(
      (entry) => entry.candidate.snippet === "Vendor renewal signed for two more years.",
    );
    expect(rejected?.reason).toBe("source rehydration failed");
    expect(rejected?.category).toBe("source rehydration");
    expect(memoryFile).toContain(
      "Moved backups to S3 Glacier. Keep cold storage retention at 365 days.",
    );
    expect(memoryFile).not.toContain("Unrelated replacement text");
  });

  it("does not promote replacement text through a comment-only stored anchor", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "intro",
      "summary",
      "Moved backups to S3 Glacier.",
      "Keep cold storage retention at 365 days.",
    ]);
    await recordMemoryRecalls(workspaceDir, "glacier", [
      memoryRecallResult("memory/2026-04-01.md", 3, 4, 0.94, "<!-- archived backup note -->"),
    ]);
    // A comment-only anchor normalizes away to nothing after comment
    // stripping. The recorded lines were later replaced by unrelated content,
    // so positional fallback at the recorded coordinates would promote that
    // replacement text; the candidate must surface as unresolved instead.
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      "intro",
      "summary",
      "Moved backups to S3 Glacier.",
      "Unrelated replacement text now occupies the recorded lines.",
    ]);

    const ranked = await rankAllCandidates(workspaceDir);
    const applied = await applyAllCandidates(workspaceDir, ranked);

    expect(applied.applied).toBe(0);
  });
});
