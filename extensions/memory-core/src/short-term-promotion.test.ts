import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyShortTermPromotions,
  auditShortTermPromotionArtifacts,
  isShortTermMemoryPath,
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
  repairShortTermPromotionArtifacts,
  resolveShortTermRecallStorePath,
  __testing,
} from "./short-term-promotion.js";

describe("short-term promotion", () => {
  async function withTempWorkspace(run: (workspaceDir: string) => Promise<void>) {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-promote-"));
    try {
      await run(workspaceDir);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  }

  it("detects short-term daily memory paths", () => {
    expect(isShortTermMemoryPath("memory/2026-04-03.md")).toBe(true);
    expect(isShortTermMemoryPath("2026-04-03.md")).toBe(true);
    expect(isShortTermMemoryPath("notes/2026-04-03.md")).toBe(false);
    expect(isShortTermMemoryPath("MEMORY.md")).toBe(false);
    expect(isShortTermMemoryPath("memory/network.md")).toBe(false);
  });

  it("records recalls and ranks candidates with weighted scores", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "router",
        results: [
          {
            path: "memory/2026-04-02.md",
            startLine: 3,
            endLine: 5,
            score: 0.9,
            snippet: "Configured VLAN 10 on Omada router",
            source: "memory",
          },
          {
            path: "MEMORY.md",
            startLine: 1,
            endLine: 1,
            score: 0.99,
            snippet: "Long-term note",
            source: "memory",
          },
        ],
      });
      await recordShortTermRecalls({
        workspaceDir,
        query: "iot vlan",
        results: [
          {
            path: "memory/2026-04-02.md",
            startLine: 3,
            endLine: 5,
            score: 0.8,
            snippet: "Configured VLAN 10 on Omada router",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });

      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.path).toBe("memory/2026-04-02.md");
      expect(ranked[0]?.recallCount).toBe(2);
      expect(ranked[0]?.uniqueQueries).toBe(2);
      expect(ranked[0]?.score).toBeGreaterThan(0);
      expect(ranked[0]?.conceptTags).toContain("router");
      expect(ranked[0]?.components.symbolic).toBeGreaterThan(0);

      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const raw = await fs.readFile(storePath, "utf-8");
      expect(raw).toContain("memory/2026-04-02.md");
      expect(raw).not.toContain("Long-term note");
    });
  });

  it("serializes concurrent recall writes so counts are not lost", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          recordShortTermRecalls({
            workspaceDir,
            query: `backup-${index % 4}`,
            results: [
              {
                path: "memory/2026-04-03.md",
                startLine: 1,
                endLine: 2,
                score: 0.9,
                snippet: "Move backups to S3 Glacier.",
                source: "memory",
              },
            ],
          }),
        ),
      );

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.recallCount).toBe(20);
      expect(ranked[0]?.uniqueQueries).toBe(4);
    });
  });

  it("uses default thresholds for promotion", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "glacier",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 2,
            score: 0.96,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({ workspaceDir });
      expect(ranked).toHaveLength(0);
    });
  });

  it("rewards spaced recalls as consolidation instead of only raw count", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "router",
        nowMs: Date.parse("2026-04-01T10:00:00.000Z"),
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 2,
            score: 0.9,
            snippet: "Configured router VLAN 10 and IoT segment.",
            source: "memory",
          },
        ],
      });
      await recordShortTermRecalls({
        workspaceDir,
        query: "iot segment",
        nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 2,
            score: 0.88,
            snippet: "Configured router VLAN 10 and IoT segment.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
      });

      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.recallDays).toEqual(["2026-04-01", "2026-04-04"]);
      expect(ranked[0]?.components.consolidation).toBeGreaterThan(0.4);
    });
  });

  it("treats negative threshold overrides as invalid and keeps defaults", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "glacier",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 2,
            score: 0.96,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: -1,
        minRecallCount: -1,
        minUniqueQueries: -1,
      });
      expect(ranked).toHaveLength(0);
    });
  });

  it("enforces default thresholds during apply even when candidates are passed directly", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: [
          {
            key: "memory:memory/2026-04-03.md:1:2",
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 2,
            source: "memory",
            snippet: "Move backups to S3 Glacier.",
            recallCount: 1,
            avgScore: 0.95,
            maxScore: 0.95,
            uniqueQueries: 1,
            firstRecalledAt: new Date().toISOString(),
            lastRecalledAt: new Date().toISOString(),
            ageDays: 0,
            score: 0.95,
            recallDays: [new Date().toISOString().slice(0, 10)],
            conceptTags: ["glacier", "backups"],
            components: {
              frequency: 0.2,
              relevance: 0.95,
              diversity: 0.2,
              recency: 1,
              consolidation: 0.2,
              symbolic: 0.4,
            },
          },
        ],
      });

      expect(applied.applied).toBe(0);
    });
  });

  it("applies promotion candidates to MEMORY.md and marks them promoted", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "gateway host",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 10,
            endLine: 12,
            score: 0.92,
            snippet: "Gateway binds loopback and port 18789",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(applied.applied).toBe(1);

      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).toContain("Promoted From Short-Term Memory");
      expect(memoryText).toContain("memory/2026-04-01.md:10-12");

      const rankedAfter = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(rankedAfter).toHaveLength(0);

      const rankedIncludingPromoted = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        includePromoted: true,
      });
      expect(rankedIncludingPromoted).toHaveLength(1);
      expect(rankedIncludingPromoted[0]?.promotedAt).toBeTruthy();
    });
  });

  it("does not re-append candidates that were promoted in a prior run", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "gateway host",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 10,
            endLine: 12,
            score: 0.92,
            snippet: "Gateway binds loopback and port 18789",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      const first = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(first.applied).toBe(1);

      const second = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(second.applied).toBe(0);

      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      const sectionCount = memoryText.match(/Promoted From Short-Term Memory/g)?.length ?? 0;
      expect(sectionCount).toBe(1);
    });
  });

  it("audits and repairs invalid store metadata plus stale locks", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              good: {
                key: "good",
                path: "memory/2026-04-01.md",
                startLine: 1,
                endLine: 2,
                source: "memory",
                snippet: "Gateway host uses qmd vector search for router notes.",
                recallCount: 2,
                totalScore: 1.8,
                maxScore: 0.95,
                firstRecalledAt: "2026-04-01T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["a", "b"],
              },
              bad: {
                path: "",
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const lockPath = path.join(workspaceDir, "memory", ".dreams", "short-term-promotion.lock");
      await fs.writeFile(lockPath, "999999:0\n", "utf-8");
      const staleMtime = new Date(Date.now() - 120_000);
      await fs.utimes(lockPath, staleMtime, staleMtime);

      const auditBefore = await auditShortTermPromotionArtifacts({ workspaceDir });
      expect(auditBefore.invalidEntryCount).toBe(1);
      expect(auditBefore.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["recall-store-invalid", "recall-lock-stale"]),
      );

      const repair = await repairShortTermPromotionArtifacts({ workspaceDir });
      expect(repair.changed).toBe(true);
      expect(repair.rewroteStore).toBe(true);
      expect(repair.removedStaleLock).toBe(true);

      const auditAfter = await auditShortTermPromotionArtifacts({ workspaceDir });
      expect(auditAfter.invalidEntryCount).toBe(0);
      expect(auditAfter.issues.map((issue) => issue.code)).not.toContain("recall-lock-stale");

      const repairedRaw = JSON.parse(await fs.readFile(storePath, "utf-8")) as {
        entries: Record<string, { conceptTags?: string[]; recallDays?: string[] }>;
      };
      expect(repairedRaw.entries.good?.conceptTags).toContain("router");
      expect(repairedRaw.entries.good?.recallDays).toEqual(["2026-04-04"]);
    });
  });

  it("extracts stable symbolic concept tags from snippets and paths", () => {
    expect(
      __testing.deriveSymbolicConceptTags({
        path: "memory/2026-04-03.md",
        snippet: "Move backups to S3 Glacier and sync QMD router notes.",
      }),
    ).toEqual(expect.arrayContaining(["glacier", "router", "backups"]));
  });
});
