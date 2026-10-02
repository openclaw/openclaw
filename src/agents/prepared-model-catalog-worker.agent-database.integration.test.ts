import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  closeDeletedAgentDatabases,
  reviveAgentDatabases,
} from "../state/openclaw-agent-db-readers.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { PROVIDER_ID } from "./prepared-model-catalog-worker.test-support.js";
import { loadPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import { retirePreparedModelRuntimeAgent } from "./prepared-model-runtime.js";
import { createCatalogFleetFixture } from "./test-helpers/prepared-model-catalog-fleet-fixture.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();
const createFleetFixture = createCatalogFleetFixture(makeTempDir);

// Leaving WAL needs an exclusive lock, which any connection in this process still refuses.
function leaveWalMode(databasePath: string): unknown {
  const db = new DatabaseSync(databasePath, { timeout: 0 });
  try {
    return db.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode;
  } finally {
    db.close();
  }
}

describe("Gateway catalog worker agent database readers", () => {
  it("closes one agent's database readers without retiring the shared worker", async () => {
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-worker-empty-codex-"));
    const spawned: Worker[] = [];
    const workerChannel = channel("worker_threads");
    const recordWorker = (message: unknown) => {
      if (isRecord(message) && message.worker instanceof Worker) {
        spawned.push(message.worker);
      }
    };
    try {
      const fixture = await createFleetFixture(() => workerChannel.subscribe(recordWorker));
      await Promise.all(
        fixture.snapshots.map((snapshot) =>
          loadPreparedModelRuntimeAuth(snapshot, { providerIds: [PROVIDER_ID] }),
        ),
      );
      expect(spawned).toHaveLength(1);
      const [deleted, survivor] = fixture.agentIds.map((agentId) =>
        path.join(fixture.entries[agentId]!.agentDir, "openclaw-agent.sqlite"),
      );
      await retirePreparedModelRuntimeAgent({
        agentId: fixture.agentIds[0]!,
        agentDirs: [path.dirname(deleted!)],
      });
      closeOpenClawAgentDatabasesForTest();

      try {
        await closeDeletedAgentDatabases(fixture.agentIds[0]!, [deleted!]);

        expect(leaveWalMode(deleted!)).toBe("delete");
        expect(() => leaveWalMode(survivor!)).toThrow(/locked/);
        expect(spawned).toHaveLength(1);
        expect(spawned[0]!.threadId).not.toBe(-1);
      } finally {
        await reviveAgentDatabases([fixture.agentIds[0]!]);
      }
    } finally {
      workerChannel.unsubscribe(recordWorker);
    }
  });
});
