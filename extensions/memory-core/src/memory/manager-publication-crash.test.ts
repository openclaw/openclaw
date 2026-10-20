import { spawnSync } from "node:child_process";
import path from "node:path";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { memoryPublicationCrashEntrypoint } from "./manager-publication-crash-entrypoint.test-support.js";
import type { MemoryPublicationOperations } from "./manager-publication-task.js";
import { memoryPublicationInline } from "./manager-publication-transfer.js";
import { bindSqliteWorkerBackend } from "./manager-publication.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function replacement(text: string): MemoryPublicationOperations["source.replace.group"]["input"] {
  return {
    state: {
      vector: { enabled: false, available: false },
      fts: { enabled: true, available: true },
      hasVectorTable: false,
    },
    sources: ["first", "second"].map((name) =>
      memoryPublicationInline({
        source: "memory",
        entry: { path: `memory/${name}.md`, hash: text, mtimeMs: 1, size: text.length },
        model: "fts-only",
        now: 1,
        vectorReady: false,
        embeddings: [[], []],
        chunks: [1, 2].map((line) => ({
          startLine: line,
          endLine: line,
          hash: `${text}-${line}`,
          text: `${text} ${line}`,
          importance: null,
          triggers: null,
          projectKey: null,
        })),
      })!,
    ),
  };
}

it.skipIf(process.platform === "win32")(
  "recovers rows and revision together after a publication process dies before commit",
  () => {
    const root = tempDirs.make("memory-publication-crash-");
    const databasePath = path.join(root, "index.sqlite");
    const initial = openNodeSqliteDatabase(databasePath);
    const seed = bindSqliteWorkerBackend(
      { kind: "agent" },
      { databasePath, database: initial, admit: () => undefined },
    );
    try {
      ensureMemoryIndexSchema({ db: initial, cacheEnabled: false, ftsEnabled: true });
      expect(
        seed.execute({ type: "source.replace.group", input: replacement("original") }),
      ).toMatchObject({
        ok: true,
        facts: { revision: 1 },
      });
    } finally {
      seed.close();
      initial.close();
    }

    const crashed = spawnSync(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(memoryPublicationCrashEntrypoint)),
        databasePath,
        JSON.stringify(replacement("discarded")),
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: root,
          OPENCLAW_STATE_DIR: root,
          NODE_DISABLE_COMPILE_CACHE: "1",
        },
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
      },
    );
    expect(crashed.error, crashed.stderr).toBeUndefined();
    expect(crashed.signal, crashed.stderr).toBe("SIGKILL");
    expect(JSON.parse(crashed.stdout)).toEqual({
      inTransaction: true,
      revision: 2,
      sources: [
        { path: "memory/first.md", hash: "discarded" },
        { path: "memory/second.md", hash: "discarded" },
      ],
      chunks: [
        { path: "memory/first.md", text: "discarded 1" },
        { path: "memory/first.md", text: "discarded 2" },
        { path: "memory/second.md", text: "discarded 1" },
        { path: "memory/second.md", text: "discarded 2" },
      ],
    });

    const reopened = openNodeSqliteDatabase(databasePath);
    const retry = bindSqliteWorkerBackend(
      { kind: "agent" },
      { databasePath, database: reopened, admit: () => undefined },
    );
    const readChunks = () =>
      reopened
        .prepare("SELECT path, text FROM memory_index_chunks ORDER BY path, start_line")
        .all();
    try {
      expect(
        reopened.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get(),
      ).toEqual({ revision: 1 });
      expect(
        reopened.prepare("SELECT path, hash FROM memory_index_sources ORDER BY path").all(),
      ).toEqual([
        { path: "memory/first.md", hash: "original" },
        { path: "memory/second.md", hash: "original" },
      ]);
      expect(readChunks()).toEqual([
        { path: "memory/first.md", text: "original 1" },
        { path: "memory/first.md", text: "original 2" },
        { path: "memory/second.md", text: "original 1" },
        { path: "memory/second.md", text: "original 2" },
      ]);
      expect(
        retry.execute({ type: "source.replace.group", input: replacement("replacement") }),
      ).toMatchObject({
        ok: true,
        facts: { revision: 2 },
      });
      expect(readChunks()).toEqual([
        { path: "memory/first.md", text: "replacement 1" },
        { path: "memory/first.md", text: "replacement 2" },
        { path: "memory/second.md", text: "replacement 1" },
        { path: "memory/second.md", text: "replacement 2" },
      ]);
    } finally {
      retry.close();
      reopened.close();
    }
  },
);
