// Memory Core tests cover prompt-only dreaming and publication boundaries.
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRecentDreamDiaryEntries, writeBackfillDiaryEntries } from "./dreaming-dreams-file.js";
import { runDreamNarrative } from "./dreaming-narrative.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import { SESSION_CORPUS_RELATIVE_DIR } from "./session-ingestion.js";
import { readShortTermRecallEntries, recordShortTermRecalls } from "./short-term-promotion.js";
import { createDreamingCompletion, createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
async function narrativeHarness(prefix: string, text?: string) {
  const workspaceDir = await createTempWorkspace(prefix);
  const subagent = createDreamingCompletion(text);
  const logger = createLogger();
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

function expectLogIncludes(source: ReturnType<typeof vi.fn>, text: string) {
  expect(source.mock.calls.some((call) => String(call[0]).includes(text))).toBe(true);
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("runDreamNarrative", () => {
  it("retries an unavailable configured model with the default", async () => {
    const error = new Error("Completion failed", {
      cause: new Error("unknown model: ollama/missing-model"),
    });
    const { subagent, run, readDiary } = await narrativeHarness(
      "dreaming-model-retry-",
      "The default model carried the diary home.",
    );
    subagent.complete.mockRejectedValueOnce(error);
    await run({
      data: { phase: "rem", snippets: ["A configured endpoint was absent."] },
      model: "ollama/missing-model",
    });

    expect(subagent.complete).toHaveBeenCalledTimes(2);
    expect(subagent.complete.mock.calls[0]?.[0]).toMatchObject({
      model: "ollama/missing-model",
      timeoutMs: 180_000,
    });
    expect(subagent.complete.mock.calls[1]?.[0]).not.toHaveProperty("model");
    expect(subagent.complete.mock.calls[1]?.[0]).toHaveProperty("timeoutMs", 180_000);
    expect(await readDiary()).toContain("The default model carried the diary home.");
  });

  it("does not retry unauthorized model selection even when its cause names an unavailable model", async () => {
    const { subagent, logger, run, readDiary } = await narrativeHarness("dreaming-model-denied-");
    subagent.complete.mockRejectedValue(
      Object.assign(
        new Error("model override is not authorized", {
          cause: new Error("unknown model: ollama/missing-model"),
        }),
        { code: "LLM_COMPLETION_NOT_AUTHORIZED" },
      ),
    );
    await run({
      model: "ollama/missing-model",
    });

    expect(subagent.complete).toHaveBeenCalledOnce();
    expectLogIncludes(logger.warn, "not authorized");
    const diary = await readDiary();
    expect(diary).not.toContain("A private raw staging fragment.");
    expect(diary).toContain("A memory trace surfaced");
  });

  it("writes only a generic trace after empty completion", async () => {
    const { run, readDiary } = await narrativeHarness("dreaming-fallback-", "   \n  ");
    const outcome = await run({
      data: { phase: "deep", snippets: ["A private raw staging fragment."] },
    });

    expect(outcome).toMatchObject({ status: "degraded" });
    const diary = await readDiary();
    expect(diary).toContain("A memory trace surfaced, but details were unavailable in this run.");
    expect(diary).not.toContain("A private raw staging fragment.");
  });

  it("skips empty data without an owner", async () => {
    const { workspaceDir, subagent, run } = await narrativeHarness("dreaming-empty-");
    await expect(
      run({
        agentId: undefined,
        data: { phase: "light", snippets: [] },
      }),
    ).resolves.toEqual({ status: "skipped" });
    expect(subagent.complete).not.toHaveBeenCalled();
    await expect(fs.access(path.join(workspaceDir, "DREAMS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps ownerless sweeps alive with a local trace", async () => {
    const { subagent, run, readDiary } = await narrativeHarness("dreaming-ownerless-");
    await run({
      agentId: undefined,
      data: { phase: "light", snippets: ["An ownerless memory fragment."] },
    });
    expect(subagent.complete).not.toHaveBeenCalled();
    expect(await readDiary()).toContain("A memory trace surfaced");
  });

  it.for([false, true])(
    "detaches publication without an unhandled failure (reject=%s)",
    async (reject, { signal }) => {
      const { subagent, logger, run, readDiary } = await narrativeHarness("dreaming-detached-");
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
});

describe("runDreamNarrative deletion boundary", () => {
  it.each([
    { source: "tracked source", mutation: "forget" },
    { source: "prior diary", mutation: "forget" },
    { source: "prior diary", mutation: "unrelated append" },
  ] as const)(
    "validates $source before publishing generated quotes after $mutation",
    async ({ source, mutation }) => {
      const workspaceDir = await createTempWorkspace("dreaming-forget-generated-");
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, ".state"));
      const nowMs = Date.now();
      const claim = "The private cobalt archive opens every midnight.";
      const retainedClaim = "A public archive is open throughout the afternoon.";
      const sourcePath = "memory/2026-08-26.md";
      const dreamsPath = path.join(workspaceDir, "DREAMS.md");
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, sourcePath), `${claim}\n${retainedClaim}\n`);
      await fs.mkdir(path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR), { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR, "2026-08-26.txt"),
        `[main:forgotten-narrative-source#L1] ${claim}\n`,
      );
      await fs.writeFile(dreamsPath, "# Dream Diary\n\nA retained public diary entry.\n");
      await recordShortTermRecalls({
        workspaceDir,
        query: "archive opening time",
        signalType: "daily",
        nowMs,
        results: [claim, retainedClaim].map((snippet, index) => ({
          path: sourcePath,
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
      if (source === "prior diary") {
        await writeBackfillDiaryEntries({
          workspaceDir,
          preserveExisting: true,
          entries: [{ isoDay: "2026-08-26", bodyLines: [claim] }],
        });
      }
      const waiting = createDeferred<void>();
      const terminal = createDeferred<{ text: string }>();
      const reply = { text: `I remembered: ${claim}` };
      const subagent = {
        complete: vi.fn(async (_params: { message: string }) => {
          waiting.resolve();
          return await terminal.promise;
        }),
      };
      const data = {
        phase: "light" as const,
        snippets: entries.map((entry) => entry.snippet),
        sourceEntryKeys: entries.map((entry) => entry.key),
        ...(source === "prior diary"
          ? { recentDiaryEntries: await readRecentDreamDiaryEntries({ workspaceDir }) }
          : {}),
      };
      const logger = createLogger();
      const operation = runDreamNarrative({
        agentId: "main",
        timeoutMs: 180_000,
        subagent,
        workspaceDir,
        data,
        nowMs,
        logger,
      });
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
          expect(await fs.readFile(dreamsPath, "utf8")).not.toContain(claim);
        } else {
          // The original context remains valid even after it falls outside
          // the recent-entry window used to prepare the next narrative.
          await writeBackfillDiaryEntries({
            workspaceDir,
            preserveExisting: true,
            entries: Array.from({ length: 4 }, (_, index) => ({
              isoDay: "2026-08-26",
              bodyLines: [`Another retained diary entry ${index}.`],
            })),
          });
        }
        terminal.resolve(reply);
        const outcome = await operation;
        const content = await fs.readFile(dreamsPath, "utf8");
        expect(content).toContain("A retained public diary entry.");
        if (mutation === "forget") {
          expect(content).not.toContain(claim);
          expect(outcome).toEqual({ status: "skipped" });
          expectLogIncludes(logger.info, "narrative publication skipped");
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
