import path from "node:path";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect } from "vitest";
import { memoryPublicationInline } from "./manager-publication-transfer.js";
import { bindSqliteWorkerBackend } from "./manager-publication.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

export function createPublication({
  filename = path.join(tempDirs.make("memory-publication-"), "index.sqlite"),
  cacheEnabled = false,
  ftsEnabled = false,
  initialize = true,
} = {}) {
  const db = openNodeSqliteDatabase(filename);
  const admission = { denied: false };
  const backend = bindSqliteWorkerBackend(
    { kind: "agent" },
    {
      databasePath: filename,
      database: db,
      admit(stage) {
        if (stage === "commit" && admission.denied) {
          throw new Error("publication authority revoked");
        }
      },
    },
  );
  const close = () => {
    backend.close();
    db.close();
  };
  try {
    if (initialize) {
      ensureMemoryIndexSchema({ db, cacheEnabled, ftsEnabled });
    }
  } catch (error) {
    close();
    throw error;
  }
  return {
    filename,
    db,
    backend,
    admission,
    expectResult: (
      command: Parameters<typeof backend.execute>[0],
      expected: object = { ok: true },
    ) => {
      expect(backend.execute(command)).toMatchObject(expected);
    },
    [Symbol.dispose]: close,
  };
}

export const publicationState = {
  vector: { enabled: false, available: false },
  fts: { enabled: true, available: true },
  hasVectorTable: false,
};

export function publicationReplacement(text: string) {
  return {
    state: publicationState,
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
