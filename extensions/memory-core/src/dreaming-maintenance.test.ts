import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  __testing,
  applyDreamingMaintenance,
  rollbackDreamingMaintenance,
  stageDreamingMaintenance,
} from "./dreaming-maintenance.js";
import type { PromotionCandidate, ShortTermRecallEntry } from "./short-term-promotion.js";

describe("dreaming maintenance", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(
      path.join(process.env.TMPDIR ?? "/tmp", "dreaming-maintenance-"),
    );
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function createWorkspace(): Promise<string> {
    const workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    return workspaceDir;
  }

  function createRecall(overrides: Partial<ShortTermRecallEntry>): ShortTermRecallEntry {
    return {
      key: overrides.key ?? "memory:memory/daily-log.md:1:1:claim-1",
      path: overrides.path ?? "memory/daily-log.md",
      startLine: overrides.startLine ?? 1,
      endLine: overrides.endLine ?? 1,
      source: "memory",
      snippet: overrides.snippet ?? "Prefer S3 Glacier for cold backups.",
      recallCount: overrides.recallCount ?? 1,
      dailyCount: overrides.dailyCount ?? 1,
      groundedCount: overrides.groundedCount ?? 0,
      totalScore: overrides.totalScore ?? 1.2,
      maxScore: overrides.maxScore ?? 0.92,
      firstRecalledAt: overrides.firstRecalledAt ?? "2026-04-22T08:00:00.000Z",
      lastRecalledAt: overrides.lastRecalledAt ?? "2026-04-22T08:00:00.000Z",
      queryHashes: overrides.queryHashes ?? ["q1"],
      queryTerms: overrides.queryTerms ?? ["backup policy", "__dreaming_daily__:daily-log"],
      recallDays: overrides.recallDays ?? ["2026-04-22"],
      conceptTags: overrides.conceptTags ?? ["backup", "glacier"],
      claimHash: overrides.claimHash ?? "claim-1",
      promotedAt: overrides.promotedAt,
    };
  }

  function createCandidate(overrides: Partial<PromotionCandidate>): PromotionCandidate {
    return {
      key: overrides.key ?? "candidate-1",
      path: overrides.path ?? "memory/daily-log.md",
      startLine: overrides.startLine ?? 1,
      endLine: overrides.endLine ?? 1,
      source: "memory",
      snippet: overrides.snippet ?? "Prefer S3 Glacier for cold backups.",
      recallCount: overrides.recallCount ?? 2,
      dailyCount: overrides.dailyCount ?? 1,
      groundedCount: overrides.groundedCount ?? 0,
      signalCount: overrides.signalCount ?? 3,
      avgScore: overrides.avgScore ?? 0.91,
      maxScore: overrides.maxScore ?? 0.93,
      uniqueQueries: overrides.uniqueQueries ?? 2,
      queryTerms: overrides.queryTerms ?? ["backup policy", "__dreaming_daily__:daily-log"],
      claimHash: overrides.claimHash ?? "claim-1",
      promotedAt: overrides.promotedAt,
      firstRecalledAt: overrides.firstRecalledAt ?? "2026-04-22T08:00:00.000Z",
      lastRecalledAt: overrides.lastRecalledAt ?? "2026-04-22T08:00:00.000Z",
      ageDays: overrides.ageDays ?? 0,
      score: overrides.score ?? 0.91,
      recallDays: overrides.recallDays ?? ["2026-04-22"],
      conceptTags: overrides.conceptTags ?? ["backup", "glacier"],
      components: overrides.components ?? {
        frequency: 0.8,
        relevance: 0.9,
        diversity: 0.4,
        recency: 1,
        consolidation: 0.2,
        conceptual: 0.3,
      },
    };
  }

  const config = {
    enabled: true,
    autoApply: false,
    maxManagedEntries: 4,
    maxEntryChars: 180,
    maxIndexLines: 8,
    maxEvidencePerEntry: 4,
    maxQueryTermsPerEntry: 6,
    staleAfterDays: 30,
  } as const;

  it("stages maintenance without touching MEMORY.md, then applies and rolls back cleanly", async () => {
    const workspaceDir = await createWorkspace();
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    const originalMemory = "# Long-Term Memory\n\n- Manual memory stays untouched.\n";
    await fs.writeFile(memoryPath, originalMemory, "utf-8");

    const report = await stageDreamingMaintenance({
      workspaceDir,
      config,
      dailySignalFiles: ["memory/daily-log.md"],
      candidates: [createCandidate({ claimHash: "claim-stage" })],
      recalls: [createRecall({ claimHash: "claim-stage" })],
      nowMs: Date.parse("2026-04-22T09:00:00.000Z"),
    });

    expect(report.staged).toBe(true);
    expect(report.applied).toBe(false);
    expect(report.fileChanges.map((change) => change.path)).toEqual([
      "MEMORY.md",
      "memory/.dreams/maintenance/current.json",
    ]);
    expect(await fs.readFile(memoryPath, "utf-8")).toBe(originalMemory);

    const paths = __testing.resolveMaintenancePaths(workspaceDir);
    await expect(fs.readFile(paths.stagedPlanPath, "utf-8")).resolves.toContain('"staged": true');
    await expect(fs.readFile(paths.stagedSummaryPath, "utf-8")).resolves.toContain(
      "Dreaming Maintenance",
    );

    const applied = await applyDreamingMaintenance({ workspaceDir });
    expect(applied).toEqual({
      status: "applied",
      reportId: report.reportId,
      touchedFiles: ["MEMORY.md", "memory/.dreams/maintenance/current.json"],
    });

    const appliedMemory = await fs.readFile(memoryPath, "utf-8");
    expect(appliedMemory).toContain("Manual memory stays untouched.");
    expect(appliedMemory).toContain("## Dreaming Maintained Memory");
    expect(appliedMemory).toContain("Prefer S3 Glacier for cold backups.");
    expect(appliedMemory).toContain("## Dreaming Memory Index");

    const rolledBack = await rollbackDreamingMaintenance({ workspaceDir });
    expect(rolledBack).toEqual({
      status: "rolled_back",
      reportId: report.reportId,
      touchedFiles: ["MEMORY.md", "memory/.dreams/maintenance/current.json"],
    });
    expect(await fs.readFile(memoryPath, "utf-8")).toBe(originalMemory);
    await expect(
      fs.stat(path.join(workspaceDir, "memory", ".dreams", "maintenance", "current.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("counts add, merge, fix, prune, and index operations in one staged report", async () => {
    const workspaceDir = await createWorkspace();
    const paths = __testing.resolveMaintenancePaths(workspaceDir);
    await fs.mkdir(path.dirname(paths.currentStatePath), { recursive: true });
    await fs.writeFile(
      paths.currentStatePath,
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-03-01T00:00:00.000Z",
          entries: [
            {
              id: "merge-1",
              claimHash: "claim-merge",
              snippet: "Keep weekly DB snapshots.",
              sourcePath: "memory/daily-log.md",
              startLine: 1,
              endLine: 1,
              score: 0.6,
              recallCount: 1,
              uniqueQueries: 1,
              queryTerms: ["old query"],
              conceptTags: ["backup"],
              firstSupportedAt: "2026-03-01T00:00:00.000Z",
              lastSupportedAt: "2026-03-05T00:00:00.000Z",
              evidence: [
                {
                  kind: "daily-log",
                  path: "memory/daily-log.md",
                  startLine: 1,
                  endLine: 1,
                  queryTerms: ["old query"],
                  firstSupportedAt: "2026-03-01T00:00:00.000Z",
                  lastSupportedAt: "2026-03-05T00:00:00.000Z",
                  signalCount: 1,
                },
              ],
            },
            {
              id: "fix-1",
              claimHash: "claim-old-fix",
              snippet: "Use old retention policy.",
              sourcePath: "memory/system-status.md",
              startLine: 2,
              endLine: 2,
              score: 0.55,
              recallCount: 1,
              uniqueQueries: 1,
              queryTerms: ["status"],
              conceptTags: ["retention"],
              firstSupportedAt: "2026-03-01T00:00:00.000Z",
              lastSupportedAt: "2026-03-10T00:00:00.000Z",
              evidence: [
                {
                  kind: "daily-note",
                  path: "memory/system-status.md",
                  startLine: 2,
                  endLine: 2,
                  queryTerms: ["status"],
                  firstSupportedAt: "2026-03-01T00:00:00.000Z",
                  lastSupportedAt: "2026-03-10T00:00:00.000Z",
                  signalCount: 1,
                },
              ],
            },
            {
              id: "stale-1",
              claimHash: "claim-stale",
              snippet: "Temporary incident workaround.",
              sourcePath: "memory/incidents.md",
              startLine: 5,
              endLine: 5,
              score: 0.4,
              recallCount: 1,
              uniqueQueries: 1,
              queryTerms: ["incident"],
              conceptTags: ["incident"],
              firstSupportedAt: "2026-02-01T00:00:00.000Z",
              lastSupportedAt: "2026-02-02T00:00:00.000Z",
              evidence: [
                {
                  kind: "daily-note",
                  path: "memory/incidents.md",
                  startLine: 5,
                  endLine: 5,
                  queryTerms: ["incident"],
                  firstSupportedAt: "2026-02-01T00:00:00.000Z",
                  lastSupportedAt: "2026-02-02T00:00:00.000Z",
                  signalCount: 1,
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const report = await stageDreamingMaintenance({
      workspaceDir,
      config: {
        ...config,
        maxManagedEntries: 2,
      },
      dailySignalFiles: ["memory/daily-log.md"],
      candidates: [
        createCandidate({
          claimHash: "claim-merge",
          snippet: "Keep weekly DB snapshots.",
          path: "memory/daily-log.md",
          queryTerms: ["backup policy", "__dreaming_daily__:daily-log"],
        }),
        createCandidate({
          claimHash: "claim-fix",
          snippet: "Use a 30-day retention policy.",
          path: "memory/system-status.md",
          queryTerms: ["status refresh"],
        }),
        createCandidate({
          claimHash: "claim-add",
          snippet: "Route cold logs to Glacier Deep Archive.",
          path: "memory/archive-plan.md",
          queryTerms: ["archive policy"],
          score: 0.95,
        }),
      ],
      recalls: [
        createRecall({
          claimHash: "claim-merge",
          key: "merge-key",
          path: "memory/daily-log.md",
          snippet: "Keep weekly DB snapshots.",
          queryTerms: ["backup policy", "__dreaming_daily__:daily-log"],
        }),
        createRecall({
          claimHash: "claim-fix",
          key: "fix-key",
          path: "memory/system-status.md",
          snippet: "Use a 30-day retention policy.",
          queryTerms: ["status refresh"],
        }),
        createRecall({
          claimHash: "claim-add",
          key: "add-key",
          path: "memory/archive-plan.md",
          snippet: "Route cold logs to Glacier Deep Archive.",
          queryTerms: ["archive policy"],
        }),
      ],
      nowMs: Date.parse("2026-04-22T10:00:00.000Z"),
    });

    expect(report.operationCounts).toEqual({
      add: 1,
      merge: 1,
      fix: 1,
      prune: 2,
      index: 1,
    });
    expect(report.diffSummary.join(" | ")).toContain("ADD");
    expect(report.diffSummary.join(" | ")).toContain("MERGE");
    expect(report.diffSummary.join(" | ")).toContain("FIX");
    expect(report.diffSummary.join(" | ")).toContain("PRUNE");
    expect(report.queryTerms).toEqual(
      expect.arrayContaining(["backup policy", "status refresh", "archive policy"]),
    );
  });
});
