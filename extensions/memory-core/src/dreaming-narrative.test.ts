import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { readRecentDreamDiaryEntries, writeBackfillDiaryEntries } from "./dreaming-dreams-file.js";
import { runDreamNarrative } from "./dreaming-narrative.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import { SESSION_CORPUS_RELATIVE_DIR } from "./session-ingestion.js";
import { readShortTermRecallEntries, recordShortTermRecalls } from "./short-term-promotion.js";
import { createDreamingCompletion, createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
async function narrativeHarness(text?: string) {
  const workspaceDir = await createTempWorkspace("dreaming-narrative-");
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
  const readDiary = () => fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf8");
  return { workspaceDir, subagent, logger, run, readDiary };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "retries unavailable models but never denied selection (denied=%s)",
  async (denied) => {
    const text = "The default model carried the diary home.";
    const { subagent, logger, run, readDiary } = await narrativeHarness(text);
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
    expect(subagent.complete.mock.calls[0]?.[0]).toMatchObject({
      model: "ollama/missing-model",
      timeoutMs: 180_000,
    });
    const diary = await readDiary();
    if (denied) {
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("not authorized"));
      expect(diary).not.toContain("A private raw staging fragment.");
      expect(diary).toContain("A memory trace surfaced");
    } else {
      expect(subagent.complete.mock.calls[1]?.[0]).not.toHaveProperty("model");
      expect(subagent.complete.mock.calls[1]?.[0]).toHaveProperty("timeoutMs", 180_000);
      expect(diary).toContain(text);
    }
  },
);

it("writes only a generic trace after empty completion", async () => {
  const { run, readDiary } = await narrativeHarness("   \n  ");
  const outcome = await run({
    data: { phase: "deep", snippets: ["A private raw staging fragment."] },
  });

  expect(outcome).toMatchObject({ status: "degraded" });
  const diary = await readDiary();
  expect(diary).toContain("A memory trace surfaced, but details were unavailable in this run.");
  expect(diary).not.toContain("A private raw staging fragment.");
});

it.each([false, true])("handles an ownerless sweep with empty=%s", async (empty) => {
  const { workspaceDir, subagent, run, readDiary } = await narrativeHarness();
  await expect(
    run({
      agentId: undefined,
      data: { phase: "light", snippets: empty ? [] : ["An ownerless memory fragment."] },
    }),
  ).resolves.toEqual({ status: empty ? "skipped" : "completed" });
  expect(subagent.complete).not.toHaveBeenCalled();
  if (empty) {
    await expect(fs.access(path.join(workspaceDir, "DREAMS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } else {
    expect(await readDiary()).toContain("A memory trace surfaced");
  }
});

it.for([false, true])(
  "detaches publication without an unhandled failure (reject=%s)",
  async (reject, { signal }) => {
    const { subagent, logger, run, readDiary } = await narrativeHarness();
    const completion = createDeferred<{ text: string }>();
    subagent.complete.mockReturnValue(completion.promise);
    const published = createDeferred<void>();
    // Both success and fallback log completion only after the diary write settles.
    logger.info.mockImplementation(() => published.resolve());
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await expect(
        run({
          data: { phase: "rem", snippets: ["A detached fragment."] },
          runInBackground: (job) => job(),
        }),
      ).resolves.toEqual({ status: "pending" });
      expect(subagent.complete).toHaveBeenCalledOnce();
      if (reject) {
        completion.reject(new Error("completion failed"));
      } else {
        completion.resolve({ text: "A detached memory found its page." });
      }
      await withinTest(published.promise, signal);
      const diary = await readDiary();
      expect(diary).toContain(
        reject ? "A memory trace surfaced" : "A detached memory found its page.",
      );
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      completion.resolve({ text: "settled" });
      process.off("unhandledRejection", unhandled);
    }
  },
);
it.each([
  { source: "tracked source", mutation: "forget" },
  { source: "prior diary", mutation: "forget" },
  { source: "prior diary", mutation: "unrelated append" },
] as const)(
  "validates $source before publishing generated quotes after $mutation",
  async ({ source, mutation }) => {
    const { workspaceDir, subagent, logger, run, readDiary } = await narrativeHarness();
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
    const nowMs = Date.now();
    const claim = "The private cobalt archive opens every midnight.";
    const retainedClaim = "A public archive is open throughout the afternoon.";
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    const corpusPath = path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR, "2026-08-26.txt");
    await fs.mkdir(path.dirname(corpusPath), { recursive: true });
    await fs.writeFile(corpusPath, `[main:forgotten-narrative-source#L1] ${claim}\n`);
    await fs.writeFile(dreamsPath, "# Dream Diary\n\nA retained public diary entry.\n");
    await recordShortTermRecalls({
      workspaceDir,
      query: "archive opening time",
      signalType: "daily",
      nowMs,
      results: [claim, retainedClaim].map((snippet, index) => ({
        path: "memory/2026-08-26.md",
        startLine: index + 1,
        endLine: index + 1,
        score: 0.9,
        snippet,
        source: "memory",
        sessionOrigin:
          index === 0 ? { agentId: "main", sessionId: "forgotten-narrative-source" } : undefined,
      })),
    });
    const entries = (await readShortTermRecallEntries({ workspaceDir, nowMs })).filter(
      (entry) => entry.snippet === (source === "prior diary" ? retainedClaim : claim),
    );
    const appendDiary = (bodies: string[]) =>
      writeBackfillDiaryEntries({
        workspaceDir,
        preserveExisting: true,
        entries: bodies.map((body) => ({ isoDay: "2026-08-26", bodyLines: [body] })),
      });
    if (source === "prior diary") {
      await appendDiary([claim]);
    }
    const waiting = createDeferred<void>();
    const terminal = createDeferred<{ text: string }>();
    const reply = { text: `I remembered: ${claim}` };
    subagent.complete.mockImplementation(async () => {
      waiting.resolve();
      return await terminal.promise;
    });
    const data = {
      phase: "light" as const,
      snippets: entries.map((entry) => entry.snippet),
      sourceEntryKeys: entries.map((entry) => entry.key),
      recentDiaryEntries:
        source === "prior diary" ? await readRecentDreamDiaryEntries({ workspaceDir }) : undefined,
    };
    const operation = run({ data, nowMs });
    try {
      await waiting.promise;
      expect(subagent.complete.mock.calls[0]?.[0].message).toContain(claim);
      if (mutation === "forget") {
        const forgotten = await forgetMemoryEntries({
          cfg: { agents: { entries: { main: { workspace: workspaceDir } } } },
          agentId: "main",
          sessionIds: ["forgotten-narrative-source"],
        });
        expect(forgotten.artifacts.shortTermEntries).toBe(1);
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
        expect(logger.info).toHaveBeenCalledWith(
          expect.stringContaining("narrative publication skipped"),
        );
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
