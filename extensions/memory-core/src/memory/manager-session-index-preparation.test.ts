import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveRuntimeWorkerUrl, WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { expect, it } from "vitest";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import type { MemoryIndexTask, MemoryIndexTaskResult } from "./manager-cpu-worker-runtime.js";
import { prepareMemoryIndexInWorker } from "./manager-cpu-worker-runtime.js";
import {
  prepareMemoryIndexChunks,
  type MemoryIndexPreparationInput,
} from "./manager-index-preparation.js";
import {
  sessionIndexPages,
  type SessionIndexProgress,
} from "./manager-session-index-preparation.js";
import { resolveMemoryPathClassification } from "./memory-path-provenance.js";

function input(content: string): MemoryIndexPreparationInput {
  return {
    entry: { path: "synthetic-session", mtimeMs: 7 },
    source: "sessions",
    content,
    pathClassification: { curatedRoot: false, originClass: "untrusted" },
    chunking: { tokens: 400, overlap: 80 },
    provider: { id: "fixture", maxInputTokens: 8192 },
    hardMaxInputTokens: 8192,
  };
}

it("prepares an oversized high-cardinality transcript through the bounded production worker", async () => {
  // Seven million short lines overflowed the original 512 MiB isolate before it returned a chunk.
  const source = input(
    "HEAD_SEARCH_MARKER\n" + "User: synthetic\n".repeat(7_000_000) + "TAIL_SEARCH_MARKER",
  );
  const { chunks } = await prepareMemoryIndexInWorker(source);
  expect(chunks[0]?.text).toContain("HEAD_SEARCH_MARKER");
  expect(chunks.at(-1)?.text).toContain("TAIL_SEARCH_MARKER");
  expect(chunks.at(-1)?.endLine).toBe(7_000_002);
  expect(chunks.every((chunk) => !chunk.embeddingInput)).toBe(true);
}, 30_000);

it("preserves reset partitions, provenance and provider limits across source pages", async () => {
  const source = input(Array.from({ length: 1200 }, (_, i) => "User: fact " + i).join("\n"));
  source.entry.path = "MEMORY.md";
  source.pathClassification = await resolveMemoryPathClassification({
    absolutePath: "/synthetic/workspace/MEMORY.md",
    workspaceDir: "/synthetic/workspace",
    source: "sessions",
  });
  expect(source.pathClassification).toEqual({ curatedRoot: false, originClass: "untrusted" });
  source.entry.lineMap = Array.from({ length: 1200 }, (_, i) => i + 10);
  source.entry.lineProvenance = Array.from({ length: 1200 }, (_, i) => ({
    originClass: i < 600 ? ("owner" as const) : ("untrusted" as const),
    sessionKind: "interactive" as const,
    observedAt: i + 1,
  }));
  source.cutoffLine = 610;
  source.provider = { id: "fixture", maxInputTokens: 128 };
  const { chunks } = await prepareMemoryIndexInWorker(source);
  expect({ chunks }).toEqual(prepareMemoryIndexChunks(source));
  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks.every((chunk) => chunk.text.length <= 128)).toBe(true);
  expect(chunks.every((chunk) => chunk.endLine < 610 || chunk.startLine >= 610)).toBe(true);
  expect(chunks.find((chunk) => chunk.text.includes("fact 0"))?.provenance).toMatchObject({
    originClass: "owner",
  });
  expect(chunks.at(-1)?.provenance).toMatchObject({ originClass: "untrusted", observedAt: 1200 });
  expect(chunks.at(-1)?.endLine).toBe(1209);
});

it.each([{ lineMap: [] }, { lineMap: [1, 2] }])(
  "does not invent a reset boundary absent from line map %j",
  async ({ lineMap }) => {
    const source = input(Array.from({ length: 200 }, (_, i) => "User: fact " + i).join("\n"));
    source.entry.lineMap = lineMap;
    source.cutoffLine = 50;
    expect(await prepareMemoryIndexInWorker(source)).toEqual(prepareMemoryIndexChunks(source));
  },
);

it("keeps Unicode, overlap and giant-line boundaries independent of transport frames", async () => {
  const source = input("HEAD \u{20000}" + "word \u{20000}".repeat(10_000) + " TAIL\nNext line");
  const streamed = await prepareMemoryIndexInWorker(source);
  // The existing whole-document owner is an independent transport/framing oracle.
  expect(streamed).toEqual(prepareMemoryIndexChunks(source));
  expect(streamed.chunks[0]?.text).toContain("HEAD");
  expect(streamed.chunks.at(-1)?.text).toContain("Next line");
  for (const chunk of streamed.chunks) {
    expect(() => encodeURIComponent(chunk.text)).not.toThrow();
  }
});

it.each(["cancellation", "source failure"] as const)(
  "settles a stream after %s and permits a complete retry",
  async (failure) => {
    const pool = new WorkerTaskPool<MemoryIndexTask, MemoryIndexTaskResult>({
      workerUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.index),
      workerClass: "compute",
      workerOptions: {
        resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 },
      },
      maxWorkers: 1,
    });
    const controller = new AbortController();
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const source = input(
      "HEAD_SEARCH_MARKER\n" + "User: synthetic\n".repeat(2000) + "TAIL_SEARCH_MARKER",
    );
    const { content: _content, entry: _entry, ...settings } = source;
    const task: MemoryIndexTask = {
      kind: "prepare-session",
      input: { ...settings, entry: { path: "synthetic-session", mtimeMs: 7 } },
    };
    const pages = sessionIndexPages(source);
    let requests = 0;
    const chunks: SessionIndexProgress["chunks"] = [];
    const pending = pool.run(task, {
      signal: controller.signal,
      onRequest: async (value) => {
        const progress = value as SessionIndexProgress;
        chunks.push(...progress.chunks);
        requests++;
        if (requests === 2) {
          entered.resolve();
          await resume.promise;
          if (failure === "source failure") {
            throw new Error("source page unavailable");
          }
        }
        return { input: pages.next().value ?? { lines: [], done: true }, timeoutMs: 60_000 };
      },
    });
    const observed = pending.catch((error: unknown) => error);
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Stream completed before the blocked source page");
        }),
      ]);
      expect(chunks[0]?.text).toContain("HEAD_SEARCH_MARKER");
      expect(chunks.some((chunk) => chunk.text.includes("TAIL_SEARCH_MARKER"))).toBe(false);
      if (failure === "cancellation") {
        controller.abort(new Error("cancelled fixture"));
      }
      resume.resolve();
      await expect(pending).rejects.toThrow(
        failure === "cancellation" ? "cancelled fixture" : "source page unavailable",
      );
      const retryPages = sessionIndexPages(source);
      const retried: SessionIndexProgress["chunks"] = [];
      await expect(
        pool.run(task, {
          onRequest: async (value) => {
            retried.push(...(value as SessionIndexProgress).chunks);
            return {
              input: retryPages.next().value ?? { lines: [], done: true },
              timeoutMs: 60_000,
            };
          },
        }),
      ).resolves.toMatchObject({ kind: "prepared" });
      expect(retried[0]?.text).toContain("HEAD_SEARCH_MARKER");
      expect(retried.at(-1)?.text).toContain("TAIL_SEARCH_MARKER");
      expect(pool.getSnapshot()).toMatchObject({ activeTasks: 0, pendingTasks: 0 });
    } finally {
      resume.resolve();
      await observed;
      await pool.close();
    }
  },
);
