import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { withEngineStoreAdmission } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { openOpenClawStateDatabase } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { openOpenClawAgentSqliteWorkerStoreV2 } from "openclaw/plugin-sdk/sqlite-runtime";
import { describe, expect, it } from "vitest";
import { getMemorySearchManager } from "./index.js";
import { withMemoryMaintenanceAuthority } from "./maintenance-authority.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { memoryPostgresCleanupEntrypoint } from "./manager-postgres-cleanup-entrypoint.test-support.js";
import type { CleanupInspection } from "./manager-postgres-cleanup.worker.test-support.js";
import {
  publishPostgresMemoryStage,
  withPostgresMemoryReindex,
} from "./manager-postgres-reindex.js";
import { createPostgresIndexFixture } from "./postgres-index.test-support.js";

describe.each(["disconnect", "revocation"] as const)("PostgreSQL cleanup after %s", (cause) => {
  const fixture = createPostgresIndexFixture(
    `memory_cleanup_${cause}`,
    "postgres",
    (workspace) => ({
      database: { engine: "postgres" },
      plugins: { enabled: false },
      agents: { entries: { main: { workspace } } },
      memory: {
        search: { provider: "none", sources: ["memory"], store: { vector: { enabled: false } } },
      },
    }),
  );

  it.skipIf(fixture.unavailable)(
    "discards its stage while another borrower retains the connection",
    async () =>
      fixture.run(async () => {
        withEngineStoreAdmission(() => openOpenClawStateDatabase());
        await fs.mkdir(path.join(fixture.workspace, "memory"), { recursive: true });
        await fs.writeFile(path.join(fixture.workspace, "memory", "published.md"), "Kept fact.");
        const { manager, error } = await getMemorySearchManager({
          cfg: fixture.config,
          agentId: "main",
          purpose: "cli",
          runInBackgroundContext: fixture.run,
        });
        assert(manager, error ?? "Expected memory manager");
        assert(typeof manager.sync === "function", "Expected memory indexing support");
        await manager.sync({ reason: "cli", force: true });
        const published: unknown = Reflect.get(manager, "publishedDatabase");
        assert(published instanceof MemoryIndexDatabase);
        assert(published.writeOptions);
        const coBorrower = await openOpenClawAgentSqliteWorkerStoreV2<CleanupInspection>(
          published.writeOptions,
          { version: 2, assertCurrent: () => {} },
          {
            moduleUrl: resolveRuntimeWorkerUrl(memoryPostgresCleanupEntrypoint),
            input: undefined,
          },
        );
        const inspect = () => coBorrower.execute({ type: "inspect", input: undefined }, () => {});
        try {
          const before = await inspect();
          expect(before.stages).toEqual([]);
          expect(before.paths).toEqual(["memory/published.md"]);
          const controller = new AbortController();
          const revoked = new Error("maintenance authority revoked");
          const failed = new Error("rebuild interrupted");
          let current = true;
          const result = await withMemoryMaintenanceAuthority(
            () => {
              if (!current) {
                throw revoked;
              }
            },
            () =>
              withPostgresMemoryReindex(published, async (stage) => {
                await stage.replaceSource(
                  {
                    source: "memory",
                    entry: { path: "memory/unpublished.md", hash: "pending", mtimeMs: 1, size: 13 },
                    model: "fts-only",
                    now: 1,
                    vectorReady: false,
                    embeddings: [[]],
                    chunks: [
                      {
                        startLine: 1,
                        endLine: 1,
                        hash: "pending",
                        text: "Pending fact.",
                        importance: null,
                        triggers: null,
                        projectKey: null,
                      },
                    ],
                  },
                  () => {},
                  async () => true,
                );
                expect((await inspect()).stages).toHaveLength(1);
                if (cause === "disconnect") {
                  controller.abort(revoked);
                } else {
                  current = false;
                }
                await expect(
                  publishPostgresMemoryStage(
                    published,
                    stage,
                    published.facts.revision,
                    false,
                    () => {},
                  ),
                ).rejects.toBe(revoked);
                // Cleanup still has to obey its database owner's current authority.
                const ownerClosed = new Error("database owner closed");
                await expect(
                  published.executePublication(
                    { type: "database.stage.discard", input: { stageId: stage.postgresStageId! } },
                    () => {
                      throw ownerClosed;
                    },
                  ),
                ).rejects.toBe(ownerClosed);
                throw failed;
              }),
            controller.signal,
          ).catch((failure: unknown) => failure);
          await manager.close?.();
          const after = await inspect();
          expect(after).toEqual({ ...before, stages: [] });
          expect(result).toBe(failed);
        } finally {
          await manager.close?.();
          await coBorrower.close();
        }
      }),
  );
});
