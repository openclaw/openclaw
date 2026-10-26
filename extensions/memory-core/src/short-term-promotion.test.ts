// Memory Core tests cover short term promotion plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { listMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it as baseIt, vi } from "vitest";
import { previewRemDreaming } from "./dreaming-phases.js";

vi.mock("openclaw/plugin-sdk/memory-host-events", () => ({
  appendMemoryHostEvent: vi.fn(async () => {}),
}));
vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", { spy: true });

import {
  configureMemoryCoreDreamingState,
  memoryCoreWorkspaceStateKey,
  openMemoryCoreStateStore,
  SHORT_TERM_LOCK_MAX_ENTRIES,
  SHORT_TERM_LOCK_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
} from "./dreaming-state.js";
import {
  deleteShortTermLockEntryIfCurrent,
  withMemoryWorkspaceLock,
} from "./memory-workspace-lock.js";
import {
  applyShortTermPromotions,
  auditShortTermPromotionArtifacts,
  filterLiveShortTermRecallEntries,
  loadShortTermPromotionDreamingStats,
  rankShortTermPromotionCandidates,
  recordDreamingPhaseSignals,
  recordRemConsideredPhaseSignals,
  recordShortTermRecalls,
  readLightStagedKeys,
  removeGroundedShortTermCandidates,
  repairShortTermPromotionArtifacts,
  type ShortTermRecallEntry,
} from "./short-term-promotion.js";
import {
  configureMemoryCoreDreamingStateForTests,
  createPromotionCandidateForTest as promotionCandidateFixture,
  resetMemoryCoreDreamingStateForTests,
  shortTermTestState as testing,
} from "./test-helpers.js";

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
type PromotionCandidate = Awaited<ReturnType<typeof rankShortTermPromotionCandidates>>[number];

const allPromotionThresholds = {
  minScore: 0,
  minRecallCount: 0,
  minUniqueQueries: 0,
} as const;

function recall(
  snippet: string,
  memoryPath = "memory/2026-04-03.md",
  startLine = 1,
  endLine = startLine,
  score = 0.9,
  extras: RecallResultExtras = {},
): RecallResult {
  return { ...extras, path: memoryPath, startLine, endLine, score, snippet, source: "memory" };
}

function record(
  workspaceDir: string,
  query: string,
  results: RecallResult | RecallResult[],
  options: Omit<RecordRecallParams, "workspaceDir" | "query" | "results"> = {},
): Promise<void> {
  return recordShortTermRecalls({
    ...options,
    workspaceDir,
    query,
    results: Array.isArray(results) ? results : [results],
  });
}

function rankAll(workspaceDir: string, options: RankAllOptions = {}) {
  return rankShortTermPromotionCandidates({ ...options, workspaceDir, ...allPromotionThresholds });
}

function applyAll(
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

function storedRecall(
  key: string,
  params: Partial<ShortTermRecallEntry> = {},
): ShortTermRecallEntry {
  return {
    startLine: 1,
    endLine: 1,
    source: "memory",
    key,
    path: "memory/2026-04-01.md",
    snippet: `${key} recall`,
    recallCount: 2,
    dailyCount: 0,
    groundedCount: 0,
    totalScore: 1.8,
    maxScore: 0.95,
    firstRecalledAt: "2026-04-01T00:00:00.000Z",
    lastRecalledAt: "2026-04-04T00:00:00.000Z",
    queryHashes: ["a", "b"],
    recallDays: ["2026-04-04"],
    conceptTags: [],
    ...params,
  };
}

function groundedCandidateFixture(
  params: Pick<RecallResult, "path" | "snippet" | "query"> & Partial<RecallResult>,
): RecallResult {
  return {
    source: "memory",
    startLine: 1,
    endLine: 1,
    score: 0.9,
    signalCount: 1,
    dayBucket: "2026-04-03",
    ...params,
  };
}

function readMemory(workspaceDir: string) {
  return fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
}

function writeRecallEntries(
  workspaceDir: string,
  entries: Record<string, unknown>,
  updatedAt = "2026-04-04T00:00:00.000Z",
) {
  return testing.writeRawRecallStore(workspaceDir, { version: 1, updatedAt, entries });
}

function writePhaseEntries(
  workspaceDir: string,
  entries: Record<string, unknown>,
  updatedAt = "2026-04-04T00:00:00.000Z",
) {
  return testing.writeRawPhaseSignalStore(workspaceDir, { version: 1, updatedAt, entries });
}

describe("short-term promotion", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    await configureMemoryCoreDreamingStateForTests();
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-promote-"));
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

  async function promoteDailyHeadingSnippet(
    workspaceDir: string,
    params: { snippet: string; startLine?: number; endLine?: number },
  ) {
    const startLine = params.startLine ?? 4;
    await record(
      workspaceDir,
      "__dreaming_daily__:2026-05-28",
      recall(params.snippet, "memory/2026-05-28.md", startLine, params.endLine ?? startLine, 0.91),
      { signalType: "daily", dedupeByQueryPerDay: true, dayBucket: "2026-05-28" },
    );
    const nowMs = Date.parse("2026-05-31T00:00:00.000Z");
    return await applyAll(workspaceDir, await rankAll(workspaceDir, { nowMs }), { nowMs });
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

  async function seedGatewayPromotionCandidate(workspaceDir: string) {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [
      ...Array.from({ length: 9 }, (_, index) => `intro ${index}`),
      "- Gateway binds loopback and port 18789",
      "Keep gateway on localhost only",
      "Document healthcheck endpoint",
    ]);
    await record(
      workspaceDir,
      "gateway host",
      recall("- Gateway binds loopback and port 18789", "memory/2026-04-01.md", 10, 12, 0.92),
    );
    return await rankAll(workspaceDir);
  }

  function recordRotateCredentialsRecall(workspaceDir: string): Promise<void> {
    return record(
      workspaceDir,
      "rotate creds",
      recall("Rotate credentials before deployment.", "memory/2026-04-29.md", 3, 3, 0.96),
      { nowMs: Date.parse("2026-04-29T10:00:00.000Z") },
    );
  }

  async function readRecallStoreEntries(workspaceDir: string) {
    return await testing
      .readRecallStore(workspaceDir, new Date().toISOString())
      .then((store) => store.entries);
  }

  async function clearPromotedAt(workspaceDir: string): Promise<void> {
    const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
    for (const entry of Object.values(store.entries)) {
      delete entry.promotedAt;
    }
    await testing.writeRawRecallStore(workspaceDir, store);
  }

  async function expectEnoent(promise: Promise<unknown>): Promise<void> {
    await expect(promise).rejects.toHaveProperty("code", "ENOENT");
  }

  it("deduplicates source-file checks within a recall batch", async (workspaceDir) => {
    const notePath = await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
      "Deduplicated source check note.",
    ]);
    const relativePath = path.relative(workspaceDir, notePath).replaceAll("\\", "/");
    const entry = storedRecall("duplicate-source", {
      path: relativePath,
      snippet: "Deduplicated source check note.",
      recallCount: 1,
      dailyCount: 1,
      totalScore: 0.9,
      maxScore: 0.9,
      firstRecalledAt: "2026-04-03T00:00:00.000Z",
      lastRecalledAt: "2026-04-03T00:00:00.000Z",
      queryHashes: ["query"],
      recallDays: ["2026-04-03"],
    });
    const statSpy = vi.spyOn(fs, "stat");

    const live = await filterLiveShortTermRecallEntries({
      workspaceDir,
      entries: [entry, { ...entry, key: "duplicate-source-2" }],
    });

    expect(live).toHaveLength(2);
    expect(statSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back when the injected recall timestamp is outside Date range", async (workspaceDir) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));
    const notePath = await writeDailyMemoryNote(workspaceDir, "2026-05-30", [
      "Bounded recall timestamp note.",
    ]);

    await record(
      workspaceDir,
      "bounded recall",
      recall(
        "Bounded recall timestamp note.",
        path.relative(workspaceDir, notePath).replaceAll("\\", "/"),
      ),
      { nowMs: 8_640_000_000_000_001 },
    );

    const [entry] = Object.values(await readRecallStoreEntries(workspaceDir));
    expect(entry?.firstRecalledAt).toBe("2026-05-30T12:00:00.000Z");
    expect(entry?.lastRecalledAt).toBe("2026-05-30T12:00:00.000Z");
  });

  it("caps short-term recall store entries and snippets during normal recording", async (workspaceDir) => {
    const maxEntries = testing.SHORT_TERM_RECALL_MAX_ENTRIES;
    const maxSnippetChars = testing.SHORT_TERM_RECALL_MAX_SNIPPET_CHARS;
    await record(workspaceDir, "bounded recall", [
      ...Array.from({ length: maxEntries + 5 }, (_, index) =>
        recall(
          `${`Recall entry ${index} `.padEnd(maxSnippetChars - 1, "x")}🚀tail`,
          "memory/2026-04-03.md",
          index + 1,
          index + 1,
          0.1 + index / (maxEntries + 5),
        ),
      ),
      recall("Long-term note", "MEMORY.md", 1, 1, 1),
    ]);

    const entries = Object.values(await readRecallStoreEntries(workspaceDir));
    expect(entries).toHaveLength(maxEntries);
    expect(entries.map((entry) => entry.path)).not.toContain("MEMORY.md");
    expect(entries.every((entry) => entry.snippet.length === maxSnippetChars - 1)).toBe(true);
    expect(entries.every((entry) => !entry.snippet.includes("\uD83D"))).toBe(true);
    expect(entries.some((entry) => entry.snippet.startsWith("Recall entry 0 "))).toBe(false);
    expect(
      entries.some((entry) => entry.snippet.startsWith(`Recall entry ${maxEntries + 4} `)),
    ).toBe(true);
  });

  it("keeps long-snippet claim identity stable while storing capped snippets", async (workspaceDir) => {
    const maxSnippetChars = testing.SHORT_TERM_RECALL_MAX_SNIPPET_CHARS;
    const longSnippet = `Stable claim identity ${"x".repeat(maxSnippetChars + 100)}`;

    await recordShortTermRecalls({
      workspaceDir,
      query: "__dreaming_grounded_backfill__",
      signalType: "grounded",
      results: [
        groundedCandidateFixture({
          path: "memory/2026-04-03.md",
          snippet: longSnippet,
          query: "__dreaming_grounded_backfill__:candidate",
        }),
      ],
      nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
    });

    await record(
      workspaceDir,
      "stable claim",
      recall(longSnippet, "memory/2026-04-03.md", 1, 1, 0.8),
      { nowMs: Date.parse("2026-04-03T11:00:00.000Z") },
    );

    const entries = Object.entries(await readRecallStoreEntries(workspaceDir));
    expect(entries).toHaveLength(1);
    const [key, entry] = expectDefined(entries[0], "stable claim recall entry");
    expect(key).toMatch(/:[a-f0-9]{12}$/);
    expect(key.endsWith(`:${entry.claimHash}`)).toBe(true);
    expect(entry.recallCount).toBe(1);
    expect(entry.snippet.length).toBeLessThanOrEqual(maxSnippetChars);
  });

  baseIt.each([
    "memory/dreaming/deep/2026-04-03.md",
    "../../vault/memory/dreaming/deep/2026-04-03.md",
  ])("ignores dream report path %s when recording recalls", async (reportPath) => {
    await withTempWorkspace(async (workspaceDir) => {
      await record(
        workspaceDir,
        "dream recall",
        recall("Dream reports should not seed promotions.", reportPath),
      );
      expect(await readRecallStoreEntries(workspaceDir)).toEqual({});
    });
  });

  it("excludes staged and generated REM recalls while keeping ordinary reflections", async (workspaceDir) => {
    const ordinary = "Reflections on deployment planning: keep a verified backup before release.";
    const snippets = [
      [
        "- Candidate: Default to action.",
        "  - confidence: 0.76",
        "  - evidence: memory/.dreams/session-corpus/2026-04-08.txt:1-1",
        "  - recalls: 3",
        "  - status: staged",
      ].join("\n"),
      previewRemDreaming({
        entries: [
          storedRecall("source", { path: "memory/2026-04-03.md", conceptTags: ["deployment"] }),
        ],
        limit: 1,
        minPatternStrength: 0.5,
      }).bodyLines.join("\n"),
      ordinary,
    ];
    await record(
      workspaceDir,
      "deployment planning",
      snippets.map((snippet, index) =>
        recall(snippet, "memory/2026-04-03.md", index + 1, index + 1, 0.92),
      ),
    );
    const ranked = await rankAll(workspaceDir);
    expect(ranked.map((candidate) => candidate.snippet)).toEqual([ordinary]);
  });

  baseIt.each([
    {
      name: "raw session and transcript snippets",
      snippets: [
        "Session: 2026-06-18 10:37:05 EDT; Session Key: agent:cody:discord:channel:1502199757592989836; Session ID: 6d52b6a2-a2e1-4839-a69a-a532b9090a6d; Source: discord",
        "Conversation Summary: assistant: Traced all three. No changes made.",
        "user: Save important context from this session to the daily memory file. STRICT RULES: 1. The file MUST be named exactly memory/2026-06-18.md",
      ],
      expected: [],
    },
    {
      name: "already-promoted score metadata",
      snippets: [
        "2026-06-13 09:20 America/New_York - Polycore PR #112 re-review... [score=0.837 recalls=0 avg=0.620 source=memory/2026-06-13.md:10-12]",
      ],
      expected: [],
    },
    {
      name: "ordinary quote of a dreaming prompt",
      snippets: [
        "Debug note: quote Write a dream diary entry from these memory fragments for docs, but do not use dreaming-narrative-like labels in production.",
      ],
      expected: [
        "Debug note: quote Write a dream diary entry from these memory fragments for docs, but do not use dreaming-narrative-like labels in production.",
      ],
    },
  ])("filters recall content: $name", async ({ snippets, expected }) => {
    await withTempWorkspace(async (workspaceDir) => {
      await record(
        workspaceDir,
        "recall content",
        snippets.map((snippet, index) =>
          recall(snippet, "memory/2026-06-18.md", index + 1, index + 1, 0.92 - index / 100),
        ),
      );
      const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
      expect(store.version).toBe(1);
      expect(Object.values(store.entries).map((entry) => entry.snippet)).toEqual(expected);
    });
  });

  it("keeps blocked origins out of ranking before applying the candidate limit", async (workspaceDir) => {
    const nowMs = Date.parse("2026-04-03T10:00:00.000Z");
    const origins = ["untrusted", "system", "owner", "agent", undefined] as const;
    await record(
      workspaceDir,
      "release notes",
      origins.map((originClass, index) =>
        recall(
          `Keep release notes beside the deployment checklist ${index}.`,
          "memory/2026-04-02.md",
          index + 1,
          index + 1,
          index < 2 ? 0.99 : 0.1,
          originClass
            ? { provenance: { originClass, sessionKind: "interactive", observedAt: nowMs } }
            : {},
        ),
      ),
      { nowMs },
    );

    const ranked = await rankAll(workspaceDir, { nowMs });
    expect(ranked.map((candidate) => candidate.startLine).toSorted((a, b) => a - b)).toEqual([
      3, 4, 5,
    ]);
    expect(await rankAll(workspaceDir, { nowMs, limit: 1 })).toEqual(ranked.slice(0, 1));
    expect(await rankAll(workspaceDir, { nowMs, limit: 1, includePromoted: true })).toEqual(
      ranked.slice(0, 1),
    );
  });

  it("preserves a project annotation from recall ingestion through promotion", async (workspaceDir) => {
    const snippet = "Use the repository release helper";
    await writeDailyMemoryNote(workspaceDir, "2026-04-02", [`- ${snippet}`]);
    const projectResult = (projectKey: string) =>
      recall(snippet, "memory/2026-04-02.md", 1, 1, 0.9, { projectKey });
    for (const [query, project] of [
      ["release helper", "path:/Users/Alice/Repo"],
      ["repository release", "path:/Users/alice/repo"],
      ["mixed case repository", "github.com/OpenClaw/OpenClaw"],
    ] as const) {
      await record(workspaceDir, query, projectResult(project));
    }
    const candidates = await rankAll(workspaceDir);
    expect(candidates[0]?.projectKey).toBe(
      "path:/Users/Alice/Repo; path:/Users/alice/repo; github.com/OpenClaw/OpenClaw",
    );

    await applyAll(workspaceDir, candidates);
    await expect(readMemory(workspaceDir)).resolves.toContain(
      "<!-- project: path:/Users/Alice/Repo; path:/Users/alice/repo; github.com/OpenClaw/OpenClaw -->",
    );
  });

  it("serializes concurrent recall writes so counts are not lost", async (workspaceDir) => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        record(
          workspaceDir,
          `backup-${index % 4}`,
          recall("Move backups to S3 Glacier.", "memory/2026-04-03.md", 1, 2),
        ),
      ),
    );

    const ranked = await rankAll(workspaceDir);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.recallCount).toBe(8);
    expect(ranked[0]?.uniqueQueries).toBe(4);
  });

  it("does not create a daily aggregate beside a capped interactive claim", async (workspaceDir) => {
    const longClaim = `Durable interactive claim ${"detail ".repeat(140)}`.trim();
    await record(workspaceDir, "interactive claim", recall(longClaim, "memory/2026-04-01.md"));
    await record(
      workspaceDir,
      "__dreaming_daily__:2026-04-02",
      recall(longClaim, "memory/2026-04-02.md", 3, 3, 0.62),
      { signalType: "daily", dayBucket: "2026-04-02" },
    );

    const ranked = await rankAll(workspaceDir);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ recallCount: 1, dailyCount: 1 });
    expect(ranked[0]?.key).not.toMatch(/^memory:claim:/u);
  });

  for (const signalType of ["recall", "grounded"] as const) {
    it(`reinforces an existing daily claim when ${signalType} arrives second`, async (workspaceDir) => {
      const claim = "Use infra/deploy for staging.";
      await record(
        workspaceDir,
        "__dreaming_daily__:2026-04-01",
        recall(claim, "memory/2026-04-01.md", 3, 3, 0.62),
        { signalType: "daily", dayBucket: "2026-04-01" },
      );
      await record(
        workspaceDir,
        signalType === "grounded" ? "__dreaming_grounded_backfill__" : "deploy scripts",
        recall(
          claim,
          "memory/2026-04-02.md",
          7,
          9,
          0.9,
          signalType === "grounded"
            ? { query: "__dreaming_grounded_backfill__:deploy", signalCount: 1 }
            : {},
        ),
        { signalType, dayBucket: "2026-04-02" },
      );

      const ranked = await rankAll(workspaceDir);
      expect(ranked).toHaveLength(1);
      expect(ranked[0]).toMatchObject({
        recallCount: signalType === "recall" ? 1 : 0,
        dailyCount: 1,
        groundedCount: signalType === "grounded" ? 1 : 0,
        signalCount: 2,
      });
      expect(ranked[0]?.key).toMatch(/^memory:claim:/u);
      // The claim keeps its first citation rather than the later signal's file.
      expect(ranked[0]?.path).toBe("memory/2026-04-01.md");
      expect(ranked[0]?.startLine).toBe(3);
    });
  }

  it("reads only light-staged keys that have not already gone through REM", async (workspaceDir) => {
    const nowMs = Date.parse("2026-04-05T10:00:00.000Z");
    await record(
      workspaceDir,
      "phase pipeline",
      [
        recall("Move backups to S3 Glacier.", "memory/2026-04-01.md"),
        recall("Document the Ollama setup.", "memory/2026-04-02.md", 1, 1, 0.91),
      ],
      { nowMs },
    );
    const ranked = await rankAll(workspaceDir, { nowMs });
    const staleKey = expectDefined(
      ranked.find((entry) => entry.path === "memory/2026-04-01.md"),
      "stale candidate",
    ).key;
    const pendingKey = expectDefined(
      ranked.find((entry) => entry.path === "memory/2026-04-02.md"),
      "pending candidate",
    ).key;

    for (let hit = 0; hit < 2; hit++) {
      await recordDreamingPhaseSignals({
        workspaceDir,
        phase: "light",
        keys: [staleKey],
        nowMs: nowMs - 60_000,
      });
      await recordDreamingPhaseSignals({ workspaceDir, phase: "rem", keys: [staleKey], nowMs });
    }
    const phases = await testing.readPhaseSignalStore(workspaceDir, new Date(nowMs).toISOString());
    expect(phases.entries[staleKey]).toMatchObject({ lightHits: 2, remHits: 2 });
    await recordDreamingPhaseSignals({
      workspaceDir,
      phase: "light",
      keys: [pendingKey],
      nowMs: nowMs + 60_000,
    });

    await expect(readLightStagedKeys({ workspaceDir, nowMs: nowMs + 120_000 })).resolves.toEqual(
      new Set([pendingKey]),
    );

    await recordRemConsideredPhaseSignals({
      workspaceDir,
      keys: [pendingKey],
      nowMs: nowMs + 180_000,
    });

    await expect(readLightStagedKeys({ workspaceDir, nowMs: nowMs + 240_000 })).resolves.toEqual(
      new Set(),
    );
  });

  it("does not let grounded backfill keys satisfy query diversity", async (workspaceDir) => {
    const snippet = 'Always use "Happy Together" calendar for flights and reservations.';
    await writeDailyMemoryNote(workspaceDir, "2026-04-03", [snippet]);

    await recordShortTermRecalls({
      workspaceDir,
      query: "__dreaming_grounded_backfill__",
      signalType: "grounded",
      results: (
        [
          ["lasting-update", 0.92],
          ["candidate", 0.82],
          ["durable-fact", 0.86],
        ] as const
      ).map(([query, score]) =>
        groundedCandidateFixture({
          path: "memory/2026-04-03.md",
          snippet,
          score,
          query: `__dreaming_grounded_backfill__:${query}`,
        }),
      ),
      dedupeByQueryPerDay: true,
      nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
    });

    await expect(
      rankShortTermPromotionCandidates({
        workspaceDir,
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      }),
    ).resolves.toHaveLength(0);

    const ranked = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.groundedCount).toBe(3);
    expect(ranked[0]?.uniqueQueries).toBe(0);
    expect(ranked[0]?.avgScore).toBeGreaterThan(0.85);

    const applied = await applyShortTermPromotions({
      workspaceDir,
      candidates: ranked,
      minScore: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
    });

    expect(applied.applied).toBe(1);
    const memory = await readMemory(workspaceDir);
    expect(memory).toContain('Always use "Happy Together" calendar');
    expect(memory).toContain("signals=3 recalls=0");
    expect(memory).not.toContain("recalls=3");
  });

  it("preserves interactive query diversity across grounded reruns", async (workspaceDir) => {
    const snippet = "Encrypt router backups.";
    await writeDailyMemoryNote(workspaceDir, "2026-04-03", [snippet]);
    const groundedItem = groundedCandidateFixture({
      path: "memory/2026-04-03.md",
      snippet,
      query: "__dreaming_grounded_backfill__:candidate",
    });

    await record(workspaceDir, "__dreaming_grounded_backfill__", groundedItem, {
      signalType: "grounded",
      nowMs: Date.parse("2026-04-03T09:00:00.000Z"),
    });
    for (const query of ["router backups", "encrypted retention", "glacier storage"]) {
      await record(workspaceDir, query, recall(snippet, "memory/2026-04-03.md", 1, 1, 0.92), {
        nowMs: Date.parse("2026-04-03T10:00:00.000Z"),
      });
    }

    const before = await rankAll(workspaceDir);
    expect(before).toHaveLength(1);
    expect(before[0]?.uniqueQueries).toBe(3);

    await record(workspaceDir, "__dreaming_grounded_backfill__", groundedItem, {
      signalType: "grounded",
      nowMs: Date.parse("2026-04-03T11:00:00.000Z"),
    });

    const after = await rankAll(workspaceDir);
    expect(after).toHaveLength(1);
    expect(after[0]?.key).toBe(before[0]?.key);
    expect(after[0]?.uniqueQueries).toBe(3);
    expect(after[0]?.groundedCount).toBe(2);
  });

  it("removes grounded-only staged entries without deleting mixed live entries", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-03", [
      "Grounded only rule.",
      "Live recall-backed rule.",
    ]);

    await recordShortTermRecalls({
      workspaceDir,
      query: "__dreaming_grounded_backfill__",
      signalType: "grounded",
      results: [
        groundedCandidateFixture({
          path: "memory/2026-04-03.md",
          snippet: "Grounded only rule.",
          score: 0.92,
          query: "__dreaming_grounded_backfill__:lasting-update",
          signalCount: 2,
        }),
        groundedCandidateFixture({
          path: "memory/2026-04-03.md",
          startLine: 2,
          endLine: 2,
          snippet: "Live recall-backed rule.",
          score: 0.92,
          query: "__dreaming_grounded_backfill__:lasting-update",
          signalCount: 2,
        }),
      ],
      dedupeByQueryPerDay: true,
    });
    await record(
      workspaceDir,
      "live recall",
      recall("Live recall-backed rule.", "memory/2026-04-03.md", 2, 2, 0.87),
    );

    const result = await removeGroundedShortTermCandidates({ workspaceDir });
    expect(result.removed).toBe(1);

    const ranked = await rankAll(workspaceDir);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.snippet).toContain("Live recall-backed rule");
    expect(ranked[0]?.groundedCount).toBe(2);
    expect(ranked[0]?.recallCount).toBe(1);
  });

  it("lets recency half-life tune the temporal score", async (workspaceDir) => {
    await record(
      workspaceDir,
      "glacier retention",
      recall("Move backups to S3 Glacier.", "memory/2026-04-01.md", 1, 2, 0.92),
      { nowMs: Date.parse("2026-04-01T10:00:00.000Z") },
    );

    const slowerDecay = await rankAll(workspaceDir, {
      nowMs: Date.parse("2026-04-15T10:00:00.000Z"),
      recencyHalfLifeDays: 14,
    });
    const fasterDecay = await rankAll(workspaceDir, {
      nowMs: Date.parse("2026-04-15T10:00:00.000Z"),
      recencyHalfLifeDays: 7,
    });

    expect(slowerDecay).toHaveLength(1);
    expect(fasterDecay).toHaveLength(1);
    expect(slowerDecay[0]?.components.recency).toBeCloseTo(0.5, 3);
    expect(fasterDecay[0]?.components.recency).toBeCloseTo(0.25, 3);
    const slowerResult = expectDefined(slowerDecay[0], "slower decay result");
    const fasterResult = expectDefined(fasterDecay[0], "faster decay result");
    expect(slowerResult.score).toBeGreaterThan(fasterResult.score);
  });

  it("weights fresh phase signals more than stale ones", async (workspaceDir) => {
    const results = [recall("Move backups to S3 Glacier.", "memory/2026-04-01.md")];
    await record(workspaceDir, "glacier cadence", results, {
      nowMs: Date.parse("2026-04-01T10:00:00.000Z"),
    });
    await record(workspaceDir, "backup lifecycle", results, {
      nowMs: Date.parse("2026-04-01T12:00:00.000Z"),
    });

    const rankedBaseline = await rankAll(workspaceDir, {
      nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
    });
    const key = expectDefined(rankedBaseline[0], "ranked baseline").key;

    await recordDreamingPhaseSignals({
      workspaceDir,
      phase: "rem",
      keys: [key],
      nowMs: Date.parse("2026-02-01T10:00:00.000Z"),
    });
    const staleSignalRank = await rankAll(workspaceDir, {
      nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
    });
    await recordDreamingPhaseSignals({
      workspaceDir,
      phase: "rem",
      keys: [key],
      nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
    });
    const freshSignalRank = await rankAll(workspaceDir, {
      nowMs: Date.parse("2026-04-05T10:00:00.000Z"),
    });

    expect(staleSignalRank).toHaveLength(1);
    expect(freshSignalRank).toHaveLength(1);
    const freshResult = expectDefined(freshSignalRank[0], "fresh phase-signal result");
    const staleResult = expectDefined(staleSignalRank[0], "stale phase-signal result");
    expect(freshResult.score).toBeGreaterThan(staleResult.score);
  });

  it("keeps recall stats when phase-signal state cannot be read", async (workspaceDir) => {
    const nowMs = Date.parse("2026-04-05T10:00:00.000Z");
    await record(
      workspaceDir,
      "glacier cadence",
      recall("Move backups to S3 Glacier.", "memory/2026-04-01.md"),
      { nowMs },
    );

    const env = { ...process.env };
    configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) => {
      if (options.namespace === SHORT_TERM_PHASE_SIGNAL_NAMESPACE) {
        throw new Error("phase state unavailable");
      }
      return createPluginStateKeyedStoreForTests<T>("memory-core", { ...options, env });
    });
    try {
      const stats = await loadShortTermPromotionDreamingStats({ workspaceDir, nowMs });
      expect(stats.shortTermCount).toBe(1);
      expect(stats.recallSignalCount).toBe(1);
      expect(stats.phaseSignalCount).toBe(0);
      expect(stats.phaseSignalError).toContain("phase state unavailable");
    } finally {
      await configureMemoryCoreDreamingStateForTests();
    }
  });

  it("keeps valid recall and promotion stats with malformed timestamps at the entry cap", async (workspaceDir) => {
    const nowMs = Date.parse("2026-04-05T10:00:00.000Z");
    const malformedEntries = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => {
        const key = `malformed-${index}`;
        return [
          key,
          storedRecall(key, {
            path: `memory/2026-04-01-malformed-${index}.md`,
            snippet: `Malformed timestamp entry ${index}`,
            recallCount: 100 - index,
            firstRecalledAt: "not-a-timestamp",
            lastRecalledAt: "not-a-timestamp",
          }),
        ];
      }),
    );
    await writeRecallEntries(
      workspaceDir,
      {
        ...malformedEntries,
        malformedPromotion: storedRecall("malformedPromotion", {
          path: "memory/2026-04-01-malformed-promotion.md",
          promotedAt: "not-a-timestamp",
        }),
        previousDay: storedRecall("previousDay", {
          path: "memory/2026-04-04-previous-day.md",
          promotedAt: "2026-04-04T18:00:00.000Z",
        }),
        utcDay: storedRecall("utcDay", {
          path: "memory/2026-04-05-utc-day.md",
          promotedAt: "2026-04-05T06:00:00.000Z",
        }),
        today: storedRecall("today", {
          path: "memory/2026-04-05-today.md",
          promotedAt: "2026-04-05T09:00:00.000Z",
        }),
        recent: storedRecall("recent", {
          path: "memory/2026-04-05-recent.md",
          snippet: "Recent valid timestamp entry",
          recallCount: 1,
          firstRecalledAt: "2026-04-05T09:00:00.000Z",
          lastRecalledAt: "2026-04-05T09:00:00.000Z",
        }),
      },
      "2026-04-05T10:00:00.000Z",
    );

    const stats = await loadShortTermPromotionDreamingStats({ workspaceDir, nowMs });

    expect(stats.shortTermEntries).toHaveLength(8);
    expect(stats.shortTermEntries[0]?.path).toBe("memory/2026-04-05-recent.md");
    expect(stats.shortTermEntries[1]?.path).toBe("memory/2026-04-01-malformed-0.md");
    expect(stats.shortTermEntries.map((entry) => entry.path)).not.toContain(
      "memory/2026-04-01-malformed-7.md",
    );
    expect(stats.promotedEntries).toHaveLength(4);
    expect(stats.promotedEntries).toContainEqual(
      expect.objectContaining({ key: "malformedPromotion", promotedAt: "not-a-timestamp" }),
    );
    for (const [timezone, promotedToday] of [
      ["America/Los_Angeles", 1],
      ["UTC", 2],
      ["America/Los_Angeles", 1],
    ] as const) {
      const zonedStats = await loadShortTermPromotionDreamingStats({
        workspaceDir,
        nowMs,
        timezone,
      });
      expect(zonedStats).toMatchObject({
        promotedTotal: 4,
        promotedToday,
        lastPromotedAt: "2026-04-05T09:00:00.000Z",
      });
    }
  });

  it("records spaced Unicode paths and reconciles their existing promotion markers", async (workspaceDir) => {
    await writeDailyMemoryNoteInSubdir(workspaceDir, "project alpha 日记", "2026-04-01", [
      "alpha",
      "The project alpha gateway should stay loopback-only on port 18789.",
    ]);
    await record(
      workspaceDir,
      "project alpha gateway",
      recall(
        "The project alpha gateway should stay loopback-only on port 18789.",
        "memory/project alpha 日记/2026-04-01.md",
        2,
        2,
        0.95,
      ),
    );

    const ranked = await rankAll(workspaceDir);
    expect(ranked.map((candidate) => candidate.key)).toContain(
      "memory:memory/project alpha 日记/2026-04-01.md:2:2",
    );

    const firstApply = await applyAll(workspaceDir, ranked);
    expect(firstApply.applied).toBe(1);
    expect(firstApply.appended).toBe(1);

    await clearPromotedAt(workspaceDir);

    const secondApply = await applyAll(workspaceDir, ranked);
    expect(secondApply.applied).toBe(1);
    expect(secondApply.appended).toBe(0);
    expect(secondApply.reconciledExisting).toBe(1);

    const memoryText = await readMemory(workspaceDir);
    expect(memoryText).toContain(
      "<!-- openclaw-memory-promotion:memory:memory/project alpha 日记/2026-04-01.md:2:2 -->",
    );
    expect(memoryText.match(/openclaw-memory-promotion:/g)?.length).toBe(1);
    expect(
      memoryText.match(/The project alpha gateway should stay loopback-only on port 18789\./g)
        ?.length,
    ).toBe(1);
  });

  baseIt.each([
    { name: "default thresholds", options: {} },
    {
      name: "invalid negative thresholds",
      options: { minScore: -1, minRecallCount: -1, minUniqueQueries: -1 },
    },
    { name: "expired candidate", options: { ...allPromotionThresholds, maxAgeDays: 7 } },
  ])("rejects ranking with $name", async ({ options }) => {
    await withTempWorkspace(async (workspaceDir) => {
      await record(
        workspaceDir,
        "glacier",
        recall("Move backups to S3 Glacier.", "memory/2026-04-01.md", 1, 2, 0.96),
        { nowMs: Date.parse("2026-04-01T10:00:00.000Z") },
      );
      expect(
        await rankShortTermPromotionCandidates({
          workspaceDir,
          ...options,
          nowMs: Date.parse("2026-04-15T10:00:00.000Z"),
        }),
      ).toHaveLength(0);
    });
  });

  const rejectionCases: Array<
    [
      category: string,
      candidate: Partial<PromotionCandidate>,
      options?: Omit<Parameters<typeof applyShortTermPromotions>[0], "workspaceDir" | "candidates">,
      exactReason?: string,
    ]
  > = [
    ["signal threshold", { recallCount: 1, signalCount: 1, uniqueQueries: 1 }],
    [
      "query threshold",
      { uniqueQueries: 0, recallDays: ["2026-04-01", "2026-04-02", "2026-04-03"] },
      {},
      "query threshold (0 < 3)",
    ],
    [
      "age threshold",
      { ageDays: 10, snippet: "Expired short-term note." },
      { ...allPromotionThresholds, maxAgeDays: 7 },
    ],
  ];
  baseIt.each(rejectionCases)(
    "rejects direct promotion: %s",
    async (category, candidate, options, exactReason) => {
      await withTempWorkspace(async (workspaceDir) => {
        const applied = await applyShortTermPromotions({
          workspaceDir,
          ...options,
          candidates: [
            promotionCandidateFixture({
              key: "memory:memory/2026-04-03.md:1:2",
              path: "memory/2026-04-03.md",
              startLine: 1,
              endLine: 2,
              source: "memory",
              snippet: "Move backups to S3 Glacier.",
              ...candidate,
            }),
          ],
        });
        expect(applied.applied).toBe(0);
        expect(applied.rejectedCandidates[0]?.reason).toEqual(
          exactReason ?? expect.stringContaining(category),
        );
        expect(applied.rejectedCandidates[0]?.category).toBe(category);
        await expectEnoent(readMemory(workspaceDir));
      });
    },
  );

  baseIt.each([
    { name: "marker line (#80613)", line: 5, snippet: "<!-- openclaw:dreaming:light:start -->" },
    { name: "fenced content", line: 6, snippet: "- Candidate: staged dream scratchwork" },
  ])("blocks rehydrated promotion of managed dreaming $name", async ({ line, snippet }) => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-05-18", [
        "## Plan",
        "- Keep verified backups.",
        "",
        "## Light Sleep",
        "<!-- openclaw:dreaming:light:start -->",
        "- Candidate: staged dream scratchwork",
        "<!-- openclaw:dreaming:light:end -->",
      ]);
      // Neither bare markers nor this incomplete candidate signature triggers contamination.
      await record(workspaceDir, "fenced recall", recall(snippet, "memory/2026-05-18.md", line));
      const ranked = await rankAll(workspaceDir);
      expect(ranked).toHaveLength(1);
      const applied = await applyAll(workspaceDir, ranked);
      expect(applied.applied).toBe(0);
      const memory = await readMemory(workspaceDir).catch(() => "");
      expect(memory).not.toContain("Promoted From Short-Term Memory");
      expect(memory).not.toMatch(/openclaw:dreaming|staged dream scratchwork/i);
    });
  });

  it("applies promotion candidates to MEMORY.md and marks them promoted", async (workspaceDir) => {
    const ranked = await seedGatewayPromotionCandidate(workspaceDir);
    const applied = await applyAll(workspaceDir, ranked);
    expect(applied.applied).toBe(1);

    const memoryText = await readMemory(workspaceDir);
    expect(memoryText).toContain("Promoted From Short-Term Memory");
    expect(memoryText).toContain("- Gateway binds loopback and port 18789");
    expect(memoryText).not.toContain("- - Gateway binds loopback and port 18789");
    expect(memoryText).toContain("memory/2026-04-01.md:10-10");
    expect(memoryText).toMatch(/<!-- trigger: [^\n]* --> <!-- importance: \d+ -->/u);

    const rankedAfter = await rankAll(workspaceDir);
    expect(rankedAfter).toHaveLength(0);

    const rankedIncludingPromoted = await rankAll(workspaceDir, {
      includePromoted: true,
    });
    expect(rankedIncludingPromoted).toHaveLength(1);
    expect(expectDefined(rankedIncludingPromoted[0], "promoted candidate").promotedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
    expect((await applyAll(workspaceDir, ranked)).applied).toBe(0);
    const afterRetry = await readMemory(workspaceDir);
    expect(afterRetry.match(/Promoted From Short-Term Memory/g)).toHaveLength(1);
  });

  it("does not promote a trusted recall candidate from a quarantined daily file", async (workspaceDir) => {
    const relativePath = "memory/2026-04-01.md";
    const snippet = "Gateway binds loopback and port 18789";
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [snippet]);
    await record(
      workspaceDir,
      "gateway host",
      recall(snippet, relativePath, 1, 1, 0.92, {
        provenance: {
          originClass: "agent",
          sessionKind: "unknown",
          observedAt: Date.parse("2026-04-01T12:00:00.000Z"),
        },
      }),
    );
    const ranked = await rankAll(workspaceDir);
    expect(ranked[0]?.provenance?.originClass).toBe("agent");

    vi.mocked(listMemoryArtifactProvenance).mockResolvedValueOnce([
      {
        relativePath,
        provenance: {
          fileHash: "0".repeat(64),
          originClass: "untrusted",
          observedAt: Date.parse("2026-04-01T12:05:00.000Z"),
        },
      },
    ]);

    const applied = await applyAll(workspaceDir, ranked);
    expect(applied.applied).toBe(0);
    expect(applied.rejectedCandidates[0]?.reason).toBe("origin filter (untrusted)");
    expect(applied.rejectedCandidates[0]?.category).toBe("origin");
    await expectEnoent(readMemory(workspaceDir));
  });

  it("excludes a candidate downgraded during consolidation from the fallback write", async (workspaceDir) => {
    const relativePath = "memory/2026-04-01.md";
    const firstSnippet = "Gateway binds loopback on the admin host.";
    const secondSnippet = "Backups use the encrypted archive bucket.";
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [firstSnippet, secondSnippet]);
    await record(
      workspaceDir,
      "operations policy",
      [firstSnippet, secondSnippet].map((snippet, index) => ({
        path: relativePath,
        startLine: index + 1,
        endLine: index + 1,
        score: 0.92,
        snippet,
        source: "memory" as const,
        provenance: {
          originClass: "agent" as const,
          sessionKind: "interactive" as const,
          observedAt: Date.parse("2026-04-01T12:00:00.000Z"),
        },
      })),
    );
    const ranked = await rankAll(workspaceDir);
    expect(ranked).toHaveLength(2);

    const complete = vi.fn(async () => {
      const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
      const downgraded = expectDefined(
        Object.values(store.entries).find((entry) => entry.startLine === 1),
        "downgraded recall entry",
      );
      downgraded.provenance = {
        originClass: "untrusted",
        sessionKind: "interactive",
        observedAt: Date.parse("2026-04-01T12:05:00.000Z"),
      };
      await testing.writeRawRecallStore(workspaceDir, store);
      return { text: "invalid consolidation response" };
    });
    const applied = await applyAll(workspaceDir, ranked, {
      agentId: "main",
      consolidation: {
        subagent: { complete },
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    });

    expect(complete).toHaveBeenCalledOnce();
    expect(applied.appliedCandidates.map((candidate) => candidate.startLine)).toEqual([2]);
    expect(applied.rejectedCandidates.map(({ candidate }) => candidate.startLine)).toEqual([1]);
    const memory = await readMemory(workspaceDir);
    expect(memory).not.toContain(firstSnippet);
    expect(memory).toContain(secondSnippet);
  });

  it("keeps promoted MEMORY.md entries compact while preserving provenance", async (workspaceDir) => {
    const longDailyEntry = [
      "HanJammer reviewed the dashboard state and asked for durable memory hygiene.",
      "The raw daily note also included implementation chatter, transient timings, repeated troubleshooting detail, and operational narration that should not be copied wholesale into MEMORY.md.",
      "A curated long-term memory entry should preserve the stable conclusion without hauling the whole daily journal line into bootstrap context.",
      "Extra filler keeps this source entry long enough to prove promotion output is bounded before it reaches the root memory file.",
    ].join(" ");
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", [longDailyEntry]);
    await record(
      workspaceDir,
      "memory hygiene",
      recall(longDailyEntry, "memory/2026-04-01.md", 1, 1, 0.92),
    );

    const ranked = await rankAll(workspaceDir);
    const applied = await applyAll(workspaceDir, ranked, {
      maxPromotedSnippetTokens: 55,
    });

    expect(applied.applied).toBe(1);
    const memoryText = await readMemory(workspaceDir);
    const promotedLine = memoryText
      .split("\n")
      .find((line) => line.startsWith("- HanJammer reviewed the dashboard state"));
    expect(promotedLine).toBeDefined();
    expect(promotedLine?.replace(/\s*<!--[\s\S]*?-->/gu, "").length).toBeLessThan(340);
    expect(promotedLine).toContain("...");
    expect(promotedLine).toMatch(
      /\[score=0\.\d{3} signals=1 recalls=1 avg=0\.\d{3} source=memory\/2026-04-01\.md:1-1\]/,
    );
    expect(memoryText).toMatch(/<!-- openclaw-memory-promotion:[^\n]+ -->/);
  });

  baseIt.each([
    {
      name: "nearest repeated snippet",
      lines: [
        "header",
        "Repeat backup note.",
        "gap",
        "gap",
        "gap",
        "gap",
        "gap",
        "gap",
        "Repeat backup note.",
      ],
      snippet: "Repeat backup note.",
      original: [8, 9] as const,
      relocated: [9, 10],
    },
    {
      name: "missing snippet",
      lines: ["Different note content now."],
      snippet: "Moved backups to S3 Glacier.",
      original: [1, 1] as const,
      relocated: [],
    },
  ])("rehydrates a $name before promotion", async ({ lines, snippet, original, relocated }) => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-01", lines);
      await record(
        workspaceDir,
        "glacier",
        recall(snippet, "memory/2026-04-01.md", original[0], original[1], 0.94),
      );
      const applied = await applyAll(workspaceDir, await rankAll(workspaceDir));
      expect(applied.applied).toBe(relocated.length ? 1 : 0);
      if (!relocated.length) {
        await expectEnoent(fs.access(path.join(workspaceDir, "MEMORY.md")));
        return;
      }
      expect(applied.appliedCandidates[0]?.startLine).toBe(relocated[0]);
      expect(applied.appliedCandidates[0]?.endLine).toBe(relocated[1]);
      const memoryText = await readMemory(workspaceDir);
      expect(memoryText).toContain(`memory/2026-04-01.md:${relocated[0]}-${relocated[1]}`);
    });
  });

  const longRoutingBody = `Use Mimo ${"route ".repeat(80)}`.trim();
  const firstRoutingItem = `Use Mimo ${"route ".repeat(12)}`.trim();
  const secondRoutingItem = `Preserve the fallback ${"tail ".repeat(42)}`.trim();
  const headingCases: {
    name: string;
    lines: string[];
    snippet: string;
    expected?: string;
    startLine?: number;
    endLine?: number;
    excluded?: string[];
  }[] = [
    {
      name: "single-line Unicode heading context",
      lines: ["## 模型", "- 用 Mimo。"],
      snippet: "模型: 用 Mimo。",
      expected: "模型: 用 Mimo。",
    },
    {
      name: "renamed Unicode heading",
      lines: ["## 🚀 New routing", "- Use Mimo."],
      snippet: "Old routing: Use Mimo.",
      expected: "🚀 New routing: Use Mimo.",
      excluded: ["Old routing"],
    },
    { name: "missing live body", lines: ["## Routing", ""], snippet: "Routing: Use Mimo." },
    {
      name: "ordinary list without heading context",
      lines: ["## Routing", "- Use Mimo."],
      snippet: "Use Mimo.",
      expected: "Use Mimo.",
      excluded: ["Routing:"],
    },
    {
      name: "capped daily list",
      lines: ["## Routing", `- ${longRoutingBody}`],
      snippet: `Routing: ${longRoutingBody}`.slice(0, 280).trim(),
      expected: `Routing: ${longRoutingBody}`,
    },
    {
      name: "capped renamed daily list",
      lines: ["## New routing", `- ${longRoutingBody}`],
      snippet: `Old routing: ${longRoutingBody}`.slice(0, 280).trim(),
      expected: `New routing: ${longRoutingBody}`,
      excluded: ["Old routing"],
    },
    {
      name: "colon-prefixed body beside a shorter matching list item",
      lines: ["## Shortcut", "- use Mimo", "", "## Routing", "- **需求**: use Mimo"],
      snippet: "Old routing: **需求**: use Mimo",
      expected: "Routing: **需求**: use Mimo",
      startLine: 7,
      excluded: ["Shortcut"],
    },
    {
      name: "capped multi-line range",
      lines: ["## Routing", `- ${firstRoutingItem}`, `- ${secondRoutingItem}`],
      snippet: `Routing: ${firstRoutingItem}; ${secondRoutingItem}`.slice(0, 280).trim(),
      expected: `Routing: ${firstRoutingItem}; ${secondRoutingItem}`,
      endLine: 5,
    },
    {
      name: "generic daily heading",
      lines: ["## Routing", "- Use Mimo.", "", "## Morning", "- Review travel."],
      snippet: "Review travel.",
      expected: "Review travel.",
      startLine: 7,
      excluded: ["Morning:", "Routing: Review"],
    },
    {
      name: "managed dreaming heading",
      lines: [
        "## Light Sleep",
        "<!-- openclaw:dreaming:light:start -->",
        "- Candidate: scratch",
        "<!-- openclaw:dreaming:light:end -->",
        "- Review travel.",
      ],
      snippet: "Review travel.",
      expected: "Review travel.",
      startLine: 7,
      excluded: ["Light Sleep:"],
    },
  ];
  baseIt.each(headingCases)("rehydrates $name from the live daily note", async (entry) => {
    await withTempWorkspace(async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-05-28", ["# 2026-05-28", "", ...entry.lines]);
      const applied = await promoteDailyHeadingSnippet(workspaceDir, entry);
      expect(applied.applied).toBe(entry.expected === undefined ? 0 : 1);
      if (entry.expected === undefined) {
        return;
      }
      const startLine = entry.startLine ?? 4;
      const endLine = entry.endLine ?? startLine;
      expect(applied.appliedCandidates[0]).toMatchObject({
        startLine,
        endLine,
        snippet: entry.expected,
      });
      const memoryText = await readMemory(workspaceDir);
      expect(memoryText).toContain(`memory/2026-05-28.md:${startLine}-${endLine}`);
      expect(memoryText).toContain(entry.expected);
      for (const excluded of entry.excluded ?? []) {
        expect(memoryText).not.toContain(excluded);
      }
    });
  });

  it("keeps rehydrated promotion snippets capped in the recall store", async (workspaceDir) => {
    const maxSnippetChars = testing.SHORT_TERM_RECALL_MAX_SNIPPET_CHARS;
    const longSnippet = `Moved backup policy ${"x".repeat(maxSnippetChars + 100)}`;
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["intro", longSnippet]);
    await record(
      workspaceDir,
      "backup policy",
      recall(longSnippet, "memory/2026-04-01.md", 1, 1, 0.94),
    );

    const ranked = await rankAll(workspaceDir);
    const candidateKey = expectDefined(ranked[0], "long rehydrated").key;
    const applied = await applyAll(workspaceDir, ranked);

    expect(applied.applied).toBe(1);
    expect(applied.appliedCandidates[0]?.snippet.length).toBeGreaterThan(maxSnippetChars);
    const entries = await readRecallStoreEntries(workspaceDir);
    const storedSnippet = entries[candidateKey]?.snippet ?? "";
    expect(storedSnippet.length).toBeLessThanOrEqual(maxSnippetChars);
    expect(storedSnippet).toBe(applied.appliedCandidates[0]?.snippet.slice(0, maxSnippetChars));
  });

  it("rehydrates legacy basename-only short-term paths from the memory directory", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Legacy basename path note."]);

    const applied = await applyAll(workspaceDir, [
      promotionCandidateFixture({
        key: "memory:2026-04-01.md:1:1",
        path: "2026-04-01.md",
        snippet: "Legacy basename path note.",
      }),
    ]);

    expect(applied.applied).toBe(1);
    const memoryText = await readMemory(workspaceDir);
    expect(memoryText).toContain("source=2026-04-01.md:1-1");
  });

  it("uses dreaming timezone for recall-day bucketing and promotion headers", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Router maintenance window."]);
    await record(
      workspaceDir,
      "router window",
      recall("Router maintenance window.", "memory/2026-04-01.md"),
      {
        nowMs: Date.parse("2026-04-01T23:30:00.000Z"),
        timezone: "America/Los_Angeles",
      },
    );

    const ranked = await rankAll(workspaceDir);
    expect(ranked[0]?.recallDays).toEqual(["2026-04-01"]);

    const applied = await applyAll(workspaceDir, ranked, {
      nowMs: Date.parse("2026-04-02T06:30:00.000Z"),
      timezone: "America/Los_Angeles",
    });

    expect(applied.applied).toBe(1);
    const memoryText = await readMemory(workspaceDir);
    expect(memoryText).toContain("Promoted From Short-Term Memory (2026-04-01)");
    for (const [now, promotedToday] of [
      ["2026-04-02T06:59:59.000Z", 1],
      ["2026-04-02T07:00:00.000Z", 0],
    ] as const) {
      const stats = await loadShortTermPromotionDreamingStats({
        workspaceDir,
        nowMs: Date.parse(now),
        timezone: "America/Los_Angeles",
      });
      expect(stats).toMatchObject({ promotedTotal: 1, promotedToday });
    }
  });

  it("audits and repairs invalid store metadata plus stale locks", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Router cache uses vectors."]);
    await writeRecallEntries(workspaceDir, {
      good: {
        key: "good",
        path: "memory/2026-04-01.md",
        startLine: 1,
        endLine: 2,
        source: "memory",
        snippet: "Router cache uses vectors.",
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
    });
    await testing.writeShortTermLock(workspaceDir, {
      owner: "999999:0",
      acquiredAt: Date.now() - 120_000,
    });

    const auditBefore = await auditShortTermPromotionArtifacts({ workspaceDir });
    expect(auditBefore.updatedAt).toBe("2026-04-04T00:00:00.000Z");
    expect(auditBefore.invalidEntryCount).toBe(1);
    expect(auditBefore.issues.map((issue) => issue.code)).toStrictEqual([
      "recall-store-invalid",
      "recall-lock-stale",
    ]);
    expect(auditBefore.issues.find((issue) => issue.code === "recall-lock-stale")).toStrictEqual({
      severity: "warn",
      code: "recall-lock-stale",
      message: "Short-term promotion lock appears stale.",
      fixable: true,
    });

    const repair = await repairShortTermPromotionArtifacts({ workspaceDir });
    expect(repair.changed).toBe(true);
    expect(repair.rewroteStore).toBe(true);
    expect(repair.removedStaleLock).toBe(true);

    const auditAfter = await auditShortTermPromotionArtifacts({ workspaceDir });
    expect(auditAfter.invalidEntryCount).toBe(0);
    expect(auditAfter.issues.map((issue) => issue.code)).not.toContain("recall-lock-stale");

    const repairedRaw = await testing.readRecallStore(workspaceDir, new Date().toISOString());
    expect(repairedRaw.entries.good?.conceptTags).toContain("router");
    expect(repairedRaw.entries.good?.recallDays).toEqual(["2026-04-04"]);
    expect(await repairShortTermPromotionArtifacts({ workspaceDir })).toMatchObject({
      changed: false,
      rewroteStore: false,
    });
    expect(await testing.readRecallStore(workspaceDir, new Date().toISOString())).toEqual(
      repairedRaw,
    );
  });

  it("audits and repairs dangling recall entries and their phase signals", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Live source note."]);
    await fs.mkdir(path.join(workspaceDir, "memory", "2026-04-02.md"));
    await writeRecallEntries(workspaceDir, {
      live: storedRecall("live"),
      directory: storedRecall("directory", { path: "memory/2026-04-02.md" }),
      missing: storedRecall("missing", { path: "memory/2026-04-03.md" }),
    });
    await writePhaseEntries(workspaceDir, {
      live: { key: "live", lightHits: 1, remHits: 0 },
      directory: { key: "directory", lightHits: 1, remHits: 1 },
      missing: { key: "missing", lightHits: 0, remHits: 1 },
      unrelated: { key: "unrelated", lightHits: 1, remHits: 0 },
    });

    const auditBefore = await auditShortTermPromotionArtifacts({ workspaceDir });
    expect(auditBefore.danglingEntryCount).toBe(2);
    expect(auditBefore.issues).toContainEqual({
      severity: "warn",
      code: "recall-store-dangling",
      message:
        "Short-term recall store contains 2 entries whose source file is missing or not a regular file.",
      fixable: true,
    });

    const repair = await repairShortTermPromotionArtifacts({ workspaceDir });
    expect(repair.changed).toBe(true);
    expect(repair.rewroteStore).toBe(true);
    expect(repair.removedDanglingEntries).toBe(2);
    expect(Object.keys(await readRecallStoreEntries(workspaceDir))).toEqual(["live"]);
    const phaseSignals = await testing.readPhaseSignalStore(workspaceDir, new Date().toISOString());
    expect(Object.keys(phaseSignals.entries)).toEqual(["live", "unrelated"]);

    const auditAfter = await auditShortTermPromotionArtifacts({ workspaceDir });
    expect(auditAfter.danglingEntryCount).toBe(0);
    expect(auditAfter.issues.map((issue) => issue.code)).not.toContain("recall-store-dangling");
  });

  it("fails closed before recall writes when phase-signal state cannot be read", async (workspaceDir) => {
    await writeRecallEntries(workspaceDir, {
      missing: storedRecall("missing", {
        path: "memory/2026-04-03.md",
        snippet: "Missing source recall",
      }),
    });
    const nowIso = "2026-04-05T00:00:00.000Z";
    const recallBefore = await testing.readRecallStore(workspaceDir, nowIso);
    const env = { ...process.env };
    configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) => {
      if (options.namespace === SHORT_TERM_PHASE_SIGNAL_NAMESPACE) {
        throw new Error("phase state unavailable");
      }
      return createPluginStateKeyedStoreForTests<T>("memory-core", { ...options, env });
    });
    try {
      await expect(repairShortTermPromotionArtifacts({ workspaceDir })).rejects.toThrow(
        "phase state unavailable",
      );
    } finally {
      await configureMemoryCoreDreamingStateForTests();
    }
    expect(await testing.readRecallStore(workspaceDir, nowIso)).toEqual(recallBefore);
  });

  it("converges on retry when recall and phase cleanup rolls back", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Live source note."]);
    await writeRecallEntries(workspaceDir, {
      live: storedRecall("live"),
      missing: storedRecall("missing", { path: "memory/2026-04-03.md" }),
    });
    await writePhaseEntries(workspaceDir, {
      live: { key: "live", lightHits: 1, remHits: 0 },
      missing: { key: "missing", lightHits: 0, remHits: 1 },
    });

    const db = openOpenClawStateDatabase().db;
    const workspaceKey = memoryCoreWorkspaceStateKey(workspaceDir);
    db.exec(`
      CREATE TRIGGER abort_recall_prune BEFORE DELETE ON plugin_state_entries
      WHEN OLD.plugin_id = 'memory-core'
        AND OLD.namespace = '${SHORT_TERM_PHASE_SIGNAL_NAMESPACE}'
        AND json_extract(OLD.value_json, '$.workspaceKey') = '${workspaceKey}'
        AND json_extract(OLD.value_json, '$.key') = 'missing'
      BEGIN SELECT RAISE(ABORT, 'phase cleanup unavailable'); END;
    `);
    try {
      await expect(repairShortTermPromotionArtifacts({ workspaceDir })).rejects.toMatchObject({
        cause: { message: "phase cleanup unavailable" },
      });
    } finally {
      db.exec("DROP TRIGGER abort_recall_prune");
    }

    expect(Object.keys(await readRecallStoreEntries(workspaceDir))).toEqual(["live", "missing"]);
    expect(
      Object.keys(
        (await testing.readPhaseSignalStore(workspaceDir, new Date().toISOString())).entries,
      ),
    ).toEqual(["live", "missing"]);

    await expect(repairShortTermPromotionArtifacts({ workspaceDir })).resolves.toMatchObject({
      changed: true,
      removedDanglingEntries: 1,
    });
    expect(Object.keys(await readRecallStoreEntries(workspaceDir))).toEqual(["live"]);
    expect(
      Object.keys(
        (await testing.readPhaseSignalStore(workspaceDir, new Date().toISOString())).entries,
      ),
    ).toEqual(["live"]);
  });

  it("fails closed without changing recall state when source inspection is denied", async (workspaceDir) => {
    const entry = storedRecall("protected", { snippet: "Protected source recall" });
    await writeRecallEntries(workspaceDir, { protected: entry });
    await writePhaseEntries(workspaceDir, {
      protected: { key: "protected", lightHits: 1, remHits: 1 },
    });
    const nowIso = "2026-04-05T00:00:00.000Z";
    const recallBefore = await testing.readRecallStore(workspaceDir, nowIso);
    const phaseSignalsBefore = await testing.readPhaseSignalStore(workspaceDir, nowIso);
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "stat").mockRejectedValue(permissionError);

    await expect(repairShortTermPromotionArtifacts({ workspaceDir })).rejects.toBe(permissionError);
    expect(await testing.readRecallStore(workspaceDir, nowIso)).toEqual(recallBefore);
    expect(await testing.readPhaseSignalStore(workspaceDir, nowIso)).toEqual(phaseSignalsBefore);
  });

  it("audits and repairs oversized recall stores", async (workspaceDir) => {
    await writeDailyMemoryNote(workspaceDir, "2026-04-01", ["Oversized recall source."]);
    const maxEntries = testing.SHORT_TERM_RECALL_MAX_ENTRIES;
    const maxSnippetChars = testing.SHORT_TERM_RECALL_MAX_SNIPPET_CHARS;
    await writeRecallEntries(
      workspaceDir,
      Object.fromEntries(
        Array.from({ length: maxEntries + 3 }, (_, index) => [
          `entry-${index}`,
          storedRecall(`entry-${index}`, {
            startLine: index + 1,
            endLine: index + 1,
            snippet: `Oversized recall ${index} ${"x".repeat(maxSnippetChars + 100)}`,
            recallCount: 1,
            totalScore: index,
            maxScore: 0.75,
            lastRecalledAt: new Date(Date.parse("2026-04-01T00:00:00.000Z") + index).toISOString(),
            queryHashes: [`q-${index}`],
            recallDays: ["2026-04-01"],
          }),
        ]),
      ),
    );

    const auditBefore = await auditShortTermPromotionArtifacts({ workspaceDir });
    expect(auditBefore.entryCount).toBe(maxEntries + 3);
    expect(auditBefore.issues.map((issue) => issue.code)).toContain("recall-store-over-limit");

    const repair = await repairShortTermPromotionArtifacts({ workspaceDir });

    expect(repair.changed).toBe(true);
    expect(repair.rewroteStore).toBe(true);
    expect(repair.removedOverflowEntries).toBe(3);

    const entries = Object.values(await readRecallStoreEntries(workspaceDir));
    expect(entries).toHaveLength(maxEntries);
    expect(entries.every((entry) => entry.snippet.length <= maxSnippetChars)).toBe(true);
    expect(entries.some((entry) => entry.snippet.startsWith("Oversized recall 0 "))).toBe(false);
  });

  it("lets new trusted evidence classify legacy entries without provenance", async (workspaceDir) => {
    const key = "memory:memory/2026-04-01.md:1:1";
    await writeRecallEntries(
      workspaceDir,
      {
        [key]: storedRecall(key, {
          snippet: "The owner prefers green tea.",
          recallCount: 1,
          totalScore: 0.8,
          maxScore: 0.8,
          firstRecalledAt: "2026-04-01T10:00:00.000Z",
          lastRecalledAt: "2026-04-01T10:00:00.000Z",
          queryHashes: ["legacy"],
          recallDays: ["2026-04-01"],
        }),
      },
      "2026-04-01T10:00:00.000Z",
    );
    const legacy = await testing.readRecallStore(workspaceDir, "2026-04-01T10:00:00.000Z");
    expect(legacy.entries[key]?.provenance).toBeUndefined();

    await record(
      workspaceDir,
      "tea preference",
      {
        path: "memory/2026-04-01.md",
        startLine: 1,
        endLine: 1,
        score: 0.9,
        snippet: "The owner prefers green tea.",
        source: "memory",
        provenance: {
          originClass: "owner",
          sessionKind: "interactive",
          observedAt: Date.parse("2026-04-02T10:00:00.000Z"),
        },
      },
      {
        nowMs: Date.parse("2026-04-02T10:00:00.000Z"),
      },
    );

    const updated = await testing.readRecallStore(workspaceDir, "2026-04-02T10:00:00.000Z");
    expect(updated.entries[key]?.provenance).toEqual({
      originClass: "owner",
      sessionKind: "interactive",
      observedAt: Date.parse("2026-04-02T10:00:00.000Z"),
    });
  });

  it("rejects long contaminated legacy recall entries before truncating snippets", async (workspaceDir) => {
    const maxSnippetChars = testing.SHORT_TERM_RECALL_MAX_SNIPPET_CHARS;
    await writeRecallEntries(workspaceDir, {
      contaminated: storedRecall("contaminated", {
        snippet: `Candidate: ${"x".repeat(maxSnippetChars + 100)} confidence: 9 evidence: memory/.dreams/session-corpus/2026-04-01.txt status: staged recalls: 1`,
        recallCount: 1,
        totalScore: 1,
        maxScore: 0.75,
        lastRecalledAt: "2026-04-01T00:00:00.000Z",
        queryHashes: ["q"],
        recallDays: ["2026-04-01"],
      }),
    });

    expect(await rankAll(workspaceDir)).toEqual([]);
    const repair = await repairShortTermPromotionArtifacts({ workspaceDir });
    expect(repair.changed).toBe(true);
    expect(repair.removedInvalidEntries).toBe(1);
    expect(await readRecallStoreEntries(workspaceDir)).toEqual({});
  });

  it("does not create recall state when repairing an empty workspace", async (workspaceDir) => {
    expect(await repairShortTermPromotionArtifacts({ workspaceDir })).toMatchObject({
      changed: false,
      rewroteStore: false,
    });
    const store = await testing.readRecallStore(workspaceDir, new Date().toISOString());
    expect(store).toMatchObject({ version: 1, entries: {} });
    expect(Object.keys(store.entries)).toEqual([]);
  });

  it("preserves recall updates from sequential and parallel nested workspace writers", async (workspaceDir) => {
    const result = recall("Nested workspace writers retain every recall signal.");
    await withMemoryWorkspaceLock(workspaceDir, async () => {
      await record(workspaceDir, "first", result);
      await withMemoryWorkspaceLock(workspaceDir, async () => {
        await Promise.all(["second", "third"].map((query) => record(workspaceDir, query, result)));
      });
    });

    const entries = Object.values(await readRecallStoreEntries(workspaceDir));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.recallCount).toBe(3);
  });

  baseIt.each(["root", "nested"] as const)(
    "queues work resumed from a closed %s workspace scope behind the current writer",
    async (closedScope) => {
      await withTempWorkspace(async (workspaceDir) => {
        const resume = createDeferred<void>();
        const attempted = createDeferred<void>();
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const order: string[] = [];
        const retainWork = async () => ({
          work: resume.promise.then(async () => {
            attempted.resolve();
            await withMemoryWorkspaceLock(workspaceDir, async () => {
              order.push("resumed");
            });
          }),
        });
        let retained =
          closedScope === "root"
            ? await withMemoryWorkspaceLock(workspaceDir, retainWork)
            : undefined;
        const owner = withMemoryWorkspaceLock(workspaceDir, async () => {
          if (closedScope === "nested") {
            retained = await withMemoryWorkspaceLock(workspaceDir, retainWork);
          }
          entered.resolve();
          await release.promise;
          order.push("released");
        });
        try {
          await entered.promise;
          resume.resolve();
          await attempted.promise;
          expect(order).toEqual([]);
        } finally {
          release.resolve();
          await owner;
          await retained?.work;
        }
        expect(order).toEqual(["released", "resumed"]);
      });
    },
  );

  it("reclaims a stale sqlite lock when its owner is definitely dead", async (workspaceDir) => {
    const ownerPid = 4242;
    await testing.writeShortTermLock(workspaceDir, {
      owner: `${ownerPid}:0`,
      acquiredAt: Date.now() - 120_000,
    });
    const originalIsPidDefinitelyDead = processRuntime.isPidDefinitelyDead;
    // Keep SQLite's platform and coordinator identity native while probing the synthetic owner.
    vi.spyOn(processRuntime, "isPidDefinitelyDead").mockImplementation(
      (pid) => pid === ownerPid || originalIsPidDefinitelyDead(pid),
    );

    const audit = await auditShortTermPromotionArtifacts({ workspaceDir });
    expect(audit.issues.map((issue) => issue.code)).toContain("recall-lock-stale");

    await expect(repairShortTermPromotionArtifacts({ workspaceDir })).resolves.toMatchObject({
      changed: true,
      removedStaleLock: true,
    });
  });

  it("preserves a replacement lock when the expected stale entry is no longer current", async (workspaceDir) => {
    const expected = {
      owner: "4243:stale",
      acquiredAt: Date.now() - 120_000,
    };
    const replacement = {
      owner: `${process.pid}:replacement`,
      acquiredAt: Date.now(),
    };
    const lockKey = memoryCoreWorkspaceStateKey(workspaceDir);
    const lockStore = openMemoryCoreStateStore<typeof expected>({
      namespace: SHORT_TERM_LOCK_NAMESPACE,
      maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
    });
    try {
      await lockStore.register(lockKey, replacement);
      await expect(deleteShortTermLockEntryIfCurrent(lockStore, lockKey, expected)).resolves.toBe(
        false,
      );
      await expect(lockStore.lookup(lockKey)).resolves.toEqual(replacement);
    } finally {
      await lockStore.delete(lockKey);
    }
  });

  it("reports concept tag script coverage for multilingual recalls", async (workspaceDir) => {
    await record(workspaceDir, "multilingual recalls", [
      recall("Configuration du routeur et sauvegarde Glacier.", "memory/2026-04-03.md", 1, 2, 0.93),
      recall("障害対応ルーター設定とバックアップ確認。", "memory/2026-04-04.md", 1, 2, 0.95),
    ]);
    expect(await auditShortTermPromotionArtifacts({ workspaceDir })).toMatchObject({
      conceptTaggedEntryCount: 2,
      conceptTagScripts: {
        latinEntryCount: 1,
        cjkEntryCount: 1,
        mixedEntryCount: 0,
        otherEntryCount: 0,
      },
    });
  });

  describe("MEMORY.md budget compaction (#73691)", () => {
    async function applyBudgetCompactionPromotion(workspaceDir: string) {
      const nowMs = Date.parse("2026-04-29T10:00:00.000Z");
      await recordRotateCredentialsRecall(workspaceDir);
      return await applyAll(workspaceDir, await rankAll(workspaceDir), {
        nowMs,
        memoryFileMaxChars: 1_400,
        maxPriorEntryLossFraction: 1,
      });
    }

    async function seedBudgetMemory(
      workspaceDir: string,
      firstMarker: string,
      secondMarker: string,
      between: string[] = [],
    ): Promise<string> {
      await writeDailyMemoryNote(workspaceDir, "2026-04-29", [
        "Notes",
        "",
        "Rotate credentials before deployment.",
      ]);
      const memoryPath = path.join(workspaceDir, "MEMORY.md");
      const filler = "x".repeat(600);
      await fs.writeFile(
        memoryPath,
        [
          "# Long-Term Memory",
          "",
          "## Promoted From Short-Term Memory (2026-04-10)",
          `<!-- openclaw-memory-promotion:${firstMarker} -->`,
          `- ${filler}`,
          "",
          ...between,
          "## Promoted From Short-Term Memory (2026-04-20)",
          `<!-- openclaw-memory-promotion:${secondMarker} -->`,
          `- ${filler}`,
          "",
        ].join("\n"),
        "utf-8",
      );
      return memoryPath;
    }

    baseIt.each([
      {
        name: "mixed marker-backed user text",
        first: "legacy-mixed",
        second: "legacy-generated",
        between: ["USER-AUTHORED: recovery key is paper-copy-17", ""],
        compacted: ["2026-04-20"],
        retained: ["legacy-mixed", "USER-AUTHORED: recovery key is paper-copy-17"],
        removed: ["legacy-generated"],
      },
      {
        name: "indented user ATX heading",
        first: "legacy-old",
        second: "legacy-newer",
        between: [
          "   ### Correction (added by me)",
          "The prod DB is db-2.corp.example, NOT db-1.",
          "",
        ],
        compacted: ["2026-04-10"],
        retained: [
          "   ### Correction (added by me)",
          "The prod DB is db-2.corp.example, NOT db-1.",
        ],
        removed: ["legacy-old"],
      },
      {
        name: "oldest generated section",
        first: "legacy-old",
        second: "legacy-newer",
        between: [],
        compacted: ["2026-04-10"],
        retained: [],
        removed: ["(2026-04-10)", "legacy-old"],
      },
    ])("compacts MEMORY.md with $name", async (entry) => {
      await withTempWorkspace(async (workspaceDir) => {
        const memoryPath = await seedBudgetMemory(
          workspaceDir,
          entry.first,
          entry.second,
          entry.between,
        );
        const applied = await applyBudgetCompactionPromotion(workspaceDir);
        expect(applied.applied).toBe(1);
        expect(applied.compactedSections).toBeGreaterThan(0);
        expect(applied.compactedDates).toEqual(entry.compacted);
        const memoryText = await fs.readFile(memoryPath, "utf-8");
        expect(memoryText).toContain("Rotate credentials");
        for (const text of entry.retained) {
          expect(memoryText).toContain(text);
        }
        for (const text of entry.removed) {
          expect(memoryText).not.toContain(text);
        }
      });
    });

    it("leaves MEMORY.md untouched when total stays within memoryFileMaxChars", async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-29", [
        "Notes",
        "",
        "A short snippet that fits comfortably.",
      ]);

      const memoryPath = path.join(workspaceDir, "MEMORY.md");
      const seeded = "# Long-Term Memory\n\nSome small existing content.\n";
      await fs.writeFile(memoryPath, seeded, "utf-8");
      if (process.platform !== "win32") {
        await fs.chmod(workspaceDir, 0o750);
        await fs.chmod(memoryPath, 0o640);
      }

      await record(
        workspaceDir,
        "tiny note",
        recall("A short snippet that fits comfortably.", "memory/2026-04-29.md", 3, 3, 0.92),
        { nowMs: Date.parse("2026-04-29T10:00:00.000Z") },
      );

      const ranked = await rankAll(workspaceDir);
      const applied = await applyAll(workspaceDir, ranked, {
        memoryFileMaxChars: 10_000,
      });

      expect(applied.compactedSections).toBe(0);
      expect(applied.compactedDates).toEqual([]);
      const memoryText = await fs.readFile(memoryPath, "utf-8");
      expect(memoryText).toContain("Some small existing content.");
      if (process.platform !== "win32") {
        expect((await fs.stat(workspaceDir)).mode & 0o7777).toBe(0o750);
        expect((await fs.stat(memoryPath)).mode & 0o7777).toBe(0o640);
      }
    });

    baseIt.each(["preserved content", "prior-entry loss limit"] as const)(
      "defers promotion for %s without changing MEMORY.md",
      async (reason) => {
        await withTempWorkspace(async (workspaceDir) => {
          const nowMs = Date.parse("2026-04-29T10:00:00.000Z");
          const snippet = "Deploy on Tuesday.";
          await writeDailyMemoryNote(workspaceDir, "2026-04-29", [snippet]);
          await record(
            workspaceDir,
            "deployment window",
            recall(snippet, "memory/2026-04-29.md", 1, 1, 0.95),
            { nowMs },
          );
          const ranked = await rankAll(workspaceDir);
          const memoryPath = path.join(workspaceDir, "MEMORY.md");
          const preserveUserContent = reason === "preserved content";
          const existing = preserveUserContent
            ? `# Long-Term Memory\n\n${"u".repeat(8_800)}\n`
            : ["2026-04-01", "2026-04-08", "2026-04-15", "2026-04-22"]
                .map(
                  (date, index) =>
                    `## Promoted From Short-Term Memory (${date})\n<!-- openclaw-memory-promotion:legacy-${index} -->\n- ${"x".repeat(500)}`,
                )
                .join("\n");
          await fs.writeFile(memoryPath, existing, "utf-8");
          const consolidate = vi.fn(async () => ({ text: "unused" }));
          const options = preserveUserContent
            ? {
                agentId: "main",
                memoryFileMaxChars: 9_000,
                consolidation: {
                  subagent: { complete: consolidate },
                  logger: { info: vi.fn(), warn: vi.fn() },
                },
              }
            : { memoryFileMaxChars: 1_600, maxPriorEntryLossFraction: 0.25 };
          const result = await applyAll(workspaceDir, ranked, { ...options, nowMs });
          expect(result).toMatchObject({ applied: 0, appended: 0, compactedSections: 0 });
          expect(result.rejectedCandidates).toEqual([
            expect.objectContaining({
              reason: expect.stringContaining("MEMORY.md budget exceeded"),
            }),
          ]);
          await expect(readMemory(workspaceDir)).resolves.toBe(existing);
          if (preserveUserContent) {
            expect(consolidate).toHaveBeenCalledOnce();
            await fs.writeFile(memoryPath, "# Long-Term Memory\n\n", "utf-8");
            const retried = await applyAll(workspaceDir, ranked, {
              memoryFileMaxChars: 9_000,
              nowMs: nowMs + 300_000,
            });
            expect(retried.applied).toBe(1);
            expect((await readMemory(workspaceDir)).length).toBeLessThanOrEqual(9_000);
          }
        });
      },
    );
  });

  it("defers append-only promotion when recall state changes during rehydration", async (workspaceDir) => {
    const notePath = await writeDailyMemoryNote(workspaceDir, "2026-04-29", ["Deploy on Tuesday."]);
    const recallResult = recall("Deploy on Tuesday.", "memory/2026-04-29.md");
    await record(workspaceDir, "deployment window", recallResult, {
      nowMs: Date.parse("2026-04-29T10:00:00.000Z"),
    });
    const ranked = await rankAll(workspaceDir, {
      nowMs: Date.parse("2026-04-29T10:00:00.000Z"),
    });
    const candidate = expectDefined(ranked[0], "append-only candidate");
    const originalReadFile = fs.readFile.bind(fs);
    let injectedUpdate = false;
    vi.spyOn(fs, "readFile").mockImplementation((async (
      ...args: Parameters<typeof fs.readFile>
    ) => {
      if (
        !injectedUpdate &&
        typeof args[0] === "string" &&
        path.resolve(args[0]) === path.resolve(notePath)
      ) {
        injectedUpdate = true;
        await record(
          workspaceDir,
          "Tuesday deployment",
          { ...recallResult, score: 1 },
          {
            dayBucket: "2026-04-30",
            nowMs: Date.parse("2026-04-30T10:00:00.000Z"),
          },
        );
      }
      return await originalReadFile(...args);
    }) as typeof fs.readFile);

    const applied = await applyAll(workspaceDir, ranked, {
      nowMs: Date.parse("2026-04-29T10:00:00.000Z"),
    });

    expect(applied).toMatchObject({ applied: 0, appended: 0 });
    await expect(readMemory(workspaceDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const retryable = await rankAll(workspaceDir, {
      nowMs: Date.parse("2026-04-30T10:00:00.000Z"),
    });
    expect(retryable.map((entry) => entry.key)).toContain(candidate.key);
  });

  describe("MEMORY.md atomic promotion write", () => {
    baseIt.runIf(process.platform !== "win32")(
      "preserves a dangling MEMORY.md symlink and its target directory mode",
      async () => {
        await withTempWorkspace(async (workspaceDir) => {
          await writeDailyMemoryNote(workspaceDir, "2026-04-29", ["Preserve shared memory."]);

          const aliasParent = path.join(fixtureRoot, `alias-${caseId++}`, "nested");
          const workspaceAlias = path.join(aliasParent, "workspace");
          const sharedDir = path.join(fixtureRoot, `${path.basename(workspaceDir)}-shared`);
          const linkedDir = path.join(workspaceDir, "linked");
          const intermediatePath = path.join(sharedDir, "memory-alias.md");
          const targetPath = path.join(sharedDir, `${"long".repeat(55)}\\`);
          const memoryPath = path.join(workspaceDir, "MEMORY.md");
          await fs.mkdir(aliasParent, { recursive: true });
          await fs.mkdir(path.join(sharedDir, "nested"), { recursive: true });
          await fs.chmod(sharedDir, 0o755);
          await fs.symlink(workspaceDir, workspaceAlias);
          await fs.symlink(path.join(sharedDir, "nested"), linkedDir);
          await fs.symlink(path.basename(targetPath), intermediatePath);
          await fs.symlink("invalid-target.md/", memoryPath);

          await record(
            workspaceAlias,
            "shared memory",
            recall("Preserve shared memory.", "memory/2026-04-29.md", 1, 1, 0.96),
            { nowMs: Date.parse("2026-04-29T10:00:00.000Z") },
          );
          const ranked = await rankAll(workspaceAlias);

          await expect(
            applyShortTermPromotions({
              workspaceDir: workspaceAlias,
              candidates: ranked,
              minScore: 0,
              minRecallCount: 0,
              minUniqueQueries: 0,
            }),
          ).rejects.toMatchObject({ code: "ENOENT" });
          await expectEnoent(fs.lstat(path.join(workspaceDir, "invalid-target.md")));
          await fs.unlink(memoryPath);
          await fs.symlink("linked/../memory-alias.md", memoryPath);

          await applyAll(workspaceAlias, ranked);

          expect((await fs.lstat(memoryPath)).isSymbolicLink()).toBe(true);
          expect((await fs.lstat(intermediatePath)).isSymbolicLink()).toBe(true);
          expect(await fs.readFile(targetPath, "utf-8")).toContain("Preserve shared memory.");
          expect((await fs.stat(sharedDir)).mode & 0o7777).toBe(0o755);

          const secondSnippet = "Keep shared writes.";
          const lexicalCollisionPath = path.join(workspaceDir, "memory-alias.md");
          await fs.writeFile(lexicalCollisionPath, "Do not overwrite this lexical collision.");
          await writeDailyMemoryNote(workspaceDir, "2026-04-30", [secondSnippet]);
          await record(
            workspaceAlias,
            "read-only parent",
            recall(secondSnippet, "memory/2026-04-30.md", 1, 1, 0.96),
            { nowMs: Date.parse("2026-04-30T10:00:00.000Z") },
          );
          const secondRanked = await rankAll(workspaceAlias);

          await fs.chmod(targetPath, 0o600);
          await fs.chmod(sharedDir, 0o555);
          try {
            const applied = await applyAll(workspaceAlias, secondRanked, {
              memoryFileMaxChars: 400,
              maxPriorEntryLossFraction: 1,
            });
            expect(applied.applied).toBe(1);
            expect(await fs.readFile(targetPath, "utf-8")).toContain(secondSnippet);
            expect(await fs.readFile(lexicalCollisionPath, "utf-8")).toBe(
              "Do not overwrite this lexical collision.",
            );
            expect((await fs.stat(sharedDir)).mode & 0o7777).toBe(0o555);
          } finally {
            await fs.chmod(sharedDir, 0o755);
          }
        });
      },
    );

    it("preserves the existing MEMORY.md when the promotion write fails mid-flight", async (workspaceDir) => {
      await writeDailyMemoryNote(workspaceDir, "2026-04-29", [
        "Notes",
        "",
        "Rotate credentials before deployment.",
      ]);

      const memoryPath = path.join(workspaceDir, "MEMORY.md");
      const sentinel = "FINAL-USER-MEMORY-SENTINEL-do-not-lose";
      const filler = "pad line filler content ".repeat(9_000);
      const seeded = `# Long-Term Memory\n\n${filler}\n- ${sentinel}\n`;
      await fs.writeFile(memoryPath, seeded, "utf-8");

      await recordRotateCredentialsRecall(workspaceDir);

      const ranked = await rankAll(workspaceDir);

      const truncateAt = 51_200;
      const originalOpen = fs.open.bind(fs);
      const originalWriteFile = fs.writeFile.bind(fs);
      const promotionTempHandles = new WeakSet<object>();
      vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
        const handle = await originalOpen(target, flags, mode);
        if (typeof target === "string" && path.basename(target).startsWith("MEMORY.md.promotion")) {
          promotionTempHandles.add(handle);
        }
        return handle;
      });
      vi.spyOn(fs, "writeFile").mockImplementation((async (
        target: Parameters<typeof fs.writeFile>[0],
        data: Parameters<typeof fs.writeFile>[1],
        options?: Parameters<typeof fs.writeFile>[2],
      ) => {
        const targetPath =
          typeof target === "string" ? target : target instanceof URL ? target.pathname : "";
        if (
          (targetPath && path.basename(targetPath).startsWith("MEMORY.md")) ||
          (typeof target === "object" && target !== null && promotionTempHandles.has(target))
        ) {
          const text = typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString();
          await originalWriteFile(target, text.slice(0, truncateAt), options);
          throw Object.assign(new Error("EFBIG: file too large, write"), {
            code: "EFBIG",
          });
        }
        return originalWriteFile(target, data, options);
      }) as typeof fs.writeFile);

      await expect(
        applyShortTermPromotions({
          workspaceDir,
          candidates: ranked,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
          nowMs: Date.parse("2026-04-29T10:00:00.000Z"),
          memoryFileMaxChars: 5_000_000,
        }),
      ).rejects.toMatchObject({ code: "EFBIG" });

      const after = await fs.readFile(memoryPath, "utf-8");
      expect(after).toBe(seeded);
      await expect(
        rankShortTermPromotionCandidates({
          workspaceDir,
          minScore: 0,
          minRecallCount: 0,
          minUniqueQueries: 0,
        }),
      ).resolves.toHaveLength(1);
      expect(
        (await fs.readdir(workspaceDir)).filter((entry) => entry.startsWith("MEMORY.md.promotion")),
      ).toEqual([]);
    });
  });

  describe("UTF-16 snippet bounds", () => {
    it("keeps the dreaming narrative lead well-formed at a surrogate boundary", async (workspaceDir) => {
      const prefix = "x".repeat(199);
      const snippet = `${prefix}🚀Candidate: durable memory`;
      const originalRegExpTest = Object.getOwnPropertyDescriptor(RegExp.prototype, "test")
        ?.value as typeof RegExp.prototype.test;
      const inspectedLeads: string[] = [];

      vi.spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, value: string) {
        if (this.source === "\\b(?:Candidate|Reflections?):") {
          inspectedLeads.push(value);
          expect(Buffer.from(value, "utf8").toString("utf8")).toBe(value);
        }
        return originalRegExpTest.call(this, value);
      });

      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [snippet]);
      await record(workspaceDir, "utf16 dreaming lead", recall(snippet));

      const ranked = await rankAll(workspaceDir);

      expect(inspectedLeads.length).toBeGreaterThan(0);
      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.snippet).toBe(snippet);
    });

    it("writes a complete-code-point promoted MEMORY.md snippet", async (workspaceDir) => {
      const prefix = "a".repeat(7);
      const snippet = `${prefix}🚀tail`;
      await writeDailyMemoryNote(workspaceDir, "2026-04-03", [snippet]);
      await record(workspaceDir, "utf16 promotion", recall(snippet));
      const ranked = await rankAll(workspaceDir);

      await applyAll(workspaceDir, ranked, {
        maxPromotedSnippetTokens: 2,
      });

      const memoryText = await readMemory(workspaceDir);
      expect(memoryText).toContain(`- ${prefix}... [`);
      expect(memoryText).not.toContain("🚀");
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
