import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/memory-host-events", () => ({
  appendMemoryHostEvent: vi.fn(async () => {}),
}));

import { rememberRecentDailyMemoryFile } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  applyShortTermPromotions,
  auditShortTermPromotionArtifacts,
  filterLiveShortTermRecallEntries,
  isShortTermMemoryPath,
  readShortTermRecallEntries,
  recordGroundedShortTermCandidates,
  rankShortTermPromotionCandidates,
  recordDreamingPhaseSignals,
  recordShortTermRecalls,
  removeGroundedShortTermCandidates,
  repairShortTermPromotionArtifacts,
  resolveShortTermRecallLockPath,
  resolveShortTermPhaseSignalStorePath,
  resolveShortTermRecallStorePath,
  __testing,
} from "./short-term-promotion.js";

const SESSION_SUMMARY_DAILY_MEMORY_SENTINEL = "<!-- openclaw:session-memory-summary -->";

describe("short-term promotion", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-promote-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function withTempWorkspace(run: (workspaceDir: string) => Promise<void>) {
    const workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    await run(workspaceDir);
  }

  async function writeDailyMemoryNote(
    workspaceDir: string,
    date: string,
    lines: string[],
  ): Promise<string> {
    const notePath = path.join(workspaceDir, "memory", `${date}.md`);
    await fs.writeFile(notePath, `${lines.join("\n")}\n`, "utf-8");
    return notePath;
  }

  async function writeDailyMemoryNoteInSubdir(
    workspaceDir: string,
    subdir: string,
    date: string,
    lines: string[],
  ): Promise<string> {
    const dir = path.join(workspaceDir, "memory", subdir);
    await fs.mkdir(dir, { recursive: true });
    const notePath = path.join(dir, `${date}.md`);
    await fs.writeFile(notePath, `${lines.join("\n")}\n`, "utf-8");
    return notePath;
  }

  it("detects short-term daily memory paths", () => {
    expect(isShortTermMemoryPath("memory/2026-04-03.md")).toBe(true);
    expect(isShortTermMemoryPath("memory/2026-04-03-session-reset.md")).toBe(true);
    expect(isShortTermMemoryPath("2026-04-03.md")).toBe(true);
    expect(isShortTermMemoryPath("2026-04-03-session-reset.md")).toBe(true);
    expect(isShortTermMemoryPath("/tmp/workspace/memory/2026-04-03.md")).toBe(true);
    expect(isShortTermMemoryPath("memory/.dreams/session-corpus/2026-04-03.txt")).toBe(true);
    expect(isShortTermMemoryPath("notes/2026-04-03.md")).toBe(false);
    expect(isShortTermMemoryPath("MEMORY.md")).toBe(false);
    expect(isShortTermMemoryPath("memory/network.md")).toBe(false);
    expect(isShortTermMemoryPath("memory/daily/2026-04-03.md")).toBe(false);
    expect(isShortTermMemoryPath("memory/daily notes/2026-04-03.md")).toBe(false);
    expect(isShortTermMemoryPath("memory/日记/2026-04-03.md")).toBe(false);
    expect(isShortTermMemoryPath("memory/notes/2026-04-03.md")).toBe(false);
    expect(isShortTermMemoryPath("memory/nested/deep/2026-04-03.md")).toBe(false);
    expect(isShortTermMemoryPath("memory/dreaming/2026-04-03.md")).toBe(false);
    expect(isShortTermMemoryPath("memory/dreaming/deep/2026-04-03.md")).toBe(false);
    expect(isShortTermMemoryPath("../../vault/memory/dreaming/deep/2026-04-03.md")).toBe(false);
    expect(isShortTermMemoryPath("/tmp/workspace/memory/daily/2026-04-03.md")).toBe(false);
    expect(isShortTermMemoryPath("notes/daily/2026-04-03.md")).toBe(false);
  });

  it("ignores session-summary daily files when recording short-term recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-04-03-session-reset.md"),
        [
          "# Session: 2026-04-03 19:30:00 America/Chicago",
          "",
          SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
          "",
          "- **Session Key**: agent:main:main",
          "- **Session ID**: reset-123",
          "- **Source**: cli",
          "",
          "## Conversation Summary",
          "",
          "assistant: bookkeeping only",
        ].join("\n") + "\n",
        "utf-8",
      );

      await recordShortTermRecalls({
        workspaceDir,
        query: "bookkeeping recall",
        results: [
          {
            path: "memory/2026-04-03-session-reset.md",
            startLine: 9,
            endLine: 9,
            score: 0.9,
            snippet: "assistant: bookkeeping only",
            source: "memory",
          },
        ],
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      const entries = await readShortTermRecallEntries({
        workspaceDir,
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      expect(entries).toEqual([]);
    });
  });

  it("hides persisted session-summary recall entries from reads and ranking", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", ["Durable router note."]);
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-04-03-session-reset.md"),
        [
          "# Session: 2026-04-03 19:30:00 America/Chicago",
          "",
          SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
          "",
          "- **Session Key**: agent:main:main",
          "- **Session ID**: reset-123",
          "- **Source**: cli",
          "",
          "## Conversation Summary",
          "",
          "assistant: bookkeeping only",
        ].join("\n") + "\n",
        "utf-8",
      );

      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              durable: {
                key: "durable",
                path: "memory/2026-04-03.md",
                startLine: 1,
                endLine: 1,
                source: "memory",
                snippet: "Durable router note.",
                recallCount: 2,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 1.8,
                maxScore: 0.95,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["a", "b"],
                recallDays: ["2026-04-03"],
                conceptTags: ["router"],
              },
              bookkeeping: {
                key: "bookkeeping",
                path: "memory/2026-04-03-session-reset.md",
                startLine: 9,
                endLine: 9,
                source: "memory",
                snippet: "# Session: 2026-04-03 10:00:00 UTC",
                recallCount: 3,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 2.1,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["summary"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const entries = await readShortTermRecallEntries({
        workspaceDir,
        nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
      });
      expect(entries.map((entry) => entry.path)).toEqual(["memory/2026-04-03.md"]);

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
      });
      expect(ranked.map((entry) => entry.path)).toEqual(["memory/2026-04-03.md"]);
    });
  });

  it("does not merge durable recalls into stale bookkeeping entries that share the same claim hash", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const snippet = "Always use Happy Together calendar.";
      const claimHash = __testing.buildClaimHash(snippet);
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [snippet]);
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-04-03-session-reset.md"),
        [
          "# Session: 2026-04-03 19:30:00 America/Chicago",
          "",
          SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
          "",
          "- **Session Key**: agent:main:main",
          "- **Session ID**: reset-123",
          "- **Source**: cli",
          "",
          "## Conversation Summary",
          "",
          `assistant: ${snippet}`,
        ].join("\n") + "\n",
        "utf-8",
      );

      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              bookkeeping: {
                key: "bookkeeping",
                path: "memory/2026-04-03-session-reset.md",
                startLine: 9,
                endLine: 9,
                source: "memory",
                snippet,
                recallCount: 3,
                dailyCount: 2,
                groundedCount: 0,
                totalScore: 2.4,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["summary-q"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
                claimHash,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await recordShortTermRecalls({
        workspaceDir,
        query: "durable recall",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            score: 0.8,
            snippet,
            source: "memory",
          },
        ],
        nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
      });

      const entries = await readShortTermRecallEntries({
        workspaceDir,
        nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
      });

      expect(entries).toEqual([
        expect.objectContaining({
          path: "memory/2026-04-03.md",
          recallCount: 1,
          dailyCount: 0,
          groundedCount: 0,
          totalScore: 0.8,
          maxScore: 0.8,
        }),
      ]);
      expect(entries[0]?.queryHashes).not.toContain("summary-q");
    });
  });

  it("ignores short-term recall for notes stored in a memory/ subdirectory", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const notePath = await writeDailyMemoryNoteInSubdir(workspaceDir, "daily", "2026-04-03", [
        "Subdirectory recall integration test note.",
      ]);
      const relativePath = path.relative(workspaceDir, notePath).replaceAll("\\", "/");
      await recordShortTermRecalls({
        workspaceDir,
        query: "test query",
        results: [
          {
            path: relativePath,
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "Subdirectory recall integration test note.",
          },
        ],
      });
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await expect(fs.readFile(storePath, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("ignores short-term recall for notes stored in spaced and Unicode memory subdirectories", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const spacedPath = await writeDailyMemoryNoteInSubdir(
        workspaceDir,
        "daily notes",
        "2026-04-03",
        ["Spaced subdirectory recall integration test note."],
      );
      const unicodePath = await writeDailyMemoryNoteInSubdir(workspaceDir, "日记", "2026-04-04", [
        "Unicode subdirectory recall integration test note.",
      ]);

      await recordShortTermRecalls({
        workspaceDir,
        query: "nested subdir query",
        results: [
          {
            path: path.relative(workspaceDir, spacedPath).replaceAll("\\", "/"),
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "Spaced subdirectory recall integration test note.",
          },
          {
            path: path.relative(workspaceDir, unicodePath).replaceAll("\\", "/"),
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.85,
            snippet: "Unicode subdirectory recall integration test note.",
          },
        ],
      });

      await expect(
        fs.readFile(resolveShortTermRecallStorePath(workspaceDir), "utf-8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("ignores dream report paths when recording short-term recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "dream recall",
        results: [
          {
            path: "memory/dreaming/deep/2026-04-03.md",
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "Auto-generated dream report should not seed promotions.",
          },
        ],
      });

      await expect(
        fs.readFile(resolveShortTermRecallStorePath(workspaceDir), "utf-8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("ignores prefixed dream report paths when recording short-term recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "prefixed dream recall",
        results: [
          {
            path: "../../vault/memory/dreaming/deep/2026-04-03.md",
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "External dream report should not seed promotions.",
          },
        ],
      });

      await expect(
        fs.readFile(resolveShortTermRecallStorePath(workspaceDir), "utf-8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("ignores contaminated dreaming snippets when recording short-term recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "action preference",
        results: [
          {
            path: "memory/2026-04-03.md",
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.92,
            snippet:
              "Candidate: Default to action. confidence: 0.76 evidence: memory/.dreams/session-corpus/2026-04-08.txt:1-1 recalls: 3 status: staged",
          },
        ],
      });

      expect(
        JSON.parse(await fs.readFile(resolveShortTermRecallStorePath(workspaceDir), "utf-8")),
      ).toMatchObject({
        version: 1,
        entries: {},
      });
    });
  });

  it("ignores bullet-prefixed dreaming snippets when recording short-term recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "action preference",
        results: [
          {
            path: "memory/2026-04-03.md",
            source: "memory",
            startLine: 1,
            endLine: 5,
            score: 0.92,
            snippet: [
              "- Candidate: Default to action.",
              "  - confidence: 0.76",
              "  - evidence: memory/.dreams/session-corpus/2026-04-08.txt:1-1",
              "  - recalls: 3",
              "  - status: staged",
            ].join("\n"),
          },
        ],
      });

      expect(
        JSON.parse(await fs.readFile(resolveShortTermRecallStorePath(workspaceDir), "utf-8")),
      ).toMatchObject({
        version: 1,
        entries: {},
      });
    });
  });

  it("keeps ordinary snippets that only quote dreaming prompt markers", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "debug note",
        results: [
          {
            path: "memory/2026-04-03.md",
            source: "memory",
            startLine: 1,
            endLine: 1,
            score: 0.75,
            snippet:
              "Debug note: quote Write a dream diary entry from these memory fragments for docs, but do not use dreaming-narrative-like labels in production.",
          },
        ],
      });

      const store = JSON.parse(
        await fs.readFile(resolveShortTermRecallStorePath(workspaceDir), "utf-8"),
      ) as { entries: Record<string, { snippet: string }> };
      expect(Object.values(store.entries)).toEqual([
        expect.objectContaining({
          snippet:
            "Debug note: quote Write a dream diary entry from these memory fragments for docs, but do not use dreaming-narrative-like labels in production.",
        }),
      ]);
    });
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
      expect(ranked[0]?.components.conceptual).toBeGreaterThan(0);

      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const raw = await fs.readFile(storePath, "utf-8");
      expect(raw).toContain("memory/2026-04-02.md");
      expect(raw).not.toContain("Long-term note");
    });
  });

  it("serializes concurrent recall writes so counts are not lost", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
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
      expect(ranked[0]?.recallCount).toBe(8);
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

  it("lets repeated dreaming-only daily signals clear the default promotion gates", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const queryDays = ["2026-04-01", "2026-04-02", "2026-04-03"];
      let candidateKey = "";

      for (const [index, day] of queryDays.entries()) {
        const nowMs = Date.parse(`${day}T10:00:00.000Z`);
        await recordShortTermRecalls({
          workspaceDir,
          query: `__dreaming_daily__:${day}`,
          signalType: "daily",
          dedupeByQueryPerDay: true,
          dayBucket: day,
          nowMs,
          results: [
            {
              path: "memory/2026-04-01.md",
              startLine: 1,
              endLine: 2,
              score: 0.62,
              snippet: "Move backups to S3 Glacier.",
              source: "memory",
            },
          ],
        });

        const ranked = await rankShortTermPromotionCandidates({
          workspaceDir,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
          nowMs,
        });
        candidateKey = ranked[0]?.key ?? candidateKey;
        expect(candidateKey).toBeTruthy();

        await recordDreamingPhaseSignals({
          workspaceDir,
          phase: "light",
          keys: [candidateKey],
          nowMs,
        });
        await recordDreamingPhaseSignals({
          workspaceDir,
          phase: "rem",
          keys: [candidateKey],
          nowMs: nowMs + 60_000,
        });

        if (index < 2) {
          const beforeThreshold = await rankShortTermPromotionCandidates({
            workspaceDir,
            nowMs,
          });
          expect(beforeThreshold).toHaveLength(0);
        }
      }

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        nowMs: Date.parse("2026-04-03T10:01:00.000Z"),
      });

      expect(ranked).toHaveLength(1);
      expect(ranked[0]).toMatchObject({
        recallCount: 0,
        dailyCount: 3,
        uniqueQueries: 3,
      });
      expect(ranked[0]?.recallDays).toEqual(queryDays);
      expect(ranked[0]?.score).toBeGreaterThanOrEqual(0.75);
    });
  });

  it("lets grounded durable evidence satisfy default deep thresholds", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
        'Always use "Happy Together" calendar for flights and reservations.',
      ]);

      const stagedEntryCount = await recordGroundedShortTermCandidates({
        workspaceDir,
        query: "__dreaming_grounded_backfill__",
        items: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            snippet: 'Always use "Happy Together" calendar for flights and reservations.',
            score: 0.92,
            query: "__dreaming_grounded_backfill__:lasting-update",
            signalCount: 2,
            dayBucket: "2026-04-03",
          },
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            snippet: 'Always use "Happy Together" calendar for flights and reservations.',
            score: 0.82,
            query: "__dreaming_grounded_backfill__:candidate",
            signalCount: 1,
            dayBucket: "2026-04-03",
          },
        ],
        dedupeByQueryPerDay: true,
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });
      expect(stagedEntryCount).toBe(1);

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.groundedCount).toBe(3);
      expect(ranked[0]?.uniqueQueries).toBe(2);
      expect(ranked[0]?.avgScore).toBeGreaterThan(0.85);

      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      expect(applied.applied).toBe(1);
      const memory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memory).toContain('Always use "Happy Together" calendar');
    });
  });

  it("does not merge grounded seeds into stale bookkeeping entries that share the same claim hash", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const snippet = 'Always use "Happy Together" calendar for flights and reservations.';
      const claimHash = __testing.buildClaimHash(snippet);
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [snippet]);
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-04-03-session-reset.md"),
        [
          "# Session: 2026-04-03 19:30:00 America/Chicago",
          "",
          SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
          "",
          "- **Session Key**: agent:main:main",
          "- **Session ID**: reset-123",
          "- **Source**: cli",
          "",
          "## Conversation Summary",
          "",
          `assistant: ${snippet}`,
        ].join("\n") + "\n",
        "utf-8",
      );

      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              bookkeeping: {
                key: "bookkeeping",
                path: "memory/2026-04-03-session-reset.md",
                startLine: 9,
                endLine: 9,
                source: "memory",
                snippet,
                recallCount: 4,
                dailyCount: 2,
                groundedCount: 0,
                totalScore: 3.2,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["summary-q"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
                claimHash,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await expect(
        recordGroundedShortTermCandidates({
          workspaceDir,
          query: "__dreaming_grounded_backfill__",
          items: [
            {
              path: "memory/2026-04-03.md",
              startLine: 1,
              endLine: 1,
              snippet,
              score: 0.82,
              query: "__dreaming_grounded_backfill__:candidate",
              signalCount: 1,
              dayBucket: "2026-04-03",
            },
          ],
          dedupeByQueryPerDay: true,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        }),
      ).resolves.toBe(1);

      const entries = await readShortTermRecallEntries({
        workspaceDir,
        nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
      });

      expect(entries).toEqual([
        expect.objectContaining({
          path: "memory/2026-04-03.md",
          recallCount: 0,
          dailyCount: 0,
          groundedCount: 1,
          totalScore: 0.82,
          maxScore: 0.82,
        }),
      ]);
      expect(entries[0]?.queryHashes).not.toContain("summary-q");
    });
  });

  it("keeps grounded same-day durable slugged notes separate before ranking promotions", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
        'Always use "Happy Together" calendar for flights and reservations.',
      ]);
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-04-03-reset-summary.md"),
        'Always use "Happy Together" calendar for flights and reservations.\n',
        "utf-8",
      );

      await recordGroundedShortTermCandidates({
        workspaceDir,
        query: "__dreaming_grounded_backfill__",
        items: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            snippet: 'Always use "Happy Together" calendar for flights and reservations.',
            score: 0.92,
            query: "__dreaming_grounded_backfill__:lasting-update",
            signalCount: 2,
            dayBucket: "2026-04-03",
          },
          {
            path: "memory/2026-04-03-reset-summary.md",
            startLine: 1,
            endLine: 1,
            snippet: 'Always use "Happy Together" calendar for flights and reservations.',
            score: 0.92,
            query: "__dreaming_grounded_backfill__:lasting-update",
            signalCount: 2,
            dayBucket: "2026-04-03",
          },
          {
            path: "memory/2026-04-03-reset-summary.md",
            startLine: 1,
            endLine: 1,
            snippet: 'Always use "Happy Together" calendar for flights and reservations.',
            score: 0.82,
            query: "__dreaming_grounded_backfill__:candidate",
            signalCount: 1,
            dayBucket: "2026-04-03",
          },
        ],
        dedupeByQueryPerDay: true,
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        includePromoted: true,
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      expect(ranked).toHaveLength(2);
      expect(ranked.map((entry) => entry.path).toSorted()).toEqual([
        "memory/2026-04-03-reset-summary.md",
        "memory/2026-04-03.md",
      ]);
      expect(ranked.find((entry) => entry.path === "memory/2026-04-03.md")).toMatchObject({
        groundedCount: 2,
        uniqueQueries: 1,
      });
      expect(
        ranked.find((entry) => entry.path === "memory/2026-04-03-reset-summary.md"),
      ).toMatchObject({
        groundedCount: 3,
        uniqueQueries: 2,
      });

      await recordShortTermRecalls({
        workspaceDir,
        query: "calendar recall",
        results: [
          {
            path: "memory/2026-04-03-reset-summary.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: 'Always use "Happy Together" calendar for flights and reservations.',
            source: "memory",
          },
        ],
        nowMs: Date.parse("2026-04-03T10:02:00.000Z"),
      });

      const rankedAfterRecall = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        includePromoted: true,
        nowMs: Date.parse("2026-04-03T10:03:00.000Z"),
      });

      expect(rankedAfterRecall).toHaveLength(2);
      expect(
        rankedAfterRecall.find((entry) => entry.path === "memory/2026-04-03.md"),
      ).toMatchObject({
        groundedCount: 2,
        recallCount: 0,
      });
      expect(
        rankedAfterRecall.find((entry) => entry.path === "memory/2026-04-03-reset-summary.md"),
      ).toMatchObject({
        groundedCount: 3,
        recallCount: 1,
      });
    });
  });

  it("keeps canonical and slugged same-day durable notes separate after later canonical recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const snippet = 'Always use "Happy Together" calendar for flights and reservations.';
      const sluggedRelativePath = "memory/2026-04-03-reset-summary.md";
      const sluggedPath = path.join(workspaceDir, sluggedRelativePath);
      await fs.writeFile(sluggedPath, `${snippet}\n`, "utf-8");

      await recordShortTermRecalls({
        workspaceDir,
        query: "calendar recall",
        results: [
          {
            path: sluggedRelativePath,
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet,
            source: "memory",
          },
        ],
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [snippet]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "calendar canonical recall",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            score: 0.88,
            snippet,
            source: "memory",
          },
        ],
        nowMs: Date.parse("2026-04-03T10:01:00.000Z"),
      });
      await recordShortTermRecalls({
        workspaceDir,
        query: "calendar canonical follow-up",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            score: 0.87,
            snippet,
            source: "memory",
          },
        ],
        nowMs: Date.parse("2026-04-03T10:02:00.000Z"),
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        includePromoted: true,
        nowMs: Date.parse("2026-04-03T10:03:00.000Z"),
      });

      expect(ranked).toHaveLength(2);
      expect(ranked.find((entry) => entry.path === "memory/2026-04-03.md")).toMatchObject({
        recallCount: 2,
      });
      expect(
        ranked.find((entry) => entry.path === "memory/2026-04-03-reset-summary.md"),
      ).toMatchObject({
        recallCount: 1,
      });
      const entries = await readShortTermRecallEntries({
        workspaceDir,
        nowMs: Date.parse("2026-04-03T10:03:00.000Z"),
      });
      expect(entries.map((entry) => entry.path).toSorted()).toEqual([
        "memory/2026-04-03-reset-summary.md",
        "memory/2026-04-03.md",
      ]);

      await fs.rm(sluggedPath);

      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked.filter((entry) => entry.path === "memory/2026-04-03.md"),
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-03T10:04:00.000Z"),
      });

      expect(applied.applied).toBe(1);
      expect(applied.appliedCandidates[0]?.path).toBe("memory/2026-04-03.md");
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).toContain("source=memory/2026-04-03.md:1-1");
    });
  });

  it("records same-day durable slugged search results as separate recall events", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const snippet = 'Always use "Happy Together" calendar for flights and reservations.';

      await recordShortTermRecalls({
        workspaceDir,
        query: "calendar recall",
        results: [
          {
            path: "memory/2026-04-03-reset-summary.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet,
            source: "memory",
          },
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            score: 0.88,
            snippet,
            source: "memory",
          },
        ],
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      const entries = await readShortTermRecallEntries({
        workspaceDir,
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      expect(entries.map((entry) => entry.path).toSorted()).toEqual([
        "memory/2026-04-03-reset-summary.md",
        "memory/2026-04-03.md",
      ]);
      expect(entries.find((entry) => entry.path === "memory/2026-04-03.md")).toMatchObject({
        recallCount: 1,
        totalScore: 0.88,
        maxScore: 0.88,
      });
      expect(
        entries.find((entry) => entry.path === "memory/2026-04-03-reset-summary.md"),
      ).toMatchObject({
        recallCount: 1,
        totalScore: 0.9,
        maxScore: 0.9,
      });
    });
  });

  it("keeps each same-day durable note's own score when a lower-scored slugged variant arrives first", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const snippet = 'Always use "Happy Together" calendar for flights and reservations.';

      await recordShortTermRecalls({
        workspaceDir,
        query: "calendar recall",
        results: [
          {
            path: "memory/2026-04-03-reset-summary.md",
            startLine: 1,
            endLine: 1,
            score: 0.88,
            snippet,
            source: "memory",
          },
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet,
            source: "memory",
          },
        ],
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      const entries = await readShortTermRecallEntries({
        workspaceDir,
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      expect(entries.map((entry) => entry.path).toSorted()).toEqual([
        "memory/2026-04-03-reset-summary.md",
        "memory/2026-04-03.md",
      ]);
      expect(entries.find((entry) => entry.path === "memory/2026-04-03.md")).toMatchObject({
        recallCount: 1,
        totalScore: 0.9,
        maxScore: 0.9,
      });
      expect(
        entries.find((entry) => entry.path === "memory/2026-04-03-reset-summary.md"),
      ).toMatchObject({
        recallCount: 1,
        totalScore: 0.88,
        maxScore: 0.88,
      });
    });
  });

  it("does not merge independent same-day dated-slug notes that share a sentence", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const snippet = "Shared reminder across separate same-day notes.";

      await recordShortTermRecalls({
        workspaceDir,
        query: "shared reminder",
        results: [
          {
            path: "memory/2026-04-03-workshop.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet,
            source: "memory",
          },
          {
            path: "memory/2026-04-03-travel.md",
            startLine: 1,
            endLine: 1,
            score: 0.88,
            snippet,
            source: "memory",
          },
        ],
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      const entries = (
        await readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
        })
      ).toSorted((left, right) => left.path.localeCompare(right.path));

      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.path)).toEqual([
        "memory/2026-04-03-travel.md",
        "memory/2026-04-03-workshop.md",
      ]);
    });
  });

  it("does not merge canonical notes with independent same-day topic notes that share a sentence", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const snippet = "Shared reminder across separate same-day notes.";

      await recordShortTermRecalls({
        workspaceDir,
        query: "shared reminder",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet,
            source: "memory",
          },
          {
            path: "memory/2026-04-03-workshop.md",
            startLine: 1,
            endLine: 1,
            score: 0.88,
            snippet,
            source: "memory",
          },
        ],
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      const entries = (
        await readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
        })
      ).toSorted((left, right) => left.path.localeCompare(right.path));

      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.path)).toEqual([
        "memory/2026-04-03-workshop.md",
        "memory/2026-04-03.md",
      ]);
    });
  });

  it("keeps grounded same-day durable notes separate even when line refs shift between files", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const snippet = 'Always use "Happy Together" calendar for flights and reservations.';
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", ["Heading", "Context", snippet]);
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-04-03-reset-summary.md"),
        ["Session heading", "Context", "Other", snippet].join("\n") + "\n",
        "utf-8",
      );

      await recordGroundedShortTermCandidates({
        workspaceDir,
        query: "__dreaming_grounded_backfill__",
        items: [
          {
            path: "memory/2026-04-03-reset-summary.md",
            startLine: 4,
            endLine: 4,
            snippet,
            score: 0.92,
            query: "__dreaming_grounded_backfill__:lasting-update",
            signalCount: 2,
            dayBucket: "2026-04-03",
          },
          {
            path: "memory/2026-04-03.md",
            startLine: 3,
            endLine: 3,
            snippet,
            score: 0.92,
            query: "__dreaming_grounded_backfill__:lasting-update",
            signalCount: 2,
            dayBucket: "2026-04-03",
          },
        ],
        dedupeByQueryPerDay: false,
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      const entries = await readShortTermRecallEntries({
        workspaceDir,
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });

      expect(entries.map((entry) => entry.path).toSorted()).toEqual([
        "memory/2026-04-03-reset-summary.md",
        "memory/2026-04-03.md",
      ]);
      expect(entries.find((entry) => entry.path === "memory/2026-04-03.md")).toMatchObject({
        startLine: 3,
        endLine: 3,
        groundedCount: 2,
        snippet,
      });
      expect(
        entries.find((entry) => entry.path === "memory/2026-04-03-reset-summary.md"),
      ).toMatchObject({
        startLine: 4,
        endLine: 4,
        groundedCount: 2,
        snippet,
      });
    });
  });

  it("does not fall back to the canonical same-day entry for unrelated slugged notes", () => {
    const claimHash = __testing.buildClaimHash("same snippet");
    const matchedKey = __testing.findExistingDailyVariantEntryKey({
      entries: {
        first: {
          key: "first",
          path: "memory/2026-04-03.md",
          startLine: 3,
          endLine: 3,
          source: "memory",
          snippet: "same snippet",
          recallCount: 1,
          dailyCount: 0,
          groundedCount: 0,
          totalScore: 0.9,
          maxScore: 0.9,
          firstRecalledAt: "2026-04-03T10:00:00.000Z",
          lastRecalledAt: "2026-04-03T10:00:00.000Z",
          queryHashes: ["a"],
          recallDays: ["2026-04-03"],
          conceptTags: [],
          claimHash,
        },
        second: {
          key: "second",
          path: "memory/2026-04-03-reset-summary.md",
          startLine: 19,
          endLine: 19,
          source: "memory",
          snippet: "same snippet",
          recallCount: 1,
          dailyCount: 0,
          groundedCount: 0,
          totalScore: 0.8,
          maxScore: 0.8,
          firstRecalledAt: "2026-04-03T10:01:00.000Z",
          lastRecalledAt: "2026-04-03T10:01:00.000Z",
          queryHashes: ["b"],
          recallDays: ["2026-04-03"],
          conceptTags: [],
          claimHash,
        },
      },
      claimHash,
      candidatePath: "memory/2026-04-03-other-reset.md",
      candidateStartLine: 20,
      candidateEndLine: 20,
    });

    expect(matchedKey).toBeNull();
  });

  it("does not merge repeated same-day snippets from different line ranges in the same file", () => {
    const claimHash = __testing.buildClaimHash("same snippet");
    const matchedKey = __testing.findExistingDailyVariantEntryKey({
      entries: {
        first: {
          key: "first",
          path: "memory/2026-04-03.md",
          startLine: 3,
          endLine: 3,
          source: "memory",
          snippet: "same snippet",
          recallCount: 1,
          dailyCount: 0,
          groundedCount: 0,
          totalScore: 0.9,
          maxScore: 0.9,
          firstRecalledAt: "2026-04-03T10:00:00.000Z",
          lastRecalledAt: "2026-04-03T10:00:00.000Z",
          queryHashes: ["a"],
          recallDays: ["2026-04-03"],
          conceptTags: [],
          claimHash,
        },
      },
      claimHash,
      candidatePath: "memory/2026-04-03.md",
      candidateStartLine: 20,
      candidateEndLine: 20,
    });

    expect(matchedKey).toBeNull();
  });

  it("does not merge legacy absolute-path summary-style slugs with local canonical notes", () => {
    const claimHash = __testing.buildClaimHash("same snippet");
    const matchedKey = __testing.findExistingDailyVariantEntryKey({
      entries: {
        foreign: {
          key: "foreign",
          path: "/tmp/other-workspace/memory/2026-04-03.md",
          startLine: 3,
          endLine: 3,
          source: "memory",
          snippet: "same snippet",
          recallCount: 1,
          dailyCount: 0,
          groundedCount: 0,
          totalScore: 0.9,
          maxScore: 0.9,
          firstRecalledAt: "2026-04-03T10:00:00.000Z",
          lastRecalledAt: "2026-04-03T10:00:00.000Z",
          queryHashes: ["a"],
          recallDays: ["2026-04-03"],
          conceptTags: [],
          claimHash,
        },
        local: {
          key: "local",
          path: "/tmp/current-workspace/memory/2026-04-03.md",
          startLine: 4,
          endLine: 4,
          source: "memory",
          snippet: "same snippet",
          recallCount: 1,
          dailyCount: 0,
          groundedCount: 0,
          totalScore: 0.95,
          maxScore: 0.95,
          firstRecalledAt: "2026-04-03T10:01:00.000Z",
          lastRecalledAt: "2026-04-03T10:01:00.000Z",
          queryHashes: ["b"],
          recallDays: ["2026-04-03"],
          conceptTags: [],
          claimHash,
        },
      },
      workspaceDir: "/tmp/current-workspace",
      claimHash,
      candidatePath: "memory/2026-04-03-reset-summary.md",
      candidateStartLine: 4,
      candidateEndLine: 4,
    });

    expect(matchedKey).toBeNull();
  });

  it("does not merge migrated Windows absolute-path summary-style slugs with local canonical notes", () => {
    const claimHash = __testing.buildClaimHash("same snippet");
    const matchedKey = __testing.findExistingDailyVariantEntryKey({
      entries: {
        foreign: {
          key: "foreign",
          path: "C:/other-workspace/memory/2026-04-03.md",
          startLine: 3,
          endLine: 3,
          source: "memory",
          snippet: "same snippet",
          recallCount: 1,
          dailyCount: 0,
          groundedCount: 0,
          totalScore: 0.9,
          maxScore: 0.9,
          firstRecalledAt: "2026-04-03T10:00:00.000Z",
          lastRecalledAt: "2026-04-03T10:00:00.000Z",
          queryHashes: ["a"],
          recallDays: ["2026-04-03"],
          conceptTags: [],
          claimHash,
        },
        local: {
          key: "local",
          path: "/tmp/current-workspace/memory/2026-04-03.md",
          startLine: 4,
          endLine: 4,
          source: "memory",
          snippet: "same snippet",
          recallCount: 1,
          dailyCount: 0,
          groundedCount: 0,
          totalScore: 0.95,
          maxScore: 0.95,
          firstRecalledAt: "2026-04-03T10:01:00.000Z",
          lastRecalledAt: "2026-04-03T10:01:00.000Z",
          queryHashes: ["b"],
          recallDays: ["2026-04-03"],
          conceptTags: [],
          claimHash,
        },
      },
      workspaceDir: "/tmp/current-workspace",
      claimHash,
      candidatePath: "memory/2026-04-03-reset-summary.md",
      candidateStartLine: 4,
      candidateEndLine: 4,
    });

    expect(matchedKey).toBeNull();
  });

  it("does not merge same-workspace Windows summary-style slugs with canonical durable notes", () => {
    const claimHash = __testing.buildClaimHash("same snippet");
    const resolveSpy = vi
      .spyOn(path, "resolve")
      .mockImplementation(((...segments: string[]) =>
        path.win32.resolve(...segments)) as typeof path.resolve);

    try {
      const matchedKey = __testing.findExistingDailyVariantEntryKey({
        entries: {
          same: {
            key: "same",
            path: "c:/repo/memory/2026-04-03.md",
            startLine: 3,
            endLine: 3,
            source: "memory",
            snippet: "same snippet",
            recallCount: 1,
            dailyCount: 0,
            groundedCount: 0,
            totalScore: 0.9,
            maxScore: 0.9,
            firstRecalledAt: "2026-04-03T10:00:00.000Z",
            lastRecalledAt: "2026-04-03T10:00:00.000Z",
            queryHashes: ["a"],
            recallDays: ["2026-04-03"],
            conceptTags: [],
            claimHash,
          },
        },
        workspaceDir: "C:/repo",
        claimHash,
        candidatePath: "memory/2026-04-03-reset-summary.md",
        candidateStartLine: 4,
        candidateEndLine: 4,
      });

      expect(matchedKey).toBeNull();
    } finally {
      resolveSpy.mockRestore();
    }
  });

  it("treats Windows workspace path segments case-insensitively for legacy exact matches", () => {
    const claimHash = __testing.buildClaimHash("same snippet");
    const resolveSpy = vi
      .spyOn(path, "resolve")
      .mockImplementation(((...segments: string[]) =>
        path.win32.resolve(...segments)) as typeof path.resolve);

    try {
      const matchedKey = __testing.findExistingDailyVariantEntryKey({
        entries: {
          same: {
            key: "same",
            path: "C:/Repo/memory/2026-04-03.md",
            startLine: 3,
            endLine: 3,
            source: "memory",
            snippet: "same snippet",
            recallCount: 1,
            dailyCount: 0,
            groundedCount: 0,
            totalScore: 0.9,
            maxScore: 0.9,
            firstRecalledAt: "2026-04-03T10:00:00.000Z",
            lastRecalledAt: "2026-04-03T10:00:00.000Z",
            queryHashes: ["a"],
            recallDays: ["2026-04-03"],
            conceptTags: [],
            claimHash,
          },
        },
        workspaceDir: "C:/repo",
        claimHash,
        candidatePath: "memory/2026-04-03.md",
        candidateStartLine: 3,
        candidateEndLine: 3,
      });

      expect(matchedKey).toBe("same");
    } finally {
      resolveSpy.mockRestore();
    }
  });

  it("does not probe local source aliases for migrated Windows absolute paths", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-04-03-foo.md"),
        "local alias should not be probed\n",
        "utf-8",
      );

      await expect(
        __testing.resolveShortTermSourcePathCandidates(
          workspaceDir,
          "C:/old/memory/2026-04-03-foo.md",
        ),
      ).resolves.toEqual([]);
      expect(
        __testing.resolveShortTermSourcePathCandidatesLegacy(
          workspaceDir,
          "C:/old/memory/2026-04-03-foo.md",
        ),
      ).toEqual([]);
    });
  });

  it("ignores identical same-day snippets across different memory subdirectories", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNoteInSubdir(workspaceDir, "daily", "2026-04-03", ["same snippet"]);
      await writeDailyMemoryNoteInSubdir(workspaceDir, "travel", "2026-04-03", ["same snippet"]);

      await recordShortTermRecalls({
        workspaceDir,
        query: "q1",
        results: [
          {
            path: "memory/daily/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "same snippet",
            source: "memory",
          },
        ],
      });
      await recordShortTermRecalls({
        workspaceDir,
        query: "q2",
        results: [
          {
            path: "memory/travel/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            score: 0.8,
            snippet: "same snippet",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        includePromoted: true,
      });

      expect(ranked).toEqual([]);
    });
  });

  it("removes grounded-only staged entries without deleting mixed live entries", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
        "Grounded only rule.",
        "Live recall-backed rule.",
      ]);

      await recordGroundedShortTermCandidates({
        workspaceDir,
        query: "__dreaming_grounded_backfill__",
        items: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            snippet: "Grounded only rule.",
            score: 0.92,
            query: "__dreaming_grounded_backfill__:lasting-update",
            signalCount: 2,
            dayBucket: "2026-04-03",
          },
          {
            path: "memory/2026-04-03.md",
            startLine: 2,
            endLine: 2,
            snippet: "Live recall-backed rule.",
            score: 0.92,
            query: "__dreaming_grounded_backfill__:lasting-update",
            signalCount: 2,
            dayBucket: "2026-04-03",
          },
        ],
        dedupeByQueryPerDay: true,
      });
      await recordShortTermRecalls({
        workspaceDir,
        query: "live recall",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 2,
            endLine: 2,
            score: 0.87,
            snippet: "Live recall-backed rule.",
            source: "memory",
          },
        ],
      });

      const result = await removeGroundedShortTermCandidates({ workspaceDir });
      expect(result.removed).toBe(1);

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.snippet).toContain("Live recall-backed rule");
      expect(ranked[0]?.groundedCount).toBe(2);
      expect(ranked[0]?.recallCount).toBe(1);
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

  it("lets recency half-life tune the temporal score", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "glacier retention",
        nowMs: Date.parse("2026-04-01T10:00:00.000Z"),
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 2,
            score: 0.92,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
          },
        ],
      });

      const slowerDecay = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-15T10:00:00.000Z"),
        recencyHalfLifeDays: 14,
      });
      const fasterDecay = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-15T10:00:00.000Z"),
        recencyHalfLifeDays: 7,
      });

      expect(slowerDecay).toHaveLength(1);
      expect(fasterDecay).toHaveLength(1);
      expect(slowerDecay[0]?.components.recency).toBeCloseTo(0.5, 3);
      expect(fasterDecay[0]?.components.recency).toBeCloseTo(0.25, 3);
      expect(slowerDecay[0].score).toBeGreaterThan(fasterDecay[0].score);
    });
  });

  it("boosts deep ranking when light/rem phase signals reinforce a candidate", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const nowMs = Date.parse("2026-04-05T10:00:00.000Z");
      await recordShortTermRecalls({
        workspaceDir,
        query: "router setup",
        nowMs,
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.75,
            snippet: "Router VLAN baseline noted.",
            source: "memory",
          },
          {
            path: "memory/2026-04-02.md",
            startLine: 1,
            endLine: 1,
            score: 0.75,
            snippet: "Backup policy for router snapshots.",
            source: "memory",
          },
        ],
      });
      await recordShortTermRecalls({
        workspaceDir,
        query: "router backup",
        nowMs,
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.75,
            snippet: "Router VLAN baseline noted.",
            source: "memory",
          },
          {
            path: "memory/2026-04-02.md",
            startLine: 1,
            endLine: 1,
            score: 0.75,
            snippet: "Backup policy for router snapshots.",
            source: "memory",
          },
        ],
      });

      const baseline = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs,
      });
      expect(baseline).toHaveLength(2);
      expect(baseline[0]?.path).toBe("memory/2026-04-01.md");

      const boostedKey = baseline.find((entry) => entry.path === "memory/2026-04-02.md")?.key;
      expect(boostedKey).toBeTruthy();
      await recordDreamingPhaseSignals({
        workspaceDir,
        phase: "light",
        keys: [boostedKey!],
        nowMs,
      });
      await recordDreamingPhaseSignals({
        workspaceDir,
        phase: "rem",
        keys: [boostedKey!],
        nowMs,
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs,
      });
      expect(ranked[0]?.path).toBe("memory/2026-04-02.md");
      expect(ranked[0].score).toBeGreaterThan(ranked[1].score);

      const phaseStorePath = resolveShortTermPhaseSignalStorePath(workspaceDir);
      const phaseStore = JSON.parse(await fs.readFile(phaseStorePath, "utf-8")) as {
        entries: Record<string, { lightHits: number; remHits: number }>;
      };
      expect(phaseStore.entries[boostedKey!]).toMatchObject({
        lightHits: 1,
        remHits: 1,
      });
    });
  });

  it("weights fresh phase signals more than stale ones", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "glacier cadence",
        nowMs: Date.parse("2026-04-01T10:00:00.000Z"),
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
          },
        ],
      });
      await recordShortTermRecalls({
        workspaceDir,
        query: "backup lifecycle",
        nowMs: Date.parse("2026-04-01T12:00:00.000Z"),
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
          },
        ],
      });

      const rankedBaseline = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
      });
      const key = rankedBaseline[0]?.key;
      expect(key).toBeTruthy();

      await recordDreamingPhaseSignals({
        workspaceDir,
        phase: "rem",
        keys: [key],
        nowMs: Date.parse("2026-02-01T10:00:00.000Z"),
      });
      const staleSignalRank = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
      });
      await recordDreamingPhaseSignals({
        workspaceDir,
        phase: "rem",
        keys: [key],
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
      });
      const freshSignalRank = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
      });

      expect(staleSignalRank).toHaveLength(1);
      expect(freshSignalRank).toHaveLength(1);
      expect(freshSignalRank[0].score).toBeGreaterThan(staleSignalRank[0].score);
    });
  });

  it("reconciles existing promotion markers instead of appending duplicates", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "line 1",
        "line 2",
        "The gateway should stay loopback-only on port 18789.",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "gateway loopback",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 3,
            endLine: 3,
            score: 0.95,
            snippet: "The gateway should stay loopback-only on port 18789.",
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
      const firstApply = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(firstApply.applied).toBe(1);
      expect(firstApply.appended).toBe(1);
      expect(firstApply.reconciledExisting).toBe(0);

      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const rawStore = JSON.parse(await fs.readFile(storePath, "utf-8")) as {
        entries: Record<string, { promotedAt?: string }>;
      };
      for (const entry of Object.values(rawStore.entries)) {
        delete entry.promotedAt;
      }
      await fs.writeFile(storePath, `${JSON.stringify(rawStore, null, 2)}\n`, "utf-8");

      const secondApply = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });
      expect(secondApply.applied).toBe(1);
      expect(secondApply.appended).toBe(0);
      expect(secondApply.reconciledExisting).toBe(1);

      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText.match(/openclaw-memory-promotion:/g)?.length).toBe(1);
      expect(
        memoryText.match(/The gateway should stay loopback-only on port 18789\./g)?.length,
      ).toBe(1);
    });
  });

  it("filters out candidates older than maxAgeDays during ranking", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "old note",
        nowMs: Date.parse("2026-04-01T10:00:00.000Z"),
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 2,
            score: 0.92,
            snippet: "Move backups to S3 Glacier.",
            source: "memory",
          },
        ],
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-15T10:00:00.000Z"),
        maxAgeDays: 7,
      });

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
            recallDays: [new Date().toISOString().slice(0, 10)],
            conceptTags: ["glacier", "backups"],
            components: {
              frequency: 0.2,
              relevance: 0.95,
              diversity: 0.2,
              recency: 1,
              consolidation: 0.2,
              conceptual: 0.4,
            },
          },
        ],
      });

      expect(applied.applied).toBe(0);
    });
  });

  it("does not rank contaminated dreaming snippets from an existing short-term store", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              contaminated: {
                key: "contaminated",
                path: "memory/2026-04-03.md",
                startLine: 1,
                endLine: 1,
                source: "memory",
                snippet:
                  "Reflections: Theme: assistant. confidence: 1.00 evidence: memory/.dreams/session-corpus/2026-04-08.txt:2-2 recalls: 4 status: staged",
                recallCount: 4,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 3.6,
                maxScore: 0.95,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["a", "b"],
                recallDays: ["2026-04-03", "2026-04-04"],
                conceptTags: ["assistant"],
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });

      expect(ranked).toEqual([]);
    });
  });

  it("treats diff-prefixed dreaming snippets as contaminated", () => {
    expect(
      __testing.isContaminatedDreamingSnippet(
        "@@ -1,1 - Candidate: Default to action. confidence: 0.76 evidence: memory/.dreams/session-corpus/2026-04-08.txt:1-1 recalls: 3 status: staged",
      ),
    ).toBe(true);
  });

  it("treats bracket-prefixed dreaming snippets as contaminated", () => {
    expect(
      __testing.isContaminatedDreamingSnippet(
        "([ Candidate: Default to action. confidence: 0.76 evidence: memory/.dreams/session-corpus/2026-04-08.txt:1-1 recalls: 3 status: staged",
      ),
    ).toBe(true);
  });

  it("does not treat ordinary candidate notes with daily-memory evidence as contaminated", () => {
    expect(
      __testing.isContaminatedDreamingSnippet(
        "Candidate: move backups weekly. confidence: 0.76 evidence: memory/2026-04-08.md:1-1",
      ),
    ).toBe(false);
  });

  it("treats transcript-style dreaming prompt echoes as contaminated", () => {
    expect(
      __testing.isContaminatedDreamingSnippet(
        "[main/dreaming-narrative-light.jsonl#L1] User: Write a dream diary entry from these memory fragments:",
      ),
    ).toBe(true);
  });

  it("skips direct candidates that exceed maxAgeDays during apply", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const applied = await applyShortTermPromotions({
        workspaceDir,
        maxAgeDays: 7,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        candidates: [
          {
            key: "memory:memory/2026-04-01.md:1:1",
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            source: "memory",
            snippet: "Expired short-term note.",
            recallCount: 3,
            avgScore: 0.95,
            maxScore: 0.95,
            uniqueQueries: 2,
            firstRecalledAt: "2026-04-01T00:00:00.000Z",
            lastRecalledAt: "2026-04-02T00:00:00.000Z",
            ageDays: 10,
            score: 0.95,
            recallDays: ["2026-04-01", "2026-04-02"],
            conceptTags: ["expired"],
            components: {
              frequency: 1,
              relevance: 1,
              diversity: 1,
              recency: 1,
              consolidation: 1,
              conceptual: 1,
            },
          },
        ],
      });

      expect(applied.applied).toBe(0);
      await expect(
        fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("does not append contaminated dreaming snippets during direct apply", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const applied = await applyShortTermPromotions({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        candidates: [
          {
            key: "memory:memory/2026-04-03.md:1:1",
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            source: "memory",
            snippet:
              "Candidate: Default to action. confidence: 0.76 evidence: memory/.dreams/session-corpus/2026-04-08.txt:1-1 recalls: 3 status: staged",
            recallCount: 4,
            avgScore: 0.97,
            maxScore: 0.97,
            uniqueQueries: 2,
            firstRecalledAt: "2026-04-03T00:00:00.000Z",
            lastRecalledAt: "2026-04-04T00:00:00.000Z",
            ageDays: 0,
            score: 0.99,
            recallDays: ["2026-04-03", "2026-04-04"],
            conceptTags: ["assistant"],
            components: {
              frequency: 1,
              relevance: 1,
              diversity: 1,
              recency: 1,
              consolidation: 1,
              conceptual: 1,
            },
          },
        ],
      });

      expect(applied.applied).toBe(0);
      await expect(
        fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("applies promotion candidates to MEMORY.md and marks them promoted", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "alpha",
        "beta",
        "gamma",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta",
        "iota",
        "Gateway binds loopback and port 18789",
        "Keep gateway on localhost only",
        "Document healthcheck endpoint",
      ]);
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
      expect(memoryText).toContain("memory/2026-04-01.md:10-10");

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
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "alpha",
        "beta",
        "gamma",
        "delta",
        "epsilon",
        "zeta",
        "eta",
        "theta",
        "iota",
        "Gateway binds loopback and port 18789",
        "Keep gateway on localhost only",
        "Document healthcheck endpoint",
      ]);
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

  it("rehydrates moved snippets from the live daily note before promotion", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "intro",
        "summary",
        "Moved backups to S3 Glacier.",
        "Keep cold storage retention at 365 days.",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "glacier",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.94,
            snippet: "Moved backups to S3 Glacier.",
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
      expect(applied.appliedCandidates[0]?.startLine).toBe(3);
      expect(applied.appliedCandidates[0]?.endLine).toBe(3);
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).toContain("memory/2026-04-01.md:3-3");
    });
  });

  it("prefers the nearest matching snippet when the same text appears multiple times", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "header",
        "Repeat backup note.",
        "gap",
        "gap",
        "gap",
        "gap",
        "gap",
        "gap",
        "Repeat backup note.",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "backup repeat",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 8,
            endLine: 9,
            score: 0.9,
            snippet: "Repeat backup note.",
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
      expect(applied.appliedCandidates[0]?.startLine).toBe(9);
      expect(applied.appliedCandidates[0]?.endLine).toBe(10);
    });
  });

  it("keeps repeated snippets in one daily file as separate recall entries", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "header",
        "Repeat backup note.",
        "middle",
        "tail",
        "Repeat backup note.",
      ]);

      await recordShortTermRecalls({
        workspaceDir,
        query: "backup repeat",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 2,
            endLine: 2,
            score: 0.9,
            snippet: "Repeat backup note.",
            source: "memory",
          },
          {
            path: "memory/2026-04-01.md",
            startLine: 5,
            endLine: 5,
            score: 0.85,
            snippet: "Repeat backup note.",
            source: "memory",
          },
        ],
      });

      const entries = await readShortTermRecallEntries({ workspaceDir });
      const repeatedEntries = entries
        .filter((entry) => entry.snippet === "Repeat backup note.")
        .toSorted((left, right) => left.startLine - right.startLine);

      expect(repeatedEntries).toHaveLength(2);
      expect(repeatedEntries.map((entry) => [entry.path, entry.startLine, entry.endLine])).toEqual([
        ["memory/2026-04-01.md", 2, 2],
        ["memory/2026-04-01.md", 5, 5],
      ]);
    });
  });

  it("rehydrates legacy basename-only short-term paths from the memory directory", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Legacy basename path note."]);

      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: [
          {
            key: "memory:2026-04-01.md:1:1",
            path: "2026-04-01.md",
            startLine: 1,
            endLine: 1,
            source: "memory",
            snippet: "Legacy basename path note.",
            recallCount: 2,
            avgScore: 0.9,
            maxScore: 0.95,
            uniqueQueries: 2,
            firstRecalledAt: "2026-04-01T00:00:00.000Z",
            lastRecalledAt: "2026-04-02T00:00:00.000Z",
            ageDays: 0,
            score: 0.9,
            recallDays: ["2026-04-01", "2026-04-02"],
            conceptTags: ["legacy", "note"],
            components: {
              frequency: 0.3,
              relevance: 0.9,
              diversity: 0.4,
              recency: 1,
              consolidation: 0.5,
              conceptual: 0.3,
            },
          },
        ],
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
      });

      expect(applied.applied).toBe(1);
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).toContain("source=memory/2026-04-01.md:1-1");
    });
  });

  it("merges legacy basename recall entries with canonical same-day recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const snippet = "Legacy basename path note.";
      const claimHash = __testing.buildClaimHash(snippet);
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [snippet]);

      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            sessionSummaryPurgedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              legacy: {
                key: "legacy",
                path: "2026-04-03.md",
                startLine: 1,
                endLine: 1,
                source: "memory",
                snippet,
                recallCount: 1,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 0.9,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-03T00:00:00.000Z",
                queryHashes: ["legacy-q"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
                claimHash,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await recordShortTermRecalls({
        workspaceDir,
        query: "fresh recall",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            score: 0.8,
            snippet,
            source: "memory",
          },
        ],
        nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
      });

      const entries = await readShortTermRecallEntries({
        workspaceDir,
        nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        path: "memory/2026-04-03.md",
        recallCount: 2,
      });
      expect(entries[0]?.queryHashes).toEqual(
        expect.arrayContaining(["legacy-q", expect.any(String)]),
      );
    });
  });

  it("merges legacy absolute-path recall entries with canonical same-day recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const snippet = "Legacy absolute path note.";
      const claimHash = __testing.buildClaimHash(snippet);
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [snippet]);

      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            sessionSummaryPurgedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              legacy: {
                key: "legacy",
                path: path.join(workspaceDir, "memory", "2026-04-03.md"),
                startLine: 1,
                endLine: 1,
                source: "memory",
                snippet,
                recallCount: 1,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 0.9,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-03T00:00:00.000Z",
                queryHashes: ["legacy-q"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
                claimHash,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await recordShortTermRecalls({
        workspaceDir,
        query: "fresh recall",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            score: 0.8,
            snippet,
            source: "memory",
          },
        ],
        nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
      });

      const entries = await readShortTermRecallEntries({
        workspaceDir,
        nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        path: "memory/2026-04-03.md",
        recallCount: 2,
      });
      expect(entries[0]?.queryHashes).toEqual(
        expect.arrayContaining(["legacy-q", expect.any(String)]),
      );
    });
  });

  it("keeps legacy absolute-path durable recalls visible before any rewrite normalizes them", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const absolutePath = path.join(workspaceDir, "memory", "2026-04-03.md");
      const snippet = "Legacy absolute path note.";
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [snippet]);

      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            sessionSummaryPurgedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              legacy: {
                key: "legacy",
                path: absolutePath,
                startLine: 1,
                endLine: 1,
                source: "memory",
                snippet,
                recallCount: 1,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 0.9,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-03T00:00:00.000Z",
                queryHashes: ["legacy-q"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          path: absolutePath,
          snippet,
          recallCount: 1,
        }),
      ]);

      await expect(
        rankShortTermPromotionCandidates({
          workspaceDir,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          path: absolutePath,
          snippet,
        }),
      ]);
    });
  });

  it("rehydrates missing same-day source paths from surviving sibling daily variants", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-04-01-reset.md"),
        "Sibling variant path note.\n",
        "utf-8",
      );

      await recordShortTermRecalls({
        workspaceDir,
        query: "sibling variant",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "Sibling variant path note.",
            source: "memory",
          },
        ],
        nowMs: Date.parse("2026-04-02T00:00:00.000Z"),
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-03T10:02:00.000Z"),
      });

      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-03T10:03:00.000Z"),
      });

      expect(applied.applied).toBe(1);
      expect(applied.appliedCandidates[0]?.path).toBe("memory/2026-04-01-reset.md");
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).toContain("source=memory/2026-04-01-reset.md:1-1");
      const rankedAfterApply = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        includePromoted: true,
        nowMs: Date.parse("2026-04-03T10:04:00.000Z"),
      });
      expect(rankedAfterApply[0]?.path).toBe("memory/2026-04-01-reset.md");
      expect(rankedAfterApply[0]?.promotedAt).toBeTruthy();
    });
  });

  it("does not rehydrate promotions from same-day bookkeeping siblings", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const snippet = "Durable shared fact here.";
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-04-01-reset.md"),
        [
          "# Session: 2026-04-01 10:00:00 America/New_York",
          "",
          SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
          "",
          "- **Session Key**: agent:main:main",
          "- **Session ID**: reset-123",
          "- **Source**: cli",
          "",
          "## Conversation Summary",
          "",
          `assistant: ${snippet}`,
        ].join("\n") + "\n",
        "utf-8",
      );

      await recordShortTermRecalls({
        workspaceDir,
        query: "shared fact",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet,
            source: "memory",
          },
        ],
        nowMs: Date.parse("2026-04-02T00:00:00.000Z"),
      });

      const ranked = await rankShortTermPromotionCandidates({
        workspaceDir,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-03T10:02:00.000Z"),
      });

      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-03T10:03:00.000Z"),
      });

      expect(applied.applied).toBe(0);
      await expect(fs.access(path.join(workspaceDir, "MEMORY.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("does not rehydrate promotions from same-day variants outside the workspace", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const outsideDir = await fs.mkdtemp(path.join(fixtureRoot, "outside-"));
      const outsideCanonicalPath = path.join(outsideDir, "2026-04-01.md");
      await fs.writeFile(outsideCanonicalPath, "Outside durable snippet.\n", "utf-8");

      try {
        const applied = await applyShortTermPromotions({
          workspaceDir,
          candidates: [
            {
              key: "outside-candidate",
              path: path.join(outsideDir, "2026-04-01-missing.md"),
              startLine: 1,
              endLine: 1,
              source: "memory",
              snippet: "Outside durable snippet.",
              recallCount: 3,
              dailyCount: 0,
              groundedCount: 0,
              signalCount: 3,
              avgScore: 0.9,
              maxScore: 0.9,
              uniqueQueries: 2,
              firstRecalledAt: "2026-04-01T00:00:00.000Z",
              lastRecalledAt: "2026-04-01T00:00:00.000Z",
              ageDays: 0,
              score: 0.9,
              recallDays: ["2026-04-01"],
              conceptTags: [],
              components: {
                frequency: 1,
                relevance: 1,
                diversity: 1,
                recency: 1,
                consolidation: 1,
                conceptual: 1,
              },
            },
          ],
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
          nowMs: Date.parse("2026-04-03T10:03:00.000Z"),
        });

        expect(applied.applied).toBe(0);
        await expect(fs.access(path.join(workspaceDir, "MEMORY.md"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it("does not rehydrate promotions from same-day symlinked variants that resolve outside the workspace", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const outsideDir = await fs.mkdtemp(path.join(fixtureRoot, "outside-symlink-"));
      const outsideCanonicalPath = path.join(outsideDir, "secret.txt");
      const symlinkPath = path.join(workspaceDir, "memory", "2026-04-01.md");
      await fs.writeFile(outsideCanonicalPath, "Outside durable snippet.\n", "utf-8");
      await fs.symlink(outsideCanonicalPath, symlinkPath);

      try {
        const applied = await applyShortTermPromotions({
          workspaceDir,
          candidates: [
            {
              key: "symlinked-candidate",
              path: "memory/2026-04-01-missing.md",
              startLine: 1,
              endLine: 1,
              source: "memory",
              snippet: "Outside durable snippet.",
              recallCount: 3,
              dailyCount: 0,
              groundedCount: 0,
              signalCount: 3,
              avgScore: 0.9,
              maxScore: 0.9,
              uniqueQueries: 2,
              firstRecalledAt: "2026-04-01T00:00:00.000Z",
              lastRecalledAt: "2026-04-01T00:00:00.000Z",
              ageDays: 0,
              score: 0.9,
              recallDays: ["2026-04-01"],
              conceptTags: [],
              components: {
                frequency: 1,
                relevance: 1,
                diversity: 1,
                recency: 1,
                consolidation: 1,
                conceptual: 1,
              },
            },
          ],
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
          nowMs: Date.parse("2026-04-03T10:03:00.000Z"),
        });

        expect(applied.applied).toBe(0);
        await expect(fs.access(path.join(workspaceDir, "MEMORY.md"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it("rehydrates promotions from the originally recorded same-day file before sibling variants", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const exactSnippet =
        "Router maintenance window requires draining the Slack bridge after midnight.";
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-04-01.md"),
        "Router maintenance window\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-04-01-reset.md"),
        `${exactSnippet}\n`,
        "utf-8",
      );

      await recordShortTermRecalls({
        workspaceDir,
        query: "router window",
        results: [
          {
            path: "memory/2026-04-01-reset.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: exactSnippet,
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
      expect(applied.appliedCandidates[0]?.path).toBe("memory/2026-04-01-reset.md");
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).toContain("source=memory/2026-04-01-reset.md:1-1");
    });
  });

  it("skips promotion when the live daily note no longer contains the snippet", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Different note content now."]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "glacier",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.94,
            snippet: "Moved backups to S3 Glacier.",
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

      expect(applied.applied).toBe(0);
      await expect(fs.access(path.join(workspaceDir, "MEMORY.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("uses dreaming timezone for recall-day bucketing and promotion headers", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
        "Cross-midnight router maintenance window.",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "router window",
        nowMs: Date.parse("2026-04-01T23:30:00.000Z"),
        timezone: "America/Los_Angeles",
        results: [
          {
            path: "memory/2026-04-01.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "Cross-midnight router maintenance window.",
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
      expect(ranked[0]?.recallDays).toEqual(["2026-04-01"]);

      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates: ranked,
        minScore: 0,
        minRecallCount: 0,
        minUniqueQueries: 0,
        nowMs: Date.parse("2026-04-02T06:30:00.000Z"),
        timezone: "America/Los_Angeles",
      });

      expect(applied.applied).toBe(1);
      const memoryText = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
      expect(memoryText).toContain("Promoted From Short-Term Memory (2026-04-01)");
    });
  });

  it("audits and repairs invalid store metadata plus stale locks", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
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

  it("repairs empty recall-store files without throwing", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(storePath, "   \n", "utf-8");

      const repair = await repairShortTermPromotionArtifacts({ workspaceDir });

      expect(repair.changed).toBe(true);
      expect(repair.rewroteStore).toBe(true);
      expect(JSON.parse(await fs.readFile(storePath, "utf-8"))).toMatchObject({
        version: 1,
        entries: {},
      });
    });
  });

  it("purges stale session-summary recall entries even after the source file is deleted", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              bookkeeping: {
                key: "bookkeeping",
                path: "memory/2026-04-03-session-reset.md",
                startLine: 9,
                endLine: 9,
                source: "memory",
                snippet: "# Session: 2026-04-03 10:00:00 UTC",
                recallCount: 3,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 2.1,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["summary"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        }),
      ).resolves.toEqual([]);

      const repair = await repairShortTermPromotionArtifacts({ workspaceDir });
      expect(repair.changed).toBe(true);
      expect(repair.rewroteStore).toBe(true);
      await expect(
        fs.readFile(storePath, "utf-8").then((raw) => JSON.parse(raw)),
      ).resolves.toMatchObject({
        entries: {},
        sessionSummaryPurgedAt: expect.any(String),
      });
    });
  });

  it("purges deleted session-summary recall entries for semantic LLM slugs when bookkeeping provenance was remembered", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await rememberRecentDailyMemoryFile({
        memoryDir: path.join(workspaceDir, "memory"),
        fileName: "2026-04-03-vendor-pitch.md",
        sessionSummary: true,
      });
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              bookkeeping: {
                key: "bookkeeping",
                path: "memory/2026-04-03-vendor-pitch.md",
                startLine: 9,
                endLine: 9,
                source: "memory",
                snippet: "assistant: bookkeeping only",
                recallCount: 3,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 2.1,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["summary"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        }),
      ).resolves.toEqual([]);
    });
  });

  it("purges deleted semantic LLM slug recalls when legacy transcript evidence starts in the summary body", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              bookkeeping: {
                key: "bookkeeping",
                path: "memory/2026-04-03-vendor-pitch.md",
                startLine: 9,
                endLine: 9,
                source: "memory",
                snippet: "assistant: bookkeeping only",
                recallCount: 3,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 2.1,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["summary"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        }),
      ).resolves.toEqual([]);
    });
  });

  it("keeps deleted semantic LLM slug recalls without remembered bookkeeping provenance before the summary-body threshold", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              bookkeeping: {
                key: "bookkeeping",
                path: "memory/2026-04-03-vendor-pitch.md",
                startLine: 3,
                endLine: 3,
                source: "memory",
                snippet: "assistant: bookkeeping only",
                recallCount: 3,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 2.1,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["summary"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          path: "memory/2026-04-03-vendor-pitch.md",
          snippet: "assistant: bookkeeping only",
        }),
      ]);
    });
  });

  it("purges deleted canonical session-summary recall entries when bookkeeping provenance was remembered", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await rememberRecentDailyMemoryFile({
        memoryDir: path.join(workspaceDir, "memory"),
        fileName: "2026-04-03.md",
        sessionSummary: true,
      });
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              bookkeeping: {
                key: "bookkeeping",
                path: "memory/2026-04-03.md",
                startLine: 9,
                endLine: 9,
                source: "memory",
                snippet: "assistant: bookkeeping only",
                recallCount: 3,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 2.1,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["summary"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        }),
      ).resolves.toEqual([]);
    });
  });

  it("keeps deleted transcript-like semantic slugs without remembered bookkeeping provenance before the summary-body threshold", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              durable: {
                key: "durable",
                path: "memory/2026-04-03-vendor-pitch.md",
                startLine: 3,
                endLine: 3,
                source: "memory",
                snippet: "assistant: bookkeeping only",
                recallCount: 3,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 2.1,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["summary"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          path: "memory/2026-04-03-vendor-pitch.md",
          snippet: "assistant: bookkeeping only",
        }),
      ]);
    });
  });

  it("persists read-only session-summary cleanup before the filename is reused for a durable note", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              bookkeeping: {
                key: "bookkeeping",
                path: "memory/2026-04-03-session-reset.md",
                startLine: 9,
                endLine: 9,
                source: "memory",
                snippet: "# Session: 2026-04-03 10:00:00 UTC",
                recallCount: 3,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 2.1,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["summary"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        }),
      ).resolves.toEqual([]);
      await expect(
        fs.readFile(storePath, "utf-8").then((raw) => JSON.parse(raw)),
      ).resolves.toMatchObject({
        entries: {},
        sessionSummaryPurgedAt: expect.any(String),
      });

      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-04-03-session-reset.md"),
        "Durable follow-up note.\n",
        "utf-8",
      );

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:01:00.000Z"),
        }),
      ).resolves.toEqual([]);
    });
  });

  it("keeps read-only session-summary cleanup visible when the cleanup writeback cannot persist", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              bookkeeping: {
                key: "bookkeeping",
                path: "memory/2026-04-03-session-reset.md",
                startLine: 9,
                endLine: 9,
                source: "memory",
                snippet: "# Session: 2026-04-03 10:00:00 UTC",
                recallCount: 3,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 2.1,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["summary"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const actualRename: typeof fs.rename = fs.rename.bind(fs);
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation((async (from, to) => {
        if (String(to) === storePath) {
          const error = new Error("no access") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return await actualRename(from as never, to as never);
      }) as typeof fs.rename);

      try {
        await expect(
          readShortTermRecallEntries({
            workspaceDir,
            nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
          }),
        ).resolves.toEqual([]);
      } finally {
        renameSpy.mockRestore();
      }

      await expect(
        fs.readFile(storePath, "utf-8").then((raw) => JSON.parse(raw)),
      ).resolves.toMatchObject({
        entries: {
          bookkeeping: expect.any(Object),
        },
      });
      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:01:00.000Z"),
        }),
      ).resolves.toEqual([]);
    });
  });

  it("keeps read-only session-summary cleanup visible when the cleanup lock cannot be acquired", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              bookkeeping: {
                key: "bookkeeping",
                path: "memory/2026-04-03-session-reset.md",
                startLine: 9,
                endLine: 9,
                source: "memory",
                snippet: "# Session: 2026-04-03 10:00:00 UTC",
                recallCount: 3,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 2.1,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["summary"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const lockPath = resolveShortTermRecallLockPath(workspaceDir);
      const actualOpen: typeof fs.open = fs.open.bind(fs);
      const openSpy = vi.spyOn(fs, "open").mockImplementation((async (target, flags, mode) => {
        if (String(target) === lockPath && flags === "wx") {
          const error = new Error("no access") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return await actualOpen(target as never, flags as never, mode as never);
      }) as typeof fs.open);

      try {
        await expect(
          readShortTermRecallEntries({
            workspaceDir,
            nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
          }),
        ).resolves.toEqual([]);
      } finally {
        openSpy.mockRestore();
      }

      await expect(
        fs.readFile(storePath, "utf-8").then((raw) => JSON.parse(raw)),
      ).resolves.toMatchObject({
        entries: {
          bookkeeping: expect.any(Object),
        },
      });
      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:01:00.000Z"),
        }),
      ).resolves.toEqual([]);
      await expect(
        fs.readFile(storePath, "utf-8").then((raw) => JSON.parse(raw)),
      ).resolves.toMatchObject({
        entries: {},
        sessionSummaryPurgedAt: expect.any(String),
      });
    });
  });

  it("retries read-only session-summary cleanup persistence before the filename is reused", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              bookkeeping: {
                key: "bookkeeping",
                path: "memory/2026-04-03-session-reset.md",
                startLine: 9,
                endLine: 9,
                source: "memory",
                snippet: "# Session: 2026-04-03 10:00:00 UTC",
                recallCount: 3,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 2.1,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["summary"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const actualRename: typeof fs.rename = fs.rename.bind(fs);
      let failNextWriteback = true;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation((async (from, to) => {
        if (String(to) === storePath && failNextWriteback) {
          failNextWriteback = false;
          const error = new Error("no access") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return await actualRename(from as never, to as never);
      }) as typeof fs.rename);

      try {
        await expect(
          readShortTermRecallEntries({
            workspaceDir,
            nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
          }),
        ).resolves.toEqual([]);

        await expect(
          fs.readFile(storePath, "utf-8").then((raw) => JSON.parse(raw)),
        ).resolves.toMatchObject({
          entries: {
            bookkeeping: expect.any(Object),
          },
        });

        await expect(
          readShortTermRecallEntries({
            workspaceDir,
            nowMs: Date.parse("2026-04-04T10:01:00.000Z"),
          }),
        ).resolves.toEqual([]);
      } finally {
        renameSpy.mockRestore();
      }

      await expect(
        fs.readFile(storePath, "utf-8").then((raw) => JSON.parse(raw)),
      ).resolves.toMatchObject({
        entries: {},
        sessionSummaryPurgedAt: expect.any(String),
      });

      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-04-03-session-reset.md"),
        "Durable follow-up note.\n",
        "utf-8",
      );

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:02:00.000Z"),
        }),
      ).resolves.toEqual([]);
    });
  });

  it("purges deleted legacy-basename session-summary recall entries with plain conversation text when the file was remembered as bookkeeping", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await rememberRecentDailyMemoryFile({
        memoryDir: path.join(workspaceDir, "memory"),
        fileName: "2026-04-03-vendor-pitch.md",
        sessionSummary: true,
      });
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              bookkeeping: {
                key: "bookkeeping",
                path: "2026-04-03-vendor-pitch.md",
                startLine: 11,
                endLine: 11,
                source: "memory",
                snippet: "We should follow up with the vendor tomorrow.",
                recallCount: 3,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 2.1,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["summary"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        }),
      ).resolves.toEqual([]);
    });
  });

  it("keeps sibling-backed deleted slugged recall entries during legacy session-summary cleanup", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
        "Context",
        "We should follow up with the vendor tomorrow.",
      ]);
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              durable: {
                key: "durable",
                path: "memory/2026-04-03-vendor-pitch.md",
                startLine: 11,
                endLine: 11,
                source: "memory",
                snippet: "We should follow up with the vendor tomorrow.",
                recallCount: 2,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 1.8,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["legacy-q"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          path: "memory/2026-04-03-vendor-pitch.md",
          snippet: "We should follow up with the vendor tomorrow.",
        }),
      ]);
    });
  });

  it("drops deleted slugged live recalls when same-day siblings lack the snippet", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
        "Context",
        "A different durable note survived.",
      ]);
      const entry = {
        key: "durable",
        path: "memory/2026-04-03-vendor-pitch.md",
        startLine: 11,
        endLine: 11,
        source: "memory" as const,
        snippet: "We should follow up with the vendor tomorrow.",
        recallCount: 2,
        dailyCount: 0,
        groundedCount: 0,
        totalScore: 1.8,
        maxScore: 0.9,
        firstRecalledAt: "2026-04-03T00:00:00.000Z",
        lastRecalledAt: "2026-04-04T00:00:00.000Z",
        queryHashes: ["legacy-q"],
        recallDays: ["2026-04-03"],
        conceptTags: [],
      };

      await expect(
        filterLiveShortTermRecallEntries({ workspaceDir, entries: [entry] }),
      ).resolves.toEqual([]);
    });
  });

  it("keeps deleted slugged live recalls when a same-day sibling still contains the snippet", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
        "Context",
        "We should follow up with the vendor tomorrow.",
      ]);
      const entry = {
        key: "durable",
        path: "memory/2026-04-03-vendor-pitch.md",
        startLine: 11,
        endLine: 11,
        source: "memory" as const,
        snippet: "We should follow up with the vendor tomorrow.",
        recallCount: 2,
        dailyCount: 0,
        groundedCount: 0,
        totalScore: 1.8,
        maxScore: 0.9,
        firstRecalledAt: "2026-04-03T00:00:00.000Z",
        lastRecalledAt: "2026-04-04T00:00:00.000Z",
        queryHashes: ["legacy-q"],
        recallDays: ["2026-04-03"],
        conceptTags: [],
      };

      await expect(
        filterLiveShortTermRecallEntries({ workspaceDir, entries: [entry] }),
      ).resolves.toEqual([entry]);
    });
  });

  it("does not let remembered session-summary provenance purge sibling-backed durable recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
        "Context",
        "We should follow up with the vendor tomorrow.",
      ]);
      await rememberRecentDailyMemoryFile({
        memoryDir: path.join(workspaceDir, "memory"),
        fileName: "2026-04-03-vendor-pitch.md",
        sessionSummary: true,
      });
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              bookkeeping: {
                key: "bookkeeping",
                path: "memory/2026-04-03-vendor-pitch.md",
                startLine: 11,
                endLine: 11,
                source: "memory",
                snippet: "We should follow up with the vendor tomorrow.",
                recallCount: 2,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 1.8,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["legacy-q"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          path: "memory/2026-04-03-vendor-pitch.md",
          snippet: "We should follow up with the vendor tomorrow.",
        }),
      ]);
    });
  });

  it("does not let remembered canonical session-summary provenance purge sibling-backed durable recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-04-03-vendor-pitch.md"),
        "We should follow up with the vendor tomorrow.\n",
        "utf-8",
      );
      await rememberRecentDailyMemoryFile({
        memoryDir: path.join(workspaceDir, "memory"),
        fileName: "2026-04-03.md",
        sessionSummary: true,
      });
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              bookkeeping: {
                key: "bookkeeping",
                path: "memory/2026-04-03.md",
                startLine: 11,
                endLine: 11,
                source: "memory",
                snippet: "We should follow up with the vendor tomorrow.",
                recallCount: 2,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 1.8,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["legacy-q"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          path: "memory/2026-04-03.md",
          snippet: "We should follow up with the vendor tomorrow.",
        }),
      ]);
    });
  });

  it("re-sanitizes legacy stores when remembered bookkeeping metadata changes without rewriting the store", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              legacy: {
                key: "legacy",
                path: "memory/2026-04-03-vendor-pitch.md",
                startLine: 11,
                endLine: 11,
                source: "memory",
                snippet: "We should follow up with the vendor tomorrow.",
                recallCount: 2,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 1.8,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["legacy-q"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          path: "memory/2026-04-03-vendor-pitch.md",
          snippet: "We should follow up with the vendor tomorrow.",
        }),
      ]);

      await rememberRecentDailyMemoryFile({
        memoryDir: path.join(workspaceDir, "memory"),
        fileName: "2026-04-03-vendor-pitch.md",
        sessionSummary: true,
      });

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:01:00.000Z"),
        }),
      ).resolves.toEqual([]);
    });
  });

  it("re-sanitizes normalized stores when remembered bookkeeping metadata changes", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            sessionSummaryPurgedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              normalized: {
                key: "normalized",
                path: "memory/2026-04-03-vendor-pitch.md",
                startLine: 11,
                endLine: 11,
                source: "memory",
                snippet: "We should follow up with the vendor tomorrow.",
                recallCount: 2,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 1.8,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["legacy-q"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          path: "memory/2026-04-03-vendor-pitch.md",
          snippet: "We should follow up with the vendor tomorrow.",
        }),
      ]);

      await rememberRecentDailyMemoryFile({
        memoryDir: path.join(workspaceDir, "memory"),
        fileName: "2026-04-03-vendor-pitch.md",
        sessionSummary: true,
      });

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:01:00.000Z"),
        }),
      ).resolves.toEqual([]);
    });
  });

  it("invalidates the short-term store cache when the store is rewritten to the same size", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const preservedMtime = new Date("2026-04-04T00:00:00.000Z");
      const buildStoreRaw = (snippet: string, queryHash: string) =>
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            sessionSummaryPurgedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              durable: {
                key: "durable",
                path: "memory/2026-04-03.md",
                startLine: 1,
                endLine: 1,
                source: "memory",
                snippet,
                recallCount: 1,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 0.9,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: [queryHash],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`;
      const firstRaw = buildStoreRaw("same size A", "aaaaaaaaaaaa");
      const secondRaw = buildStoreRaw("same size B", "bbbbbbbbbbbb");
      expect(firstRaw.length).toBe(secondRaw.length);

      await fs.writeFile(storePath, firstRaw, "utf-8");
      await fs.utimes(storePath, preservedMtime, preservedMtime);

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          snippet: "same size A",
          queryHashes: ["aaaaaaaaaaaa"],
        }),
      ]);

      await fs.writeFile(storePath, secondRaw, "utf-8");
      await fs.utimes(storePath, preservedMtime, preservedMtime);

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:01:00.000Z"),
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          snippet: "same size B",
          queryHashes: ["bbbbbbbbbbbb"],
        }),
      ]);
    });
  });

  it("drops mutated in-memory short-term snapshots after a failed store write", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const snippet = "Persisted durable note.";
      const claimHash = __testing.buildClaimHash(snippet);
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-04-03.md"),
        `${snippet}\n`,
        "utf-8",
      );
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            sessionSummaryPurgedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              durable: {
                key: "durable",
                path: "memory/2026-04-03.md",
                startLine: 1,
                endLine: 1,
                source: "memory",
                snippet,
                recallCount: 1,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 0.9,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["persisted-q"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
                claimHash,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (String(to) === storePath) {
          const error = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
          throw error;
        }
        return await vi
          .importActual<typeof import("node:fs/promises")>("node:fs/promises")
          .then((actual) => actual.rename(from, to));
      });
      try {
        await expect(
          recordShortTermRecalls({
            workspaceDir,
            query: "fresh recall",
            results: [
              {
                path: "memory/2026-04-03.md",
                startLine: 1,
                endLine: 1,
                score: 0.8,
                snippet,
                source: "memory",
              },
            ],
            nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
          }),
        ).rejects.toMatchObject({ code: "ENOSPC" });
      } finally {
        renameSpy.mockRestore();
      }

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:01:00.000Z"),
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          path: "memory/2026-04-03.md",
          recallCount: 1,
          queryHashes: ["persisted-q"],
        }),
      ]);
    });
  });

  it("does not rescan persisted session-summary sources after the store snapshot is cached", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-04-03-session-reset.md"),
        [
          "# Session: 2026-04-03 19:30:00 America/Chicago",
          "",
          SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
          "",
          "- **Session Key**: agent:main:main",
          "- **Session ID**: reset-123",
          "- **Source**: cli",
          "",
          "## Conversation Summary",
          "",
          "assistant: bookkeeping only",
        ].join("\n") + "\n",
        "utf-8",
      );

      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const sessionSummaryPath = path.join(workspaceDir, "memory", "2026-04-03-session-reset.md");
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              bookkeeping: {
                key: "bookkeeping",
                path: "memory/2026-04-03-session-reset.md",
                startLine: 9,
                endLine: 9,
                source: "memory",
                snippet: "assistant: bookkeeping only",
                recallCount: 3,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 2.1,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["summary"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const canonicalSessionSummaryPath = await fs.realpath(sessionSummaryPath);
      const openSpy = vi.spyOn(fsSync, "openSync");
      let sessionSummaryReads = 0;
      try {
        await readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
        });
        await readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:01:00.000Z"),
        });
        const resolveOpenedPath = (filePath: Parameters<typeof fsSync.openSync>[0]) =>
          typeof filePath === "string"
            ? path.resolve(filePath)
            : filePath instanceof URL
              ? path.resolve(fileURLToPath(filePath))
              : Buffer.isBuffer(filePath)
                ? path.resolve(filePath.toString("utf-8"))
                : null;
        sessionSummaryReads = openSpy.mock.calls.filter(
          ([filePath]) => resolveOpenedPath(filePath) === canonicalSessionSummaryPath,
        ).length;
      } finally {
        openSpy.mockRestore();
      }

      expect(sessionSummaryReads).toBe(1);
    });
  });

  it("revalidates cached store dependencies with bounded file opens without rereading memory sources", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const notePath = await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
        "Durable router note.",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "router note",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "Durable router note.",
            source: "memory",
          },
        ],
        nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
      });

      await readShortTermRecallEntries({
        workspaceDir,
        nowMs: Date.parse("2026-04-04T10:01:00.000Z"),
      });

      const canonicalNotePath = await fs.realpath(notePath);
      const resolveReadPath = (filePath: Parameters<typeof fs.readFile>[0]) =>
        typeof filePath === "string"
          ? path.resolve(filePath)
          : filePath instanceof URL
            ? path.resolve(fileURLToPath(filePath))
            : Buffer.isBuffer(filePath)
              ? path.resolve(filePath.toString("utf-8"))
              : null;
      const resolveOpenPath = (filePath: Parameters<typeof fs.open>[0]) =>
        typeof filePath === "string"
          ? path.resolve(filePath)
          : filePath instanceof URL
            ? path.resolve(fileURLToPath(filePath))
            : Buffer.isBuffer(filePath)
              ? path.resolve(filePath.toString("utf-8"))
              : null;
      const readFileSpy = vi.spyOn(fs, "readFile");
      const openSpy = vi.spyOn(fs, "open");
      const readdirSpy = vi.spyOn(fs, "readdir");
      let sourceReads = 0;
      let sourceOpens = 0;
      let siblingScans = 0;
      try {
        await readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:02:00.000Z"),
        });
        sourceReads = readFileSpy.mock.calls.filter(
          ([filePath]) => resolveReadPath(filePath) === canonicalNotePath,
        ).length;
        sourceOpens = openSpy.mock.calls.filter(
          ([filePath]) => resolveOpenPath(filePath) === canonicalNotePath,
        ).length;
        siblingScans = readdirSpy.mock.calls.filter(
          ([filePath]) =>
            resolveReadPath(filePath as Parameters<typeof fs.readFile>[0]) ===
            path.join(workspaceDir, "memory"),
        ).length;
      } finally {
        readFileSpy.mockRestore();
        openSpy.mockRestore();
        readdirSpy.mockRestore();
      }

      expect(sourceReads).toBe(0);
      expect(sourceOpens).toBeGreaterThan(0);
      expect(siblingScans).toBe(0);
    });
  });

  it("invalidates cached store sanitization when a referenced daily note changes in place", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const notePath = await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
        "Durable router note.",
      ]);
      await recordShortTermRecalls({
        workspaceDir,
        query: "router note",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 1,
            score: 0.9,
            snippet: "Durable router note.",
            source: "memory",
          },
        ],
        nowMs: Date.parse("2026-04-04T10:00:00.000Z"),
      });

      expect(
        await readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:01:00.000Z"),
        }),
      ).toHaveLength(1);

      await fs.writeFile(
        notePath,
        [
          "# Session: 2026-04-03 19:30:00 America/Chicago",
          "",
          SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
          "",
          "- **Session Key**: agent:main:main",
          "- **Session ID**: reset-123",
          "- **Source**: cli",
          "",
          "## Conversation Summary",
          "",
          "assistant: bookkeeping only",
        ].join("\n") + "\n",
        "utf-8",
      );

      await expect(
        readShortTermRecallEntries({
          workspaceDir,
          nowMs: Date.parse("2026-04-04T10:02:00.000Z"),
        }),
      ).resolves.toEqual([]);
      await expect(
        rankShortTermPromotionCandidates({
          workspaceDir,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
          includePromoted: true,
          nowMs: Date.parse("2026-04-04T10:03:00.000Z"),
        }),
      ).resolves.toEqual([]);
    });
  });

  it("repairs persisted session-summary recall entries out of the store", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", ["Durable router note."]);
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-04-03-session-reset.md"),
        [
          "# Session: 2026-04-03 19:30:00 America/Chicago",
          "",
          SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
          "",
          "- **Session Key**: agent:main:main",
          "- **Session ID**: reset-123",
          "- **Source**: cli",
          "",
          "## Conversation Summary",
          "",
          "assistant: bookkeeping only",
        ].join("\n") + "\n",
        "utf-8",
      );

      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      await fs.writeFile(
        storePath,
        `${JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
              durable: {
                key: "durable",
                path: "memory/2026-04-03.md",
                startLine: 1,
                endLine: 1,
                source: "memory",
                snippet: "Durable router note.",
                recallCount: 2,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 1.8,
                maxScore: 0.95,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["a", "b"],
                recallDays: ["2026-04-03"],
                conceptTags: ["router"],
              },
              bookkeeping: {
                key: "bookkeeping",
                path: "memory/2026-04-03-session-reset.md",
                startLine: 9,
                endLine: 9,
                source: "memory",
                snippet: "assistant: bookkeeping only",
                recallCount: 3,
                dailyCount: 0,
                groundedCount: 0,
                totalScore: 2.1,
                maxScore: 0.9,
                firstRecalledAt: "2026-04-03T00:00:00.000Z",
                lastRecalledAt: "2026-04-04T00:00:00.000Z",
                queryHashes: ["summary"],
                recallDays: ["2026-04-03"],
                conceptTags: [],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const repair = await repairShortTermPromotionArtifacts({ workspaceDir });

      expect(repair.changed).toBe(true);
      expect(repair.rewroteStore).toBe(true);
      expect(repair.removedInvalidEntries).toBe(1);

      const repaired = JSON.parse(await fs.readFile(storePath, "utf-8")) as {
        entries: Record<string, { path: string }>;
      };
      expect(Object.values(repaired.entries).map((entry) => entry.path)).toEqual([
        "memory/2026-04-03.md",
      ]);
    });
  });

  it("does not rewrite an already normalized healthy recall store", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const snippet = "Gateway host uses qmd vector search for router notes.";
      const raw = `${JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-04-04T00:00:00.000Z",
          sessionSummaryPurgedAt: "2026-04-04T00:00:00.000Z",
          entries: {
            good: {
              key: "good",
              path: "memory/2026-04-01.md",
              startLine: 1,
              endLine: 2,
              source: "memory",
              snippet,
              recallCount: 2,
              dailyCount: 0,
              groundedCount: 0,
              totalScore: 1.8,
              maxScore: 0.95,
              firstRecalledAt: "2026-04-01T00:00:00.000Z",
              lastRecalledAt: "2026-04-04T00:00:00.000Z",
              queryHashes: ["a", "b"],
              recallDays: ["2026-04-04"],
              conceptTags: __testing.deriveConceptTags({
                path: "memory/2026-04-01.md",
                snippet,
              }),
            },
          },
        },
        null,
        2,
      )}\n`;
      await fs.writeFile(storePath, raw, "utf-8");

      const repair = await repairShortTermPromotionArtifacts({ workspaceDir });

      expect(repair.changed).toBe(false);
      expect(repair.rewroteStore).toBe(false);
      const nextRaw = await fs.readFile(storePath, "utf-8");
      expect(nextRaw).toBe(raw);
    });
  });

  it("waits for an active short-term lock before repairing", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const storePath = resolveShortTermRecallStorePath(workspaceDir);
      const lockPath = resolveShortTermRecallLockPath(workspaceDir);
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: "2026-04-04T00:00:00.000Z",
            entries: {
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
      await fs.writeFile(lockPath, `${process.pid}:${Date.now()}\n`, "utf-8");

      let settled = false;
      const repairPromise = repairShortTermPromotionArtifacts({ workspaceDir }).then((result) => {
        settled = true;
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, 41));
      expect(settled).toBe(false);

      await fs.unlink(lockPath);
      const repair = await repairPromise;

      expect(repair.changed).toBe(true);
      expect(repair.rewroteStore).toBe(true);
      expect(repair.removedInvalidEntries).toBe(1);
    });
  });

  it("downgrades lock inspection failures into audit issues", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      const lockPath = path.join(workspaceDir, "memory", ".dreams", "short-term-promotion.lock");
      const stat = vi.spyOn(fs, "stat").mockImplementation(async (target) => {
        if (String(target) === lockPath) {
          const error = Object.assign(new Error("no access"), { code: "EACCES" });
          throw error;
        }
        return await vi
          .importActual<typeof import("node:fs/promises")>("node:fs/promises")
          .then((actual) => actual.stat(target));
      });
      try {
        const audit = await auditShortTermPromotionArtifacts({ workspaceDir });
        expect(audit.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "recall-lock-unreadable",
              fixable: false,
            }),
          ]),
        );
      } finally {
        stat.mockRestore();
      }
    });
  });

  it("reports concept tag script coverage for multilingual recalls", async () => {
    await withTempWorkspace(async (workspaceDir) => {
      await recordShortTermRecalls({
        workspaceDir,
        query: "routeur glacier",
        results: [
          {
            path: "memory/2026-04-03.md",
            startLine: 1,
            endLine: 2,
            score: 0.93,
            snippet: "Configuration du routeur et sauvegarde Glacier.",
            source: "memory",
          },
        ],
      });
      await recordShortTermRecalls({
        workspaceDir,
        query: "router cjk",
        results: [
          {
            path: "memory/2026-04-04.md",
            startLine: 1,
            endLine: 2,
            score: 0.95,
            snippet: "障害対応ルーター設定とバックアップ確認。",
            source: "memory",
          },
        ],
      });

      const audit = await auditShortTermPromotionArtifacts({ workspaceDir });
      expect(audit.conceptTaggedEntryCount).toBe(2);
      expect(audit.conceptTagScripts).toEqual({
        latinEntryCount: 1,
        cjkEntryCount: 1,
        mixedEntryCount: 0,
        otherEntryCount: 0,
      });
    });
  });

  it("extracts stable concept tags from snippets and paths", () => {
    expect(
      __testing.deriveConceptTags({
        path: "memory/2026-04-03.md",
        snippet: "Move backups to S3 Glacier and sync QMD router notes.",
      }),
    ).toEqual(expect.arrayContaining(["glacier", "router", "backups"]));
  });

  it("extracts multilingual concept tags across latin and cjk snippets", () => {
    expect(
      __testing.deriveConceptTags({
        path: "memory/2026-04-03.md",
        snippet: "Configuración du routeur et sauvegarde Glacier.",
      }),
    ).toEqual(expect.arrayContaining(["configuración", "routeur", "sauvegarde", "glacier"]));
    expect(
      __testing.deriveConceptTags({
        path: "memory/2026-04-03.md",
        snippet: "障害対応ルーター設定とバックアップ確認。路由器备份与网关同步。",
      }),
    ).toEqual(expect.arrayContaining(["障害対応", "ルーター", "バックアップ", "路由器", "备份"]));
  });
});
