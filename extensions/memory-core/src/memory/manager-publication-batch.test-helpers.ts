import { channel } from "node:diagnostics_channel";
import {
  withEngineStoreAdmission,
  type EngineConnection,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { expect, it } from "vitest";
import type { MemoryPublicationState } from "./manager-publication-task.js";
import { memoryPublicationInline } from "./manager-publication-transfer.js";
import type { bindSqliteWorkerBackend } from "./manager-publication.worker.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import { readMemoryDatabaseFacts } from "./manager-retrieval-read.js";
import type { MemorySourceIndexReplacement } from "./manager-source-index-kernel.js";

type PublicationBatchTestContext = {
  pg: () => EngineConnection;
  replacement: (name: string) => MemorySourceIndexReplacement;
  state: MemoryPublicationState;
  metadata: MemoryIndexMeta;
};

export function registerPublicationBatchTests(
  { pg, replacement, state, metadata }: PublicationBatchTestContext,
  getBackend: () => ReturnType<typeof bindSqliteWorkerBackend>,
  setDenyCommit: (denied: boolean) => void,
): void {
  const execute: ReturnType<typeof bindSqliteWorkerBackend>["execute"] = (command) =>
    getBackend().execute(command);
  it.each(["group", "staged"] as const)(
    "batches ten sources into one write per row family through %s publication",
    (mode) =>
      withEngineStoreAdmission(() => {
        const prior = replacement("kept");
        expect(
          execute({
            type: "source.replace.inline",
            input: { ...memoryPublicationInline(prior)!, state },
          }),
        ).toMatchObject({ ok: true });
        const values = Array.from({ length: 10 }, (_source, sourceIndex) => {
          const value = replacement(`group-${sourceIndex}`);
          const chunks = Array.from({ length: 10 }, (_chunk, chunkIndex) => ({
            ...value.chunks[0]!,
            startLine: chunkIndex + 1,
            endLine: chunkIndex + 1,
            hash: `group-${sourceIndex}-${chunkIndex}`,
            text: `group${sourceIndex} chunk${chunkIndex}`,
            importance: sourceIndex + 1,
            provenance: {
              originClass: "owner" as const,
              sessionKind: "interactive" as const,
              observedAt: 200 + sourceIndex,
            },
          }));
          return {
            ...value,
            entry: {
              ...value.entry,
              size: chunks.reduce((size, chunk) => size + chunk.text.length, 0),
            },
            chunks,
            embeddings: chunks.map(() => [1, 0, 0]),
            now: 200 + sourceIndex,
          };
        });
        const group = {
          type: "source.replace.group",
          input: { sources: values.map((value) => memoryPublicationInline(value)!), state },
        } as const;
        const capture = () => ({
          rows: pg()
            .prepare(`SELECT c.path, c.start_line, c.text, c.updated_at,
            r.importance, p.origin_class, v.embedding::text AS vector
            FROM memory_index_chunks c
            JOIN memory_index_chunk_recall_metadata r ON r.chunk_id = c.id
            JOIN memory_index_chunk_provenance p ON p.chunk_id = c.id
            JOIN memory_index_chunks_vec v USING (id)
            ORDER BY c.path, c.start_line`)
            .all(),
          sources: pg()
            .prepare("SELECT path, hash, mtime, size FROM memory_index_sources ORDER BY path")
            .all(),
          revision: readMemoryDatabaseFacts(pg()).revision,
        });
        const before = capture();
        if (mode === "staged") {
          expect(execute({ type: "database.stage.start", input: undefined })).toMatchObject({
            ok: true,
          });
          expect(execute(group)).toMatchObject({ ok: true });
          expect(execute({ type: "index.writeMetadata", input: metadata })).toMatchObject({
            ok: true,
          });
          expect(capture()).toEqual(before);
        }
        const publish = () =>
          execute(
            mode === "group"
              ? group
              : {
                  type: "database.stage.publish",
                  input: { expectedRevision: before.revision, vectorIndexComplete: true },
                },
          );
        setDenyCommit(true);
        expect(publish()).toMatchObject({
          ok: false,
          committed: false,
          error: { message: "publication authority revoked" },
        });
        expect(capture()).toEqual(before);
        setDenyCommit(false);

        const insertedTables: string[] = [];
        const observations = channel("openclaw.database.statement");
        const listener = (message: unknown) => {
          const event = message as { engine: string; sql: string };
          const table =
            event.engine === "postgres"
              ? /^insert into "(memory_index_chunks|memory_index_chunk_recall_metadata|memory_index_chunk_provenance)"\s/iu.exec(
                  event.sql,
                )?.[1]
              : undefined;
          if (table) {
            insertedTables.push(table);
          }
        };
        observations.subscribe(listener);
        try {
          expect(publish()).toMatchObject({ ok: true, facts: { revision: before.revision + 1 } });
        } finally {
          observations.unsubscribe(listener);
        }
        const expected = mode === "group" ? [...values, prior] : values;
        expect(capture()).toEqual({
          rows: expected.flatMap((value) =>
            value.chunks.map((chunk) => ({
              path: value.entry.path,
              start_line: chunk.startLine,
              text: chunk.text,
              updated_at: value.now,
              importance: chunk.importance,
              origin_class: chunk.provenance?.originClass ?? "untrusted",
              vector: "[1,0,0]",
            })),
          ),
          sources: expected.map(({ entry }) => ({
            path: entry.path,
            hash: entry.hash,
            mtime: entry.mtimeMs,
            size: entry.size,
          })),
          revision: before.revision + 1,
        });
        expect(
          pg()
            .prepare(
              "SELECT path FROM memory_index_chunks WHERE openclaw_search @@ plainto_tsquery('simple', ?) ORDER BY path",
            )
            .all("group3"),
        ).toEqual(Array.from({ length: 10 }, () => ({ path: "memory/group-3.md" })));
        expect(insertedTables.toSorted()).toEqual([
          "memory_index_chunk_provenance",
          "memory_index_chunk_recall_metadata",
          "memory_index_chunks",
        ]);
      }),
  );
}
