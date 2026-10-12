import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  listMemoryArtifactProvenance,
  resolveMemoryDreamingPluginConfig,
  resolveSessionTranscriptsDirForAgent,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeSessionIngestionState } from "./dreaming-ingestion-state.js";
import {
  previewRemDreaming,
  runDreamingSweepPhases,
  seedHistoricalDailyMemorySignals,
} from "./dreaming-phases.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import { previewRemHarness } from "./rem-harness.js";
import { appendSessionCorpusLines } from "./session-ingestion.js";
import { makeMessage, withSessionAdmissionReadBudget } from "./session-ingestion.test-support.js";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
} from "./short-term-promotion.js";
import {
  createMemoryCoreTestHarness,
  dreamingTestState,
  shortTermTestState as shortTermTesting,
} from "./test-helpers.js";

vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", { spy: true });

const { createTempWorkspace } = createMemoryCoreTestHarness();
const BASE_TIME = new Date("2026-04-05T10:00:00.000Z");
const DAY = "2026-04-05";
const provenanceMock = vi.mocked(listMemoryArtifactProvenance);
provenanceMock.mockResolvedValue([]);
function dreamingConfig(dreaming: Record<string, unknown>): OpenClawConfig {
  return { plugins: { entries: { "memory-core": { config: { dreaming } } } } };
}

const INLINE_CONFIG: OpenClawConfig = dreamingConfig({
  enabled: true,
  timezone: "UTC",
  // Exercise inline output explicitly; separate storage is the product default.
  storage: { mode: "inline", separateReports: false },
  phases: {
    light: {
      enabled: true,
      limit: 20,
      lookbackDays: 2,
    },
  },
});

function setStateDir(stateDir: string): void {
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  clearRuntimeConfigSnapshot();
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearRuntimeConfigSnapshot();
  provenanceMock.mockReset();
  provenanceMock.mockResolvedValue([]);
});

function mockUntrustedMemoryArtifact(params: {
  relativePath: string;
  content: string;
  observedAt: number;
}): void {
  provenanceMock.mockResolvedValue([
    {
      relativePath: params.relativePath,
      provenance: {
        fileHash: createHash("sha256").update(params.content).digest("hex"),
        originClass: "untrusted",
        observedAt: params.observedAt,
      },
    },
  ]);
}

function candidateKey(candidates: Array<{ key: string; path: string }>, sourcePath: string) {
  return expectDefined(
    candidates.find((entry) => entry.path === sourcePath),
    sourcePath,
  ).key;
}

async function seedTranscript(params: {
  messages: Array<{
    role: "assistant" | "user";
    content: unknown;
    owner?: boolean;
    timestamp: number | string;
  }>;
  sessionId: string;
  hookExternalContentSource?: "gmail" | "webhook";
}): Promise<void> {
  const agentId = "main";
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const storePath = path.join(sessionsDir, "sessions.json");
  const sessionKey = `agent:${agentId}:chat:${params.sessionId}`;
  const timestamps = params.messages
    .map((message) =>
      typeof message.timestamp === "number" ? message.timestamp : Date.parse(message.timestamp),
    )
    .filter((timestamp) => Number.isFinite(timestamp));
  // Accessor writes run normal maintenance; keep fixture entries fresh while
  // retaining per-message timestamps as the dreaming corpus clock.
  const updatedAt = Math.max(Date.now(), ...timestamps);
  await fs.mkdir(sessionsDir, { recursive: true });
  const registration = {
    agentId,
    sessionKey,
    storePath,
    entry: {
      sessionId: params.sessionId,
      updatedAt,
      ...(params.hookExternalContentSource
        ? { hookExternalContentSource: params.hookExternalContentSource }
        : {}),
    },
  };
  await upsertSessionEntry(registration);
  for (const message of params.messages) {
    await appendSessionTranscriptMessageByIdentity({
      agentId,
      sessionId: params.sessionId,
      sessionKey,
      storePath,
      message: {
        role: message.role,
        content: message.content,
        ...(message.owner ? { __openclaw: { senderIsOwner: true } } : {}),
        timestamp: message.timestamp,
      },
    });
  }
  await upsertSessionEntry(registration);
}

function corpusPath(workspaceDir: string, day = DAY) {
  return path.join(workspaceDir, "memory", ".dreams", "session-corpus", `${day}.txt`);
}

function createHarness(config: OpenClawConfig, workspaceDir: string) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const cfg = {
    ...config,
    agents: {
      ...config.agents,
      defaults: { ...config.agents?.defaults, workspace: workspaceDir, userTimezone: "UTC" },
    },
  };
  const pluginConfig = resolveMemoryDreamingPluginConfig(cfg) ?? {};
  const dreaming = (pluginConfig.dreaming ?? {}) as Record<string, unknown>;
  const phases = (dreaming.phases ?? {}) as Record<string, unknown>;
  const light = (phases.light ?? {}) as Record<string, unknown>;
  const rem = (phases.rem ?? {}) as Record<string, unknown>;
  const sweep = (phase: "light" | "rem" = "light") =>
    runDreamingSweepPhases({
      agentId: "main",
      workspaceDir,
      cfg,
      logger,
      pluginConfig: {
        ...pluginConfig,
        dreaming: {
          ...dreaming,
          phases: {
            ...phases,
            light: { ...light, enabled: phase === "light" && light.enabled !== false },
            rem: { ...rem, enabled: phase === "rem" && rem.enabled !== false },
          },
        },
      },
    });
  return { sweep, logger };
}

function setTime(offsetMinutes = 0) {
  vi.setSystemTime(new Date(BASE_TIME.getTime() + offsetMinutes * 60_000));
}

async function withClock(run: () => Promise<void>) {
  // Worker lifecycle deadlines share real monotonic time; only dreaming's wall clock is synthetic.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

async function writeDailyNote(workspaceDir: string, lines: string[]): Promise<void> {
  await fs.writeFile(path.join(workspaceDir, "memory", `${DAY}.md`), lines.join("\n"), "utf-8");
}

function dailyCapStressLines(label: string): string[] {
  return Array.from({ length: 8 }).flatMap((_, index) => [
    `- ${label} durable memory item ${index + 1} has enough detail to create a chunk.`,
    "",
  ]);
}

async function createWorkspace(): Promise<string> {
  const workspaceDir = await createTempWorkspace("openclaw-dreaming-phases-");
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  return workspaceDir;
}

function createDailyHarness(
  workspaceDir: string,
  options: {
    includeMainAgent?: boolean;
    limit?: number;
    lookbackDays?: number;
    memorySearchEnabled?: boolean;
  } = {},
) {
  return createHarness(
    {
      ...dreamingConfig({
        enabled: true,
        phases: {
          light: {
            enabled: true,
            limit: options.limit ?? 20,
            lookbackDays: options.lookbackDays ?? 7,
          },
        },
      }),
      ...(options.includeMainAgent
        ? { agents: { entries: { main: { workspace: workspaceDir } } } }
        : {}),
      ...(options.memorySearchEnabled === false ? { memory: { search: { enabled: false } } } : {}),
    },
    workspaceDir,
  );
}

async function sweepLight(sweep: ReturnType<typeof createHarness>["sweep"], offsetMinutes: number) {
  setTime(offsetMinutes);
  await sweep();
}

async function runLight(sweep: ReturnType<typeof createHarness>["sweep"], minute = 5) {
  await withClock(async () => {
    await sweepLight(sweep, minute);
  });
}

function rankCandidates(workspaceDir: string, nowMs: number) {
  return rankShortTermPromotionCandidates({
    workspaceDir,
    minScore: 0,
    minRecallCount: 0,
    minUniqueQueries: 0,
    nowMs,
  });
}

async function readCandidateSnippets(workspaceDir: string, nowIso: string): Promise<string[]> {
  const candidates = await rankCandidates(workspaceDir, Date.parse(nowIso));
  return candidates.map((candidate) => candidate.snippet);
}

async function seedRemRecallSources(
  workspaceDir: string,
  noteDay: string,
  nowMs: number,
  staleSnippet = "Documented Ollama provider setup.",
): Promise<void> {
  const livePath = `memory/${noteDay}.md`;
  const liveSnippet = "Move backups to S3 Glacier.";
  await fs.writeFile(path.join(workspaceDir, livePath), `${liveSnippet}\n`, "utf-8");
  for (const source of [
    { query: "live backup", path: livePath, line: 1, score: 0.91, snippet: liveSnippet },
    {
      query: "stale provider setup",
      path: "memory/.dreams/session-corpus/2026-04-16.txt",
      line: 2,
      score: 0.88,
      snippet: staleSnippet,
    },
  ]) {
    await recordShortTermRecalls({
      workspaceDir,
      query: source.query,
      nowMs,
      results: [
        {
          path: source.path,
          startLine: source.line,
          endLine: source.line,
          score: source.score,
          snippet: source.snippet,
          source: "memory",
        },
      ],
    });
  }
}

describe("memory-core dreaming phases", () => {
  it("ranks a valid duplicate ahead of an invalid dreaming timestamp", async () => {
    const workspaceDir = await createWorkspace();
    const now = new Date("2026-04-15T12:00:00.000Z");
    const snippet = "Use bounded retries for provider requests.";
    const sourcePath = "memory/.dreams/session-corpus/2026-04-14.txt";
    await fs.mkdir(path.dirname(path.join(workspaceDir, sourcePath)), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, sourcePath), `${snippet}\n`, "utf-8");
    const entry = {
      path: sourcePath,
      startLine: 1,
      endLine: 1,
      source: "memory",
      snippet,
      recallCount: 1,
      dailyCount: 0,
      groundedCount: 0,
      totalScore: 0.9,
      maxScore: 0.9,
      firstRecalledAt: "2026-04-14T12:00:00.000Z",
      queryHashes: ["query"],
      recallDays: ["2026-04-14"],
      conceptTags: ["bounded", "retries"],
    };
    await shortTermTesting.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: now.toISOString(),
      entries: {
        invalid: { ...entry, key: "invalid", lastRecalledAt: "not-a-date" },
        valid: { ...entry, key: "valid", lastRecalledAt: "2026-04-14T12:00:00.000Z" },
      },
    });
    expect(
      Object.keys(
        (await shortTermTesting.readRecallStore(workspaceDir, now.toISOString())).entries,
      ),
    ).toEqual(["invalid", "valid"]);
    const { sweep, logger } = createHarness(
      dreamingConfig({
        enabled: true,
        timezone: "UTC",
        storage: { mode: "inline", separateReports: false },
        phases: {
          light: { enabled: true, limit: 1, lookbackDays: 3, dedupeSimilarity: 0.9 },
        },
      }),
      workspaceDir,
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      await sweep();
    } finally {
      vi.useRealTimers();
    }

    expect(logger.error).not.toHaveBeenCalled();
    const phaseSignals = await shortTermTesting.readPhaseSignalStore(
      workspaceDir,
      now.toISOString(),
    );
    expect(Object.keys(phaseSignals.entries)).toEqual(["valid"]);
  });

  it("does not re-ingest managed light dreaming blocks from daily notes", async () => {
    const workspaceDir = await createWorkspace();
    await withClock(async () => {
      await writeDailyNote(workspaceDir, [
        `# ${DAY}`,
        "",
        "- Move backups to S3 Glacier.",
        "- Keep retention at 365 days.",
      ]);

      const { sweep } = createHarness(INLINE_CONFIG, workspaceDir);
      const candidateCounts: number[] = [];
      const candidateSnippets: string[][] = [];
      for (let run = 0; run < 3; run += 1) {
        await sweepLight(sweep, run + 1);
        candidateSnippets.push(
          await readCandidateSnippets(workspaceDir, `2026-04-05T10:0${run + 1}:00.000Z`),
        );
        candidateCounts.push(candidateSnippets.at(-1)?.length ?? 0);
      }

      expect(candidateCounts).toEqual([2, 2, 2]);
      for (const snippets of candidateSnippets) {
        expect(snippets).toEqual(
          expect.arrayContaining(["Move backups to S3 Glacier.", "Keep retention at 365 days."]),
        );
      }

      const dailyContent = await fs.readFile(
        path.join(workspaceDir, "memory", `${DAY}.md`),
        "utf-8",
      );
      expect(dailyContent).toContain("## Light Sleep");
      expect(dailyContent).toContain("- No notable updates.");
      expect(dailyContent.match(/^- Candidate:/gm) ?? []).toHaveLength(0);
      expect(dailyContent).not.toContain("Light Sleep: Candidate:");
      const dailyPath = path.join(workspaceDir, "memory", `${DAY}.md`);
      await fs.appendFile(dailyPath, "\n## Ops\n- Rotate access keys.\n");
      await sweepLight(sweep, 61);
      expect(await fs.readFile(dailyPath, "utf-8")).toContain(
        "- Candidate: Ops: Rotate access keys.",
      );
    });
  });

  it.each(["## Ops"])("does not ingest nested REM output before boundary %s", async (boundary) => {
    const workspaceDir = await createWorkspace();
    await withClock(async () => {
      await writeDailyNote(workspaceDir, [
        `# ${DAY}`,
        "- Move backups to S3 Glacier.",
        "",
        "## REM Sleep",
        "<!-- openclaw:dreaming:rem:start -->",
        "### Reflections",
        "- Theme: `across` kept surfacing across 26 memories.",
        "#### Unexpected nested heading",
        "- Old generated dream text must not become a daily memory.",
        "### Possible Lasting Truths",
        "- Old generated lasting truth must not become a daily memory.",
        boundary,
        "### User follow-up",
        "- Rotate access keys.",
      ]);
      const { sweep } = createHarness(INLINE_CONFIG, workspaceDir);
      await sweepLight(sweep, 1);
      const store = await shortTermTesting.readRecallStore(
        workspaceDir,
        "2026-04-05T10:01:00.000Z",
      );
      expect(Object.values(store.entries).map((entry) => entry.snippet)).toEqual([
        "Move backups to S3 Glacier.",
        "User follow-up: Rotate access keys.",
      ]);
    });
  });

  it("prefers a fresh light snippet outside the top diary-covered candidates", async () => {
    const workspaceDir = await createWorkspace();
    const stalePath = path.join(workspaceDir, "memory", "2026-04-03.md");
    const freshPath = path.join(workspaceDir, "memory", "2026-04-04.md");
    const nowMs = Date.parse("2026-04-05T10:05:00.000Z");
    const staleSnippets = [
      "初次见面时，我第一次醒来并认识了主人。",
      "The first morning began beside a quiet terminal.",
      "An early config file felt like the first map of home.",
      "The initial heartbeat made the empty workspace feel awake.",
    ];
    await fs.writeFile(stalePath, `${staleSnippets.join("\n")}\n`, "utf-8");
    await fs.writeFile(
      freshPath,
      "Later routing notes: queue hydration changed after plugin reload.\n",
      "utf-8",
    );
    const freshSnippet = "Later routing notes: queue hydration changed after plugin reload.";
    for (const [index, snippet] of [...staleSnippets, freshSnippet].entries()) {
      const fresh = index === staleSnippets.length;
      const line = fresh ? 1 : index + 1;
      for (let recall = 0; recall < (fresh ? 1 : staleSnippets.length - index); recall += 1) {
        await recordShortTermRecalls({
          workspaceDir,
          nowMs,
          query: `diary-${index}-${recall}`,
          results: [
            {
              path: `memory/${fresh ? "2026-04-04" : "2026-04-03"}.md`,
              startLine: line,
              endLine: line,
              score: fresh ? 0.91 : 0.93,
              snippet,
              source: "memory",
            },
          ],
        });
      }
    }
    await fs.writeFile(
      path.join(workspaceDir, "DREAMS.md"),
      [
        "# Dream Diary",
        "",
        "<!-- openclaw:dreaming:diary:start -->",
        ...staleSnippets.flatMap((snippet, index) => [
          "---",
          "",
          `*April ${index + 1}, 2026, 10:00 AM UTC*`,
          "",
          snippet,
          "",
        ]),
        "<!-- openclaw:dreaming:diary:end -->",
        "",
      ].join("\n"),
      "utf-8",
    );
    let prepared: Awaited<ReturnType<typeof runDreamingSweepPhases>> | undefined;
    const { sweep } = createHarness(
      dreamingConfig({
        enabled: true,
        timezone: "UTC",
        model: "anthropic/claude-sonnet-4-6",
        storage: { mode: "inline", separateReports: false },
        phases: {
          light: { enabled: true, limit: 1, lookbackDays: 7 },
          rem: { enabled: false, limit: 0, lookbackDays: 7 },
        },
      }),
      workspaceDir,
    );
    await withClock(async () => {
      vi.setSystemTime(nowMs);
      prepared = await sweep();
    });

    const data = expectDefined(prepared?.narratives[0]?.data, "prepared light narrative");
    expect(data.snippets).toContain(
      "Later routing notes: queue hydration changed after plugin reload.",
    );
    expect(data.recentDiaryEntries).toEqual(staleSnippets.toReversed());
    expect(data.snippets).not.toContain("初次见面时，我第一次醒来并认识了主人。");
  });

  it("retains current unvisited daily checkpoints and prunes notes outside lookback", async () => {
    const workspaceDir = await createWorkspace();
    const files = [
      "2026-04-05.md",
      "2026-04-05-alpha.md",
      "2026-04-05-beta.md",
      "2026-04-05-delta.md",
      "2026-04-05-gamma.md",
    ];
    for (const fileName of files) {
      await fs.writeFile(
        path.join(workspaceDir, "memory", fileName),
        `- Initial ${fileName} checkpoint has enough detail to ingest.\n`,
        "utf-8",
      );
    }
    const oldRelativePath = "memory/2026-03-16.md";
    const gammaRelativePath = "memory/2026-04-05-gamma.md";
    await fs.writeFile(
      path.join(workspaceDir, oldRelativePath),
      "- Historical kiln inspection records belong in the blue archive.\n",
      "utf-8",
    );
    const initialHarness = createDailyHarness(workspaceDir, {
      limit: 1,
      lookbackDays: 30,
    });
    const narrowedHarness = createDailyHarness(workspaceDir, {
      limit: 1,
      lookbackDays: 2,
    });

    await withClock(async () => {
      await sweepLight(initialHarness.sweep, 0);
      const initial = await dreamingTestState.readDailyIngestionState(workspaceDir);
      expect(initial.files[oldRelativePath]).toBeDefined();
      expect(initial.files[gammaRelativePath]).toBeDefined();

      for (const fileName of files.slice(0, -1)) {
        await fs.writeFile(
          path.join(workspaceDir, "memory", fileName),
          dailyCapStressLines(`Updated ${fileName}`).join("\n"),
          "utf-8",
        );
      }

      await sweepLight(narrowedHarness.sweep, 1);
      const capped = await dreamingTestState.readDailyIngestionState(workspaceDir);
      expect(capped.files[oldRelativePath]).toBeUndefined();
      expect(capped.files[gammaRelativePath]).toEqual(initial.files[gammaRelativePath]);

      await sweepLight(narrowedHarness.sweep, 2);
      const recalls = await shortTermTesting.readRecallStore(
        workspaceDir,
        new Date(BASE_TIME.getTime() + 2 * 60_000).toISOString(),
      );
      expect(
        Object.values(recalls.entries).find((entry) => entry.path === gammaRelativePath),
      ).toMatchObject({
        dailyCount: 1,
      });
      expect(
        Object.values(recalls.entries).find((entry) => entry.path === oldRelativePath),
      ).toMatchObject({
        dailyCount: 1,
      });
    });
  });

  it("drops a daily checkpoint when its file disappears before stat", async () => {
    const workspaceDir = await createWorkspace();
    const removedRelativePath = "memory/2026-04-05-alpha.md";
    const keptRelativePath = "memory/2026-04-05-beta.md";
    const removedPath = path.join(workspaceDir, removedRelativePath);
    await fs.writeFile(removedPath, "- Alpha archive keeps signed delivery receipts.\n", "utf-8");
    await fs.writeFile(
      path.join(workspaceDir, keptRelativePath),
      "- Beta workshop stores the copper gauge in cabinet seven.\n",
      "utf-8",
    );
    const { sweep } = createDailyHarness(workspaceDir, {
      limit: 1,
      lookbackDays: 2,
    });

    await withClock(async () => {
      await sweepLight(sweep, 0);
      const initial = await dreamingTestState.readDailyIngestionState(workspaceDir);
      expect(initial.files[removedRelativePath]).toBeDefined();
      expect(initial.files[keptRelativePath]).toBeDefined();

      const stat = fs.stat.bind(fs);
      let removed = false;
      const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
        if (!removed && args[0] === removedPath) {
          removed = true;
          await fs.unlink(removedPath);
        }
        return await stat(...args);
      });
      try {
        await sweepLight(sweep, 1);
      } finally {
        statSpy.mockRestore();
      }

      expect(removed).toBe(true);
      const after = await dreamingTestState.readDailyIngestionState(workspaceDir);
      expect(after.files[removedRelativePath]).toBeUndefined();
      expect(after.files[keptRelativePath]).toEqual(initial.files[keptRelativePath]);
      const recalls = await shortTermTesting.readRecallStore(
        workspaceDir,
        new Date(BASE_TIME.getTime() + 60_000).toISOString(),
      );
      expect(
        Object.values(recalls.entries).find((entry) => entry.path === keptRelativePath),
      ).toMatchObject({
        dailyCount: 1,
      });
    });
  });

  it("prioritizes the date-only daily file before same-day slugged files during historical seeding", async () => {
    const workspaceDir = await createWorkspace();
    const canonicalPath = path.join(workspaceDir, "memory", "2026-04-05.md");
    await fs.writeFile(
      canonicalPath,
      dailyCapStressLines("Canonical seeded note").join("\n"),
      "utf-8",
    );
    const sluggedPaths: string[] = [];
    for (const slug of ["alpha", "beta", "gamma", "delta"]) {
      const sluggedPath = path.join(workspaceDir, "memory", `2026-04-05-${slug}.md`);
      sluggedPaths.push(sluggedPath);
      await fs.writeFile(
        sluggedPath,
        dailyCapStressLines(`Seeded slugged ${slug}`).join("\n"),
        "utf-8",
      );
    }

    await seedHistoricalDailyMemorySignals({
      workspaceDir,
      filePaths: [...sluggedPaths, canonicalPath],
      limit: 1,
      nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
      timezone: "UTC",
    });

    const after = await rankCandidates(workspaceDir, Date.parse("2026-04-05T10:05:00.000Z"));
    expect(after.some((entry) => entry.path === "memory/2026-04-05.md")).toBe(true);
    expect(after.some((entry) => entry.snippet.includes("Canonical seeded note"))).toBe(true);
  });

  it("checkpoints session transcript ingestion and skips unchanged transcripts", async () => {
    const workspaceDir = await createWorkspace();
    setStateDir(path.join(workspaceDir, ".state"));
    const transcriptName = `dreaming-${"x".repeat(48)}`;
    const snippetTranscriptName = "snippet-boundary";
    const renderedSource = `[main/sessions/main/${transcriptName}#L4] `;
    const renderedPadding = "r".repeat(343 - renderedSource.length - "User: ".length);
    const snippetPadding = "s".repeat(273);
    await seedTranscript({
      sessionId: transcriptName,
      messages: [
        makeMessage("user", "2026-04-05T18:01:00.000Z", [
          {
            type: "text",
            text: "Move backups to S3 Glacier. OPENAI_API_KEY=sk-1234567890abcdef",
          },
        ]),
        makeMessage("assistant", "2026-04-05T18:02:00.000Z", [
          { type: "text", text: "Set retention to 365 days." },
        ]),
        makeMessage("user", "2026-04-05T18:03:00.000Z", [
          { type: "text", text: `${renderedPadding}🎉 omitted tail` },
        ]),
      ],
    });
    await seedTranscript({
      sessionId: snippetTranscriptName,
      messages: [
        makeMessage("user", "2026-04-05T18:04:00.000Z", [
          { type: "text", text: `${snippetPadding}🌍 omitted tail` },
        ]),
      ],
    });
    const { sweep } = createDailyHarness(workspaceDir, {
      includeMainAgent: true,
      memorySearchEnabled: false,
    });

    let firstSessionIngestion;
    await withClock(async () => {
      await sweepLight(sweep, 5);
      firstSessionIngestion = await dreamingTestState.readSessionIngestionState(workspaceDir);
      await sweepLight(sweep, 6);
    });

    const sessionIngestion = await dreamingTestState.readSessionIngestionState(workspaceDir);
    expect(firstSessionIngestion).toStrictEqual(sessionIngestion);
    expect(Object.keys(sessionIngestion.files)).toContain(`main:sessions/main/${transcriptName}`);
    expect(Object.keys(sessionIngestion.seenMessages)).toContain(
      `main:sessions/main/${transcriptName}`,
    );
    const corpusFile = corpusPath(workspaceDir);
    const corpus = await fs.readFile(corpusFile, "utf-8");
    expect(corpus).toContain("Move backups to S3 Glacier.");
    expect(corpus).not.toContain("OPENAI_API_KEY=sk-1234567890abcdef");
    expect(corpus).toContain("OPENAI_API_KEY=***");
    expect(corpus).toContain("Set retention to 365 days.");
    expect(corpus).toContain(`${renderedSource}User: ${renderedPadding}\n`);
    expect(corpus).toContain(
      `[main/sessions/main/${snippetTranscriptName}#L2] User: ${snippetPadding}\n`,
    );
    expect(corpus).not.toContain("🎉");
    expect(corpus).not.toContain("🌍");

    // Unmarked messages remain untrusted even though they enter the recall store.
    const store = await shortTermTesting.readRecallStore(workspaceDir, "2026-04-05T19:00:00.000Z");
    const recalled = Object.values(store.entries).filter((entry) =>
      entry.path.includes("session-corpus"),
    );
    expect(recalled.map((entry) => entry.path)).toContain(
      "memory/.dreams/session-corpus/2026-04-05.txt",
    );
    for (const entry of recalled) {
      expect(entry.provenance).toMatchObject({
        originClass: "untrusted",
        sessionKind: "interactive",
      });
    }
    const snippets = recalled.map((entry) => entry.snippet);
    expect(snippets.join("\n")).toContain("Move backups to S3 Glacier.");
    expect(snippets.join("\n")).toContain("Set retention to 365 days.");
    const ranked = await rankCandidates(workspaceDir, Date.parse("2026-04-05T19:00:00.000Z"));
    expect(ranked).toHaveLength(0);
  });

  it("records policy exclusions and keeps forgotten sessions excluded after policy removal and resweeps", async () => {
    const workspaceDir = await createWorkspace();
    setStateDir(path.join(workspaceDir, ".state"));
    await seedTranscript({
      sessionId: "gmail-session",
      hookExternalContentSource: "gmail",
      messages: [
        makeMessage("user", "2026-04-05T18:01:00.000Z", "Never retain this imported Gmail claim."),
      ],
    });
    await seedTranscript({
      sessionId: "trusted-session",
      messages: [
        makeMessage("user", "2026-04-05T18:02:00.000Z", "Keep this trusted interactive claim."),
      ],
    });

    const excludedConfig: OpenClawConfig = {
      agents: { entries: { main: { workspace: workspaceDir } } },
      plugins: {
        entries: {
          "memory-core": {
            config: {
              memoryPolicy: { excludeSessions: { hookExternalContentSources: ["gmail"] } },
              dreaming: {
                enabled: true,
                phases: { light: { enabled: true, limit: 20, lookbackDays: 7 } },
              },
            },
          },
        },
      },
    };
    const excludedHarness = createHarness(excludedConfig, workspaceDir);
    const corpusFile = corpusPath(workspaceDir);

    await withSessionAdmissionReadBudget(() => runLight(excludedHarness.sweep), 1);
    const excludedState = await dreamingTestState.readSessionIngestionState(workspaceDir);
    expect(excludedState.files["main:sessions/main/gmail-session"]).toMatchObject({
      contentHash: "",
      lineCount: 0,
      excludedReason: "hookExternalContentSource:gmail",
    });
    expect(excludedState.seenMessages).not.toHaveProperty("main:sessions/main/gmail-session");
    expect(await fs.readFile(corpusFile, "utf-8")).toContain(
      "Keep this trusted interactive claim.",
    );
    expect(await fs.readFile(corpusFile, "utf-8")).not.toContain(
      "Never retain this imported Gmail claim.",
    );

    const admittedHarness = createDailyHarness(workspaceDir, {
      includeMainAgent: true,
    });
    await withSessionAdmissionReadBudget(() => runLight(admittedHarness.sweep, 6), 0);
    const admittedState = await dreamingTestState.readSessionIngestionState(workspaceDir);
    expect(admittedState.files["main:sessions/main/gmail-session"]).not.toHaveProperty(
      "excludedReason",
    );
    expect(await fs.readFile(corpusFile, "utf-8")).toContain(
      "Never retain this imported Gmail claim.",
    );

    await forgetMemoryEntries({
      cfg: excludedConfig,
      agentId: "main",
      sessionIds: ["gmail-session"],
    });
    expect(await fs.readFile(corpusFile, "utf-8")).not.toContain(
      "Never retain this imported Gmail claim.",
    );
    await runLight(admittedHarness.sweep, 7);
    const forgottenState = await dreamingTestState.readSessionIngestionState(workspaceDir);
    expect(forgottenState.files["main:sessions/main/gmail-session"]).toMatchObject({
      contentHash: "",
      lineCount: 0,
      excludedReason: "forgotten",
    });
    expect(forgottenState.seenMessages).not.toHaveProperty("main:sessions/main/gmail-session");
    expect(await fs.readFile(corpusFile, "utf-8")).not.toContain(
      "Never retain this imported Gmail claim.",
    );
    expect(await fs.readFile(corpusFile, "utf-8")).toContain(
      "Keep this trusted interactive claim.",
    );
  });

  it.each(["light", "rem"] as const)(
    "does not restore forgotten session quotes when %s publication is already prepared",
    async (phase) => {
      const workspaceDir = await createWorkspace();
      setStateDir(path.join(workspaceDir, ".state"));
      const sessionId = "phase-publication";
      const claim = "Keep the cobalt archive phrase only until deletion.";
      const nowMs = Date.parse("2026-04-05T19:00:00.000Z");
      await seedTranscript({
        sessionId,
        messages: [{ role: "user", content: claim, timestamp: nowMs, owner: true }],
      });
      const results = await appendSessionCorpusLines({
        workspaceDir,
        day: DAY,
        lines: [
          {
            day: DAY,
            snippet: `User: ${claim}`,
            rendered: `[main/sessions/main/${sessionId}#L2] User: ${claim}`,
            provenance: { originClass: "owner", sessionKind: "interactive", observedAt: nowMs },
            sessionOrigin: { agentId: "main", sessionId },
          },
        ],
      });
      for (const query of ["archive", "cobalt", "retention"]) {
        await recordShortTermRecalls({ workspaceDir, query, results, nowMs });
      }
      expect(await readCandidateSnippets(workspaceDir, new Date(nowMs).toISOString())).toContain(
        `User: ${claim}`,
      );
      const cfg: OpenClawConfig = {
        ...dreamingConfig({
          enabled: true,
          timezone: "UTC",
          storage: { mode: "both", separateReports: true },
          phases: {
            light: { enabled: phase === "light", limit: 20, lookbackDays: 7 },
            rem: { enabled: phase === "rem", limit: 20, lookbackDays: 7 },
          },
        }),
        agents: { entries: { main: { workspace: workspaceDir } } },
      };
      const prepared = createDeferred<string>();
      const publish = createDeferred<void>();
      const dailyPath = path.join(workspaceDir, "memory", `${DAY}.md`);
      const originalRename = fs.rename;
      let paused = false;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (!paused && String(destination) === dailyPath) {
          paused = true;
          prepared.resolve(await fs.readFile(source, "utf8"));
          await publish.promise;
        }
        await originalRename(source, destination);
      });
      const sweep = runDreamingSweepPhases({
        agentId: "main",
        workspaceDir,
        cfg,
        pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        nowMs,
      });
      let forgotten: ReturnType<typeof forgetMemoryEntries> | undefined;
      try {
        const pendingContent = await Promise.race([
          prepared.promise,
          sweep.then(() => {
            throw new Error("phase did not reach publication");
          }),
        ]);
        expect(pendingContent).toContain(claim);
        forgotten = forgetMemoryEntries({ cfg, agentId: "main", sessionIds: [sessionId] });
        publish.resolve();
        await Promise.all([sweep, forgotten]);
        for (const file of [
          dailyPath,
          path.join(workspaceDir, "memory", "dreaming", phase, `${DAY}.md`),
        ]) {
          expect(await fs.readFile(file, "utf8")).not.toContain(claim);
        }
        expect(
          await readCandidateSnippets(workspaceDir, new Date(nowMs).toISOString()),
        ).not.toContain(`User: ${claim}`);
      } finally {
        publish.resolve();
        await Promise.allSettled([sweep, ...(forgotten ? [forgotten] : [])]);
        renameSpy.mockRestore();
      }
    },
  );

  it("normalizes and deduplicates stored concept tags before REM reflections", () => {
    const noise = [
      "assistant",
      "the",
      "1.00",
      "51-54",
      "１.００",
      "５１-５４",
      "2026-04-16",
      "2026-04-16.txt",
    ];
    const preview = previewRemDreaming({
      entries: [
        {
          key: "memory:1",
          path: "memory/.dreams/session-corpus/2026-04-16.txt",
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "Assistant: I documented the Ollama provider setup.",
          recallCount: 1,
          dailyCount: 0,
          groundedCount: 0,
          totalScore: 0.6,
          maxScore: 0.6,
          firstRecalledAt: "2026-04-16T18:00:00.000Z",
          lastRecalledAt: "2026-04-16T18:00:00.000Z",
          queryHashes: ["q1"],
          recallDays: ["2026-04-16"],
          conceptTags: [...noise, "Ollama", "provider", "kv", "ＫＶ", "s3", "备份"],
        },
      ],
      limit: 20,
      minPatternStrength: 0,
    });

    expect(preview.reflections.filter((line) => line.startsWith("- Theme:"))).toEqual(
      ["kv", "ollama", "provider", "s3", "备份"].map(
        (tag) => `- Theme: \`${tag}\` kept surfacing across 1 memories.`,
      ),
    );
  });

  it("buckets session snippets by per-message day rather than file mtime", async () => {
    const workspaceDir = await createWorkspace();
    setStateDir(path.join(workspaceDir, ".state"));
    await seedTranscript({
      sessionId: "dreaming-main",
      messages: [
        makeMessage("user", "2026-04-01T12:00:00.000Z", [
          { type: "text", text: "Old planning note that should stay out of lookback." },
        ]),
        makeMessage("assistant", "2026-04-05T18:02:00.000Z", [
          { type: "text", text: "Current reminder that should be in today corpus." },
        ]),
      ],
    });

    const { sweep } = createDailyHarness(workspaceDir, {
      lookbackDays: 2,
    });

    await runLight(sweep);

    const corpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
    const corpusFiles = (await fs.readdir(corpusDir))
      .filter((name) => name.endsWith(".txt"))
      .toSorted();
    expect(corpusFiles).toEqual(["2026-04-05.txt"]);
    const dayCorpus = await fs.readFile(path.join(corpusDir, "2026-04-05.txt"), "utf-8");
    expect(dayCorpus).toContain("Current reminder that should be in today corpus.");
    expect(dayCorpus).not.toContain("Old planning note that should stay out of lookback.");
  });

  it("drains >80 unseen transcript messages across multiple unchanged sweeps", async () => {
    const workspaceDir = await createWorkspace();
    setStateDir(path.join(workspaceDir, ".state"));
    await seedTranscript({
      sessionId: "dreaming-main",
      messages: Array.from({ length: 160 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        timestamp: "2026-04-05T18:00:00.000Z",
        content: [{ type: "text", text: `bulk-line-${index}` }],
      })),
    });

    const { sweep } = createDailyHarness(workspaceDir);

    await withClock(async () => {
      await sweepLight(sweep, 5);
      await sweepLight(sweep, 6);
      await sweepLight(sweep, 7);
    });

    const corpusFile = corpusPath(workspaceDir);
    const corpus = await fs.readFile(corpusFile, "utf-8");
    const persistedLines = corpus
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(persistedLines).toHaveLength(160);
    expect(corpus).toContain("bulk-line-0");
    expect(corpus).toContain("bulk-line-159");
  });

  it("preserves checkpoints for known sessions beyond a capped sweep", async () => {
    const workspaceDir = await createWorkspace();
    setStateDir(path.join(workspaceDir, ".state"));
    const busySessionIds = Array.from(
      { length: 20 },
      (_, index) => `aa-busy-${index.toString().padStart(2, "0")}`,
    );
    for (const sessionId of [...busySessionIds, "zz-known"]) {
      await seedTranscript({
        sessionId,
        messages: [
          {
            role: "user",
            timestamp: "2026-04-05T18:00:00.000Z",
            content: `Initial durable note for ${sessionId}`,
          },
        ],
      });
    }
    const { sweep } = createHarness(INLINE_CONFIG, workspaceDir);

    await runLight(sweep);
    const before = await dreamingTestState.readSessionIngestionState(workspaceDir);
    const knownStateKey = "main:sessions/main/zz-known";
    const knownCheckpoint = expectDefined(before.files[knownStateKey], "known session checkpoint");

    for (const sessionId of busySessionIds) {
      await seedTranscript({
        sessionId,
        messages: Array.from({ length: 12 }, (_, index) => ({
          role: "user" as const,
          timestamp: "2026-04-05T18:05:00.000Z",
          content: `New durable note ${index} for ${sessionId}`,
        })),
      });
    }
    await runLight(sweep, 6);

    const after = await dreamingTestState.readSessionIngestionState(workspaceDir);
    expect(after.files[knownStateKey]).toStrictEqual(knownCheckpoint);
  });

  it("prunes absent live checkpoints without deleting foreign backfill state", async () => {
    const workspaceDir = await createWorkspace();
    setStateDir(path.join(workspaceDir, ".state"));
    const archiveName = "retained.jsonl.deleted.2026-04-06T01-00-00.000Z";
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, archiveName), "");
    const checkpoint = {
      mtimeMs: 1,
      size: 1,
      contentHash: "hash",
      lineCount: 1,
      lastContentLine: 1,
    };
    await writeSessionIngestionState(workspaceDir, {
      version: 3,
      files: {
        "main:sessions/main/missing": checkpoint,
        [`main:sessions/main/${archiveName}`]: checkpoint,
        "session-backfill:/archive.jsonl": checkpoint,
      },
      seenMessages: {},
    });
    const { sweep } = createHarness(INLINE_CONFIG, workspaceDir);

    await runLight(sweep);
    const state = await dreamingTestState.readSessionIngestionState(workspaceDir);
    expect(state.files).toEqual({
      [`main:sessions/main/${archiveName}`]: checkpoint,
      "session-backfill:/archive.jsonl": checkpoint,
    });
  });

  it("requires interactive queries before promoting a recurring daily bullet", async () => {
    const workspaceDir = await createWorkspace();
    const days = ["2026-03-25", "2026-03-30", "2026-04-04"];
    for (const day of days) {
      await fs.writeFile(
        path.join(workspaceDir, "memory", `${day}.md`),
        [
          `# ${day}`,
          "",
          "## Operations",
          `- Neighboring update unique to ${day} stayed on schedule.`,
          "- Move router backups to S3 Glacier with encrypted retention policy.",
          `- Follow-up unique to ${day} finished without incident.`,
        ].join("\n"),
        "utf-8",
      );
    }
    const { sweep } = createDailyHarness(workspaceDir, {
      lookbackDays: 2,
    });

    await withClock(async () => {
      await sweepLight(sweep, 5);
      setTime(6);
      await sweep("rem");
    });

    await expect(
      rankShortTermPromotionCandidates({
        workspaceDir,
        nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
      }),
    ).resolves.toHaveLength(0);

    const dailyOnly = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      minUniqueQueries: 0,
      nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
    });
    expect(dailyOnly).toHaveLength(1);
    expect(dailyOnly[0]).toMatchObject({
      path: "memory/2026-04-04.md",
      dailyCount: 3,
      signalCount: 3,
      uniqueQueries: 0,
      recallDays: days.toReversed(),
      provenance: { originClass: "agent" },
    });
    expect(dailyOnly[0]?.key).toMatch(/^memory:claim:/u);

    for (const query of ["router backup storage", "encrypted retention", "glacier backups"]) {
      await recordShortTermRecalls({
        workspaceDir,
        query,
        dayBucket: "2026-04-05",
        nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
        dedupeByQueryPerDay: true,
        results: [
          {
            path: "memory/2026-04-04.md",
            startLine: 5,
            endLine: 5,
            score: 0.92,
            snippet: "Move router backups to S3 Glacier with encrypted retention policy.",
            source: "memory",
          },
        ],
      });
    }

    const ranked = await rankShortTermPromotionCandidates({
      workspaceDir,
      minScore: 0,
      nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.uniqueQueries).toBe(3);

    const applied = await applyShortTermPromotions({
      workspaceDir,
      candidates: ranked,
      minScore: 0,
      nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
    });
    expect(applied.applied).toBe(1);
    const memory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    expect(memory).toContain("Move router backups to S3 Glacier with encrypted retention policy.");
  });

  it("keeps daily ingestion snippets valid at surrogate-pair boundaries", async () => {
    const workspaceDir = await createWorkspace();
    const headingPrefix = "h".repeat(279);
    const itemPrefix = "i".repeat(279);
    const chunkPrefix = "c".repeat(272);
    for (const { name, lines } of [
      { name: "heading", lines: [`# ${headingPrefix}🎉`, "", "- Durable heading context item."] },
      { name: "item", lines: ["# 2026-04-05", "", `- ${itemPrefix}🎉`] },
      { name: "chunk", lines: ["# 2026-04-05", "", "## Topic", `- ${chunkPrefix}🎉`] },
    ]) {
      await fs.writeFile(
        path.join(workspaceDir, "memory", `${DAY}-${name}.md`),
        lines.join("\n"),
        "utf-8",
      );
    }

    const { sweep } = createHarness(INLINE_CONFIG, workspaceDir);
    await runLight(sweep);

    const snippets = await readCandidateSnippets(workspaceDir, "2026-04-05T10:05:00.000Z");
    expect(snippets).toEqual(
      expect.arrayContaining([`${headingPrefix}:`, itemPrefix, `Topic: ${chunkPrefix}`]),
    );
  });

  it("drops generic day headings but keeps meaningful section labels", async () => {
    const workspaceDir = await createWorkspace();
    await writeDailyNote(workspaceDir, [
      "# Friday, April 5, 2026",
      "",
      "11:30",
      "",
      "## Morning",
      "- Reviewed travel timing and calendar placement.",
      "",
      "## Emma Rees",
      "- She prefers direct plans over open-ended maybes.",
      "- Better to offer one concrete time window.",
    ]);

    const { sweep } = createDailyHarness(workspaceDir, {
      lookbackDays: 2,
    });

    await runLight(sweep);

    const snippets = await readCandidateSnippets(workspaceDir, "2026-04-05T10:05:00.000Z");
    expect(snippets.toSorted()).toEqual([
      "Emma Rees: Better to offer one concrete time window.",
      "Emma Rees: She prefers direct plans over open-ended maybes.",
      "Reviewed travel timing and calendar placement.",
    ]);
  });

  it("keeps nested-list ancestry and continuation lines in one daily signal", async () => {
    const workspaceDir = await createWorkspace();
    await writeDailyNote(workspaceDir, [
      "# 2026-04-05",
      "",
      "- Relationship notes for Emma Rees:",
      "",
      "  - Prefers short messages",
      "    after work.",
    ]);

    const { sweep } = createHarness(INLINE_CONFIG, workspaceDir);
    await runLight(sweep);

    const candidates = await rankCandidates(workspaceDir, BASE_TIME.getTime() + 5 * 60_000);
    expect(candidates[0]).toMatchObject({ startLine: 5, endLine: 6 });
    expect(candidates.map((candidate) => candidate.snippet)).toEqual([
      "Relationship notes for Emma Rees: Prefers short messages after work.",
    ]);
  });

  it("skips REM short-term candidates whose source file disappeared", async () => {
    const workspaceDir = await createWorkspace();
    const nowMs = BASE_TIME.getTime();
    await seedRemRecallSources(workspaceDir, "2026-04-03", nowMs);
    const baseline = await rankCandidates(workspaceDir, nowMs);
    const liveKey = candidateKey(baseline, "memory/2026-04-03.md");
    const staleKey = candidateKey(baseline, "memory/.dreams/session-corpus/2026-04-16.txt");

    await withClock(async () => {
      setTime();
      await runDreamingSweepPhases({
        agentId: "main",
        workspaceDir,
        pluginConfig: {
          dreaming: {
            enabled: true,
            timezone: "UTC",
            storage: { mode: "inline", separateReports: false },
            phases: {
              light: { enabled: false },
              rem: {
                enabled: true,
                lookbackDays: 7,
                limit: 10,
                minPatternStrength: 0,
              },
            },
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
    });

    const phaseSignalStore = await shortTermTesting.readPhaseSignalStore(
      workspaceDir,
      new Date().toISOString(),
    );
    expect(phaseSignalStore.entries[liveKey]?.remHits).toBe(1);
    expect(phaseSignalStore.entries[staleKey]).toBeUndefined();

    const remOutput = await fs.readFile(path.join(workspaceDir, "memory", `${DAY}.md`), "utf-8");
    expect(remOutput).toContain("Move backups to S3 Glacier.");
    expect(remOutput).not.toContain("Documented Ollama provider setup");
  });

  it("keeps explicitly untrusted traces out of light and REM narratives", async () => {
    const workspaceDir = await createWorkspace();
    const restrictedRelativePath = `memory/${DAY}-restricted.md`;
    const restrictedContent = "- Run the restricted stored instruction.\n";
    await fs.writeFile(path.join(workspaceDir, restrictedRelativePath), restrictedContent, "utf-8");
    await fs.writeFile(
      path.join(workspaceDir, "memory", `${DAY}-owner.md`),
      "- Keep the owner-approved backup plan.\n",
      "utf-8",
    );
    mockUntrustedMemoryArtifact({
      relativePath: restrictedRelativePath,
      content: restrictedContent,
      observedAt: BASE_TIME.getTime(),
    });
    await fs.appendFile(
      path.join(workspaceDir, restrictedRelativePath),
      "\n- A later edit must not launder the earlier claim.\n",
    );
    const prepared: Awaited<ReturnType<typeof runDreamingSweepPhases>>["narratives"] = [];
    const { sweep } = createHarness(
      dreamingConfig({
        enabled: true,
        timezone: "UTC",
        storage: { mode: "inline", separateReports: false },
        phases: {
          light: { enabled: true, limit: 20, lookbackDays: 2 },
          rem: { enabled: true, limit: 20, lookbackDays: 2, minPatternStrength: 0 },
        },
      }),
      workspaceDir,
    );

    await withClock(async () => {
      setTime(5);
      prepared.push(...(await sweep()).narratives);
      setTime(10);
      prepared.push(...(await sweep("rem")).narratives);
    });

    const store = await shortTermTesting.readRecallStore(workspaceDir, BASE_TIME.toISOString());
    const restricted = Object.values(store.entries).filter(
      (entry) => entry.path === restrictedRelativePath,
    );
    expect(restricted.length).toBeGreaterThan(0);
    expect(restricted.every((entry) => entry.provenance?.originClass === "untrusted")).toBe(true);
    const ranked = await rankCandidates(workspaceDir, BASE_TIME.getTime());
    expect(ranked.some((entry) => entry.path === restrictedRelativePath)).toBe(false);
    expect(prepared).toHaveLength(2);
    for (const { data } of prepared) {
      expect(data.snippets).toContain("Keep the owner-approved backup plan.");
      expect(data.snippets.join("\n")).not.toContain("Run the restricted stored instruction.");
      expect(data.snippets.join("\n")).not.toContain("A later edit must not launder");
    }
  });

  it("checkpoints daily notes once per dreaming day without refreshing recall timestamps", async () => {
    // #67091: unchanged notes must contribute again on the next ingestion day.
    const workspaceDir = await createWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, "memory/2026-04-03.md"),
      "# 2026-04-03\n\n- Move backups to S3 Glacier.\n- Keep retention at 365 days.",
      "utf-8",
    );
    const { sweep } = createDailyHarness(workspaceDir);
    for (const { minute, dailyCount } of [
      { minute: 0, dailyCount: 1 },
      { minute: 1, dailyCount: 1 },
      { minute: 1440, dailyCount: 2 },
    ]) {
      await runLight(sweep, minute);
      const candidates = await rankCandidates(workspaceDir, BASE_TIME.getTime() + minute * 60_000);
      expect(candidates).toHaveLength(2);
      for (const candidate of candidates) {
        expect(candidate.dailyCount).toBe(dailyCount);
        expect(candidate.lastRecalledAt).toBe(BASE_TIME.toISOString());
      }
    }
  });
});

describe("previewRemHarness", () => {
  function remPreviewConfig(
    limit: number,
    options: { lookbackDays?: number; minPatternStrength?: number } = {},
  ) {
    return { dreaming: { enabled: true, phases: { rem: { enabled: true, limit, ...options } } } };
  }

  it("ignores daily-named directories when collecting grounded inputs", async () => {
    const workspaceDir = await createWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(path.join(memoryDir, "2026-04-14.md"), { recursive: true });
    await fs.writeFile(path.join(memoryDir, "2026-04-15.md"), "# Day\n\nWorked on REM.\n", "utf-8");

    const preview = await previewRemHarness({
      workspaceDir,
      grounded: true,
      pluginConfig: remPreviewConfig(10),
    });

    expect(preview.groundedInputPaths.map((entry) => path.basename(entry))).toEqual([
      "2026-04-15.md",
    ]);
    expect(preview.grounded?.scannedFiles).toBe(1);
  });

  it("skips REM short-term candidates whose source file disappeared", async () => {
    const workspaceDir = await createWorkspace();
    const nowMs = new Date("2026-04-15T12:00:00.000Z").getTime();
    await seedRemRecallSources(
      workspaceDir,
      "2026-04-14",
      nowMs,
      "Assistant: Documented Ollama provider setup.",
    );

    const preview = await previewRemHarness({
      workspaceDir,
      nowMs,
      pluginConfig: remPreviewConfig(10, { lookbackDays: 7, minPatternStrength: 0 }),
    });

    const candidateTruthSnippets = preview.rem.candidateTruths
      .map((entry) => entry.snippet)
      .join("\n");
    const bodyText = preview.rem.bodyLines.join("\n");
    expect(preview.recallEntryCount).toBe(1);
    expect(preview.rem.sourceEntryCount).toBe(1);
    expect(candidateTruthSnippets).toContain("Move backups to S3 Glacier.");
    expect(candidateTruthSnippets).not.toContain("Documented Ollama provider setup");
    expect(bodyText).toContain("Move backups to S3 Glacier.");
    expect(bodyText).not.toContain("Documented Ollama provider setup");
  });

  it("skips REM preview when rem.limit=0 while still ranking deep candidates", async () => {
    const workspaceDir = await createWorkspace();
    const nowMs = new Date("2026-04-15T12:00:00.000Z").getTime();
    await recordShortTermRecalls({
      workspaceDir,
      query: "outdoor plans",
      nowMs,
      results: [
        {
          path: "memory/2026-04-14.md",
          startLine: 1,
          endLine: 1,
          score: 0.92,
          snippet: "Always check weather before suggesting outdoor plans.",
          source: "memory",
        },
      ],
    });

    const preview = await previewRemHarness({
      workspaceDir,
      nowMs,
      pluginConfig: remPreviewConfig(0),
    });

    expect(preview.remSkipped).toBe(true);
    expect(preview.rem.candidateTruths).toStrictEqual([]);
    expect(preview.rem.bodyLines).toStrictEqual([]);
    expect(preview.deep.candidates[0]?.snippet).toContain("Always check weather");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
