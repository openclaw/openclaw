import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  appendMemoryHostEvent,
  readMemoryHostEventRecords,
  readMemoryHostEvents,
} from "openclaw/plugin-sdk/memory-host-events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendNarrativeEntry,
  dedupeDreamDiaryEntries,
  readDreamsFile,
  readRecentDreamDiaryEntries,
  removeBackfillDiaryEntries,
  updateDreamsFile,
  writeBackfillDiaryEntries,
} from "./dreaming-dreams-file.js";
import { writeDailyDreamingPhaseBlock, writeDeepDreamingReport } from "./dreaming-markdown.js";
import { runDreamNarrative } from "./dreaming-narrative.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import { SESSION_CORPUS_RELATIVE_DIR } from "./session-ingestion.js";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
} from "./short-term-promotion.js";
import { createDreamingCompletion, createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
let workspaceDir: string;
let dreamsPath: string;
beforeEach(async () => {
  workspaceDir = await createTempWorkspace("dreaming-diary-");
  dreamsPath = path.join(workspaceDir, "DREAMS.md");
});
const readDiary = () => fs.readFile(dreamsPath, "utf8");
const forgetSession = (sessionId: string) =>
  forgetMemoryEntries({
    cfg: { agents: { entries: { main: { workspace: workspaceDir } } } },
    agentId: "main",
    sessionIds: [sessionId],
  });

function writeBackfill(
  body = "The archive remembered a durable fact.",
  entry: Partial<Parameters<typeof writeBackfillDiaryEntries>[0]["entries"][number]> = {},
) {
  return writeBackfillDiaryEntries({
    workspaceDir,
    entries: [{ isoDay: "2026-04-05", bodyLines: [body], ...entry }],
    timezone: "UTC",
  });
}

function renderDiary(...blocks: string[]) {
  return `# Dream Diary\n\n<!-- openclaw:dreaming:diary:start -->\n${blocks
    .map((block) => `---\n\n${block}\n`)
    .join("\n")}\n<!-- openclaw:dreaming:diary:end -->\n`;
}

const phaseDefaults = {
  bodyLines: ["- Candidate: replacement"],
  hasContent: true,
  nowMs: Date.parse("2026-04-05T10:00:00Z"),
  timezone: "UTC",
  storage: { mode: "inline" as const, separateReports: false },
};
const writePhase = (overrides: Partial<Parameters<typeof writeDailyDreamingPhaseBlock>[0]> = {}) =>
  writeDailyDreamingPhaseBlock({ ...phaseDefaults, phase: "light", workspaceDir, ...overrides });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("does not restore deleted diary content from an update already in progress", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
  const claim = "A private cobalt archive phrase.";
  await fs.writeFile(dreamsPath, `# Diary\n\n## Session ID: forgotten\n${claim}\n`);
  const prepared = createDeferred<void>();
  const publish = createDeferred<void>();
  const update = updateDreamsFile({
    workspaceDir,
    updater: async (existing) => {
      expect(existing).toContain(claim);
      prepared.resolve();
      await publish.promise;
      return { content: `${existing}\n## Other\nA new unrelated entry.\n`, result: undefined };
    },
  });
  let forgotten: ReturnType<typeof forgetMemoryEntries> | undefined;
  try {
    await prepared.promise;
    forgotten = forgetSession("forgotten");
    publish.resolve();
    await Promise.all([update, forgotten]);
    const content = await readDiary();
    expect(content).not.toContain(claim);
    expect(content).toContain("A new unrelated entry.");
  } finally {
    publish.resolve();
    await Promise.allSettled([update, ...(forgotten ? [forgotten] : [])]);
  }
});

it("reads and removes backfill entries", async () => {
  const written = await writeBackfill(undefined, {
    sourcePath: "memory/2026-04-05.md",
  });
  expect(written.written).toBe(1);

  await expect(readRecentDreamDiaryEntries({ workspaceDir })).resolves.toHaveLength(1);
  await expect(removeBackfillDiaryEntries({ workspaceDir })).resolves.toMatchObject({ removed: 1 });
});

it("refuses to overwrite a symlinked DREAMS.md", async () => {
  const targetPath = path.join(workspaceDir, "outside.txt");
  await fs.writeFile(targetPath, "outside\n", "utf8");
  await fs.symlink(targetPath, dreamsPath);

  await expect(writeBackfill()).rejects.toThrow("Refusing to write symlinked DREAMS.md");
  await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("outside\n");
});

it("leaves DREAMS.md unchanged when it contains invalid UTF-8", async () => {
  const bytes = Buffer.concat([Buffer.from("# Diary\n\nprior entry\n\n"), Buffer.from([0xff])]);
  await fs.writeFile(dreamsPath, bytes);

  await expect(
    updateDreamsFile({
      workspaceDir,
      updater: () => ({ content: "# Rewritten\n", result: undefined }),
    }),
  ).rejects.toThrow(/must be valid UTF-8/);

  expect(await fs.readFile(dreamsPath)).toEqual(bytes);
});

it("degrades malformed diary context to empty history so dreaming continues", async () => {
  const bytes = Buffer.concat([
    Buffer.from(renderDiary("*April 5, 2026*\n\nPrior diary entry")),
    Buffer.from([0xff]),
  ]);
  await fs.writeFile(dreamsPath, bytes);

  await expect(readRecentDreamDiaryEntries({ workspaceDir })).resolves.toEqual([]);
  expect(await fs.readFile(dreamsPath)).toEqual(bytes);
});

it("publishes unchanged truncated context ending in an emoji", async () => {
  const prefix = "a".repeat(359);
  const body = `${prefix}😀tail`;
  await writeBackfill(body);

  const recentDiaryEntries = await readRecentDreamDiaryEntries({ workspaceDir, limit: 1 });
  expect(recentDiaryEntries).toEqual([`${prefix}...`]);
  await appendNarrativeEntry({
    workspaceDir,
    narrative: "Unchanged context must still publish.",
    nowMs: Date.parse("2026-04-06T03:00:00Z"),
    timezone: "UTC",
    recentDiaryEntries,
  });
  const content = await readDreamsFile(dreamsPath);
  expect(content).toContain("Unchanged context must still publish.");
  expect(content).toContain(body);
});

it("skips symlinked and non-file DREAMS.md when reading recent context", async () => {
  const targetPath = path.join(workspaceDir, "target-dreams.md");
  await fs.writeFile(targetPath, renderDiary("*April 5, 2026*\n\nPrivate symlink target."));
  await fs.symlink(targetPath, dreamsPath);

  await expect(readRecentDreamDiaryEntries({ workspaceDir, limit: 3 })).resolves.toEqual([]);

  const directoryWorkspace = await createTempWorkspace("dreaming-narrative-read-directory-");
  await fs.mkdir(path.join(directoryWorkspace, "DREAMS.md"));
  await expect(
    readRecentDreamDiaryEntries({ workspaceDir: directoryWorkspace, limit: 3 }),
  ).resolves.toEqual([]);
});

it.each(["EPERM", "ERR_INVALID_UTF8"])(
  "only optional diary context suppresses %s",
  async (code) => {
    await fs.writeFile(dreamsPath, "# Existing\n");
    const error = Object.assign(new Error("read denied"), { code });
    vi.spyOn(fs, "open").mockRejectedValue(error);

    await expect(readDreamsFile(dreamsPath)).rejects.toBe(error);
    await expect(readRecentDreamDiaryEntries({ workspaceDir })).resolves.toEqual([]);
  },
);

it("preserves an undefined error code across optional context handling", async () => {
  const code = vi
    .fn()
    .mockReturnValueOnce(undefined)
    .mockReturnValueOnce(undefined)
    .mockReturnValue("ENOENT");
  const error = Object.defineProperty(new Error("read failed"), "code", { get: code });
  vi.spyOn(fs, "access").mockRejectedValueOnce(error);

  await expect(readRecentDreamDiaryEntries({ workspaceDir })).rejects.toBe(error);
  expect(code).toHaveBeenCalledTimes(2);
});

it("preserves restrictive DREAMS.md permissions across atomic replace", async () => {
  await fs.writeFile(dreamsPath, "# Existing\n", { encoding: "utf8", mode: 0o600 });
  await fs.chmod(dreamsPath, 0o600);

  await writeBackfill();

  if (process.platform !== "win32") {
    expect((await fs.stat(dreamsPath)).mode & 0o777).toBe(0o600);
  }
});

it("keeps a shared workspace's directory mode when writing DREAMS.md", async () => {
  if (process.platform !== "win32") {
    await fs.chmod(workspaceDir, 0o770);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === workspaceDir) {
        vi.spyOn(handle, "chmod").mockRejectedValue(
          Object.assign(new Error("shared workspace chmod denied"), { code: "EPERM" }),
        );
      }
      return handle;
    });
  }

  await writeBackfill();

  expect(await readDiary()).toContain("The archive remembered a durable fact.");
  if (process.platform !== "win32") {
    expect((await fs.stat(workspaceDir)).mode & 0o7777).toBe(0o770);
  }
});

it("keeps a workspace directory created for DREAMS.md private", async () => {
  const freshWorkspace = path.join(workspaceDir, "fresh");

  await writeBackfillDiaryEntries({
    workspaceDir: freshWorkspace,
    entries: [{ isoDay: "2026-04-05", bodyLines: ["The archive remembered a durable fact."] }],
    timezone: "UTC",
  });

  if (process.platform !== "win32") {
    expect((await fs.stat(freshWorkspace)).mode & 0o7777).toBe(0o700);
  }
});

it("serializes concurrent writes and deduplication", async () => {
  const entry = "*April 11, 2026, 8:00 AM*\n\nThe server room smelled like rain.";
  await fs.writeFile(dreamsPath, renderDiary(entry, entry));

  await Promise.all([
    dedupeDreamDiaryEntries({ workspaceDir }),
    writeBackfill("A fresh signal arrived after the cleanup started.", {
      isoDay: "2026-04-11",
    }),
  ]);

  const content = await readDiary();
  expect(content.match(/The server room smelled like rain\./g)?.length).toBe(1);
  expect(content).toContain("A fresh signal arrived after the cleanup started.");
});

describe("dreaming markdown storage", () => {
  it("replaces the managed deep summary while preserving the diary block", async () => {
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
      ...phaseDefaults,
      workspaceDir,
      bodyLines: ["- New summary."],
    });

    const dreamsContent = await readDiary();
    expect(dreamsContent).toContain("The old diary entry stays.");
    expect(dreamsContent).toContain("- New summary.");
    expect(dreamsContent).not.toContain("- Old summary.");
  });

  it.each(["inline", "separate"] as const)(
    "keeps an existing %s report when replacement fails",
    async (mode) => {
      const targetPath = path.join(
        workspaceDir,
        "memory",
        ...(mode === "separate" ? ["dreaming", "light"] : []),
        "2026-04-05.md",
      );
      await writeNote(path.relative(workspaceDir, targetPath), "# Previous dreaming artifact\n");
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

      await expect(writePhase({ storage: { mode, separateReports: false } })).rejects.toThrow(
        "replace failed",
      );
      await expect(fs.readFile(targetPath)).resolves.toEqual(priorBytes);
      await expect(fs.readdir(path.dirname(targetPath))).resolves.toEqual([
        path.basename(targetPath),
      ]);
    },
  );

  it("preserves read errors from an empty daily report", async () => {
    const failure = Object.assign(new Error("daily file unavailable"), { code: "EACCES" });
    vi.spyOn(fs, "access").mockRejectedValue(failure);
    vi.spyOn(fs, "readFile").mockRejectedValue(failure);

    await expect(
      writePhase({
        bodyLines: ["- No notable updates."],
        hasContent: false,
        storage: { mode: "both", separateReports: false },
      }),
    ).rejects.toBe(failure);
  });

  it("leaves an inline daily file unchanged when it contains invalid UTF-8", async () => {
    const targetPath = path.join(workspaceDir, "memory", "2026-04-05.md");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const bytes = Buffer.concat([Buffer.from("# Daily\n\nprior entry\n\n"), Buffer.from([0xff])]);
    await fs.writeFile(targetPath, bytes);

    await expect(writePhase()).rejects.toThrow(/must be valid UTF-8/);

    expect(await fs.readFile(targetPath)).toEqual(bytes);
  });
});

describe("dream narrative publication", () => {
  function narrativeHarness(text?: string) {
    const subagent = createDreamingCompletion(text);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const run = (overrides: Partial<Parameters<typeof runDreamNarrative>[0]> = {}) =>
      runDreamNarrative({
        workspaceDir,
        subagent,
        logger,
        agentId: "main",
        timeoutMs: 180_000,
        data: { phase: "light", snippets: ["A private raw staging fragment."] },
        ...overrides,
      });
    return { subagent, logger, run };
  }

  it.each([false, true])(
    "retries unavailable models but never denied selection (denied=%s)",
    async (denied) => {
      const text = "The default model carried the diary home.";
      const { subagent, logger, run } = narrativeHarness(text);
      const error = new Error(denied ? "model override is not authorized" : "Completion failed", {
        cause: new Error("unknown model: ollama/missing-model"),
      });
      if (denied) {
        subagent.complete.mockRejectedValue(
          Object.assign(error, { code: "LLM_COMPLETION_NOT_AUTHORIZED" }),
        );
      } else {
        subagent.complete.mockRejectedValueOnce(error);
      }
      await run({ model: "ollama/missing-model" });
      expect(subagent.complete).toHaveBeenCalledTimes(denied ? 1 : 2);
      expect(subagent.complete.mock.calls[0]?.[0].model).toBe("ollama/missing-model");
      const diary = await readDiary();
      if (denied) {
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("not authorized"));
        expect(diary).not.toContain("A private raw staging fragment.");
        expect(diary).toContain("A memory trace surfaced");
      } else {
        expect(subagent.complete.mock.calls[1]?.[0]).not.toHaveProperty("model");
        expect(diary).toContain(text);
      }
    },
  );

  it("writes only a generic trace after empty completion", async () => {
    const { run } = narrativeHarness("   \n  ");
    const outcome = await run({
      data: { phase: "deep", snippets: ["A private raw staging fragment."] },
    });

    expect(outcome).toMatchObject({ status: "degraded" });
    const diary = await readDiary();
    expect(diary).toContain("A memory trace surfaced, but details were unavailable in this run.");
    expect(diary).not.toContain("A private raw staging fragment.");
  });

  it("writes a generic trace without selecting credentials for an ownerless sweep", async () => {
    const { subagent, run } = narrativeHarness();
    await expect(
      run({
        agentId: undefined,
        data: { phase: "light", snippets: ["An ownerless memory fragment."] },
      }),
    ).resolves.toEqual({ status: "completed" });
    expect(subagent.complete).not.toHaveBeenCalled();
    expect(await readDiary()).toContain("A memory trace surfaced");
  });

  it("publishes a generic fallback when a detached completion rejects", async () => {
    const { subagent, run } = narrativeHarness();
    const completion = createDeferred<{ text: string }>();
    subagent.complete.mockReturnValue(completion.promise);
    let publication: Promise<unknown> | undefined;
    try {
      await expect(
        run({
          data: { phase: "rem", snippets: ["A detached fragment."] },
          runInBackground: (job) => {
            const pending = job();
            publication = pending;
            return pending;
          },
        }),
      ).resolves.toEqual({ status: "pending" });
      expect(subagent.complete).toHaveBeenCalledOnce();
      completion.reject(new Error("completion failed"));
      await publication;
      expect(await readDiary()).toContain("A memory trace surfaced");
    } finally {
      completion.resolve({ text: "settled" });
      await publication;
    }
  });
  it.each(["forget", "unrelated append"])(
    "validates prior diary quotes before publication after %s",
    async (mutation) => {
      const { subagent, run } = narrativeHarness();
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
      const nowMs = Date.now();
      const claim = "The private cobalt archive opens every midnight.";
      const retainedClaim = "A public archive is open throughout the afternoon.";
      await writeNote(
        `${SESSION_CORPUS_RELATIVE_DIR}/2026-08-26.txt`,
        `[main:forgotten-narrative-source#L1] ${claim}\n`,
      );
      await fs.writeFile(dreamsPath, "# Dream Diary\n\nA retained public diary entry.\n");
      const appendDiary = (bodies: string[]) =>
        writeBackfillDiaryEntries({
          workspaceDir,
          preserveExisting: true,
          entries: bodies.map((body) => ({ isoDay: "2026-08-26", bodyLines: [body] })),
        });
      await appendDiary([claim]);
      const waiting = createDeferred<void>();
      const terminal = createDeferred<{ text: string }>();
      const reply = { text: `I remembered: ${claim}` };
      subagent.complete.mockImplementation(async () => {
        waiting.resolve();
        return await terminal.promise;
      });
      const data = {
        phase: "light" as const,
        snippets: [retainedClaim],
        recentDiaryEntries: await readRecentDreamDiaryEntries({ workspaceDir }),
      };
      const operation = run({ data, nowMs });
      try {
        await waiting.promise;
        expect(subagent.complete.mock.calls[0]?.[0].message).toContain(claim);
        if (mutation === "forget") {
          const forgotten = await forgetSession("forgotten-narrative-source");
          expect(forgotten.artifacts.sessionCorpusLines).toBe(1);
          expect(await readDiary()).not.toContain(claim);
        } else {
          // Unrelated appends must not invalidate older context.
          await appendDiary(
            Array.from({ length: 4 }, (_, index) => `Another retained diary entry ${index}.`),
          );
        }
        terminal.resolve(reply);
        const outcome = await operation;
        const content = await readDiary();
        expect(content).toContain("A retained public diary entry.");
        if (mutation === "forget") {
          expect(content).not.toContain(claim);
          expect(outcome).toEqual({ status: "skipped" });
        } else {
          expect(content).toContain(reply.text);
          expect(outcome).toEqual({ status: "completed" });
        }
      } finally {
        terminal.resolve(reply);
        await operation;
      }
    },
  );
});

async function writeNote(relativePath: string, content: string) {
  const target = path.join(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

function recall(relativePath: string, snippet: string, score: number, endLine = 3) {
  return { path: relativePath, snippet, score, startLine: 3, endLine, source: "memory" as const };
}

const permissivePromotion = { minScore: 0, minRecallCount: 0, minUniqueQueries: 0 };
async function recordAndRank(
  query: string,
  results: Parameters<typeof recordShortTermRecalls>[0]["results"],
) {
  const nowMs = Date.UTC(2026, 3, 5, 12);
  await recordShortTermRecalls({ workspaceDir, query, results, nowMs });
  return rankShortTermPromotionCandidates({ workspaceDir, ...permissivePromotion, nowMs });
}

describe("memory host event journal integration", () => {
  it("records recall and promotion events from short-term promotion flows", async () => {
    await writeNote("memory/2026-04-05.md", "# Daily\n\nalpha\nbeta\ngamma\n");

    const candidates = await recordAndRank("alpha memory", [
      recall("memory/2026-04-05.md", "alpha beta", 0.92, 4),
    ]);
    const applied = await applyShortTermPromotions({
      workspaceDir,
      candidates,
      ...permissivePromotion,
      nowMs: Date.UTC(2026, 3, 5, 12, 10, 0),
    });

    expect(applied.applied).toBe(1);

    const events = await readMemoryHostEvents({ workspaceDir });

    expect(events).toMatchObject([
      { type: "memory.recall.recorded", resultCount: 1, query: "alpha memory" },
      { type: "memory.promotion.applied", applied: 1 },
    ]);
  });

  it("records skipped recall events for durable memory hits excluded from short-term promotion", async () => {
    const results = [
      recall("MEMORY.md", "Alpha durable note.", 0.91),
      recall("memory/decisoes/2026-06.md", "Alpha monthly decision.", 0.88),
      recall("memory/idiomas/PLANO.md", "Alpha language plan.", 0.83),
    ];
    for (const result of results) {
      await writeNote(result.path, `# Memory\n\n${result.snippet}\n`);
    }

    const candidates = await recordAndRank("alpha durable memory", results);
    const events = await readMemoryHostEventRecords({ workspaceDir });

    expect(candidates).toEqual([]);
    expect(events).toMatchObject([
      {
        type: "memory.recall.skipped",
        query: "alpha durable memory",
        reason: "non-short-term-memory-path",
        eligibleResultCount: 0,
        skippedResultCount: 3,
        results: results.map(({ path: sourcePath }) => ({
          path: sourcePath,
          reason: "non-short-term-memory-path",
        })),
      },
    ]);
  });

  it("records dreaming completion events when phase artifacts are written", async () => {
    const written = await writePhase({
      bodyLines: ["- staged note", "- second note"],
      nowMs: Date.UTC(2026, 3, 5, 13, 0, 0),
      timezone: undefined,
      storage: { mode: "both", separateReports: true },
    });

    const events = await readMemoryHostEvents({ workspaceDir });

    expect(written.inlinePath).toBe(path.join(workspaceDir, "memory", "2026-04-05.md"));
    expect(written.reportPath).toBe(
      path.join(workspaceDir, "memory", "dreaming", "light", "2026-04-05.md"),
    );
    await expect(fs.readFile(written.inlinePath ?? "", "utf8")).resolves.toContain("- staged note");
    await expect(fs.readFile(written.reportPath ?? "", "utf8")).resolves.toContain("- second note");
    expect(events).toMatchObject([
      {
        type: "memory.dream.completed",
        phase: "light",
        outcome: "completed",
        lineCount: 2,
        storageMode: "both",
      },
    ]);
  });

  it("keeps legacy dreaming completion events without outcome readable", async () => {
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.dream.completed",
      timestamp: "2026-04-05T13:00:00.000Z",
      phase: "deep",
      inlinePath: path.join(workspaceDir, "DREAMS.md"),
      lineCount: 2,
      storageMode: "inline",
    });

    const events = await readMemoryHostEvents({ workspaceDir });
    expect(events).toMatchObject([{ type: "memory.dream.completed", phase: "deep" }]);
    expect(events[0]).not.toHaveProperty("outcome");
  });
});
