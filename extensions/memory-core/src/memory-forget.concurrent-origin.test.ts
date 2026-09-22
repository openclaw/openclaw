import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as storage from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listMemoryEntryOrigins,
  listMemorySessionTombstones,
  recordMemoryEntryOrigins,
} from "./memory-entry-origins.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  createMemoryForgetFixture,
  seedMemoryForgetSession,
} from "./memory-forget.test-helpers.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";

describe("Forget with origins committed by another workspace", () => {
  let fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>;
  beforeEach(async () => {
    fixture = await createMemoryForgetFixture("forget-concurrent-origin-");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.cleanup();
  });

  it.each(["before planning", "during planning"] as const)(
    "removes selected lineage committed %s while preserving unrelated content",
    async (timing) => {
      await seedMemoryForgetSession("target");
      const otherWorkspace = path.join(fixture.stateDir, "other-workspace");
      await fs.mkdir(otherWorkspace);
      const memoryPath = path.join(fixture.workspaceDir, "MEMORY.md");
      const survivor = "Unrelated amber detail stays.\n";
      const content =
        "<!-- openclaw-memory-promotion:late-lineage -->\n- Selected violet detail.\n" + survivor;
      await fs.writeFile(memoryPath, content);
      const { db } = openOpenClawAgentDatabase({ agentId: "main" });
      db.prepare(`INSERT INTO memory_index_chunks
        (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES ('selected-snapshot', 'MEMORY.md', 'memory', 1, 3, 'fixture', 'test', ?, x'', 1)`).run(
        content,
      );
      const publishOrigin = () =>
        withMemoryWorkspaceLock(otherWorkspace, async () => {
          recordMemoryEntryOrigins({
            agentId: "main",
            origins: [
              {
                entryKey: "late-lineage",
                agentId: "main",
                sessionId: "target",
                sessionKey: null,
                originClass: "owner",
                observedAt: 1,
              },
            ],
          });
        });
      const planning = createDeferred<void>();
      const resume = createDeferred<void>();
      if (timing === "before planning") {
        await publishOrigin();
      } else {
        const list = storage.listMemoryFiles;
        vi.spyOn(storage, "listMemoryFiles").mockImplementationOnce(async (...args) => {
          const files = await list(...args);
          planning.resolve();
          await resume.promise;
          return files;
        });
      }
      const forgetting = forgetMemoryEntries({
        cfg: fixture.cfg,
        agentId: "main",
        sessionIds: ["target"],
      });
      void forgetting.catch(() => undefined);
      try {
        if (timing === "during planning") {
          await Promise.race([
            planning.promise,
            forgetting.then(() => {
              throw new Error("Forget completed before its actual file-planning boundary");
            }),
          ]);
          await publishOrigin();
          expect(listMemoryEntryOrigins({ agentId: "main" })).toMatchObject([
            { entryKey: "late-lineage", sessionId: "target" },
          ]);
          resume.resolve();
        }
        const report = await forgetting;
        const durable = {
          entryKeys: report.entryKeys,
          memory: await fs.readFile(memoryPath, "utf8"),
          index: db.prepare("SELECT id FROM memory_index_chunks").all(),
          origins: listMemoryEntryOrigins({ agentId: "main" }),
          targetTombstoned: listMemorySessionTombstones({ agentId: "main" }).some(
            ({ sessionId }) => sessionId === "target",
          ),
        };
        expect(durable).toEqual({
          entryKeys: ["late-lineage"],
          memory: survivor,
          index: [],
          origins: [],
          targetTombstoned: true,
        });
      } finally {
        resume.resolve();
        await Promise.allSettled([forgetting]);
      }
    },
  );
});
