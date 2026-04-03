import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyShortTermPromotions,
  isShortTermMemoryPath,
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
  resolveShortTermRecallStorePath,
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

      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const raw = await fs.readFile(storePath, "utf-8");
      expect(raw).toContain("memory/2026-04-02.md");
      expect(raw).not.toContain("Long-term note");
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
            components: {
              frequency: 0.2,
              relevance: 0.95,
              diversity: 0.2,
              recency: 1,
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
});
