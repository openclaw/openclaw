import { setImmediate } from "node:timers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { openOpenClawStateDatabase } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SHORT_TERM_META_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  memoryCoreWorkspaceStateKey,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";
import {
  listMemoryEntryOrigins,
  listMemorySessionTombstones,
  recordMemoryEntryOrigins,
} from "./memory-entry-origins.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  closeMemoryForgetFixture,
  createMemoryForgetFixture,
  seedMemoryForgetSession,
} from "./memory-forget.test-helpers.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import { readPhaseSignalStore, writePhaseSignalStore } from "./short-term-promotion-store.js";
import type {
  ShortTermPhaseSignalEntry,
  ShortTermRecallEntry,
} from "./short-term-promotion-types.js";

const observedAt = "2026-09-11T00:00:00.000Z";

function recallEntry(key: string): ShortTermRecallEntry {
  return {
    key,
    path: "memory/2026-09-11.md",
    startLine: 1,
    endLine: 1,
    source: "memory",
    snippet: `Synthetic memory fact for ${key}.`,
    recallCount: 1,
    dailyCount: 0,
    groundedCount: 0,
    totalScore: 0.8,
    maxScore: 0.8,
    firstRecalledAt: observedAt,
    lastRecalledAt: observedAt,
    queryHashes: ["synthetic-query"],
    recallDays: ["2026-09-11"],
    conceptTags: [],
  };
}

describe("memory forget phase-signal failures", () => {
  let workspaceDir: string;
  let cfg: OpenClawConfig;

  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      closeMemoryForgetFixture();
      cleanup();
    }),
  );

  beforeEach(async () => {
    ({ workspaceDir, cfg } = await createMemoryForgetFixture(
      tempDirs.make("openclaw-memory-forget-phase-"),
    ));
  });

  async function seedEntries(survivorKeys: string[]) {
    await seedMemoryForgetSession("target");
    await seedMemoryForgetSession("survivor");
    const keys = ["target-entry", ...survivorKeys];
    const recalls = keys.map((key) => ({ key, value: recallEntry(key) }));
    const phases: Record<string, ShortTermPhaseSignalEntry> = Object.fromEntries(
      keys.map((key) => [
        key,
        { key, lightHits: 2, remHits: 1, lastLightAt: observedAt, lastRemAt: observedAt },
      ]),
    );
    recordMemoryEntryOrigins({
      agentId: "main",
      origins: keys.map((entryKey) => ({
        entryKey,
        agentId: "main",
        sessionId: entryKey === "target-entry" ? "target" : "survivor",
        sessionKey: entryKey === "target-entry" ? "agent:main:target" : "agent:main:survivor",
        originClass: "owner" as const,
        observedAt: Date.parse(observedAt),
      })),
    });
    await writeMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      workspaceDir,
      entries: recalls,
    });
    await writePhaseSignalStore(workspaceDir, {
      version: 1,
      updatedAt: observedAt,
      entries: phases,
    });
    return { recalls, phases, origins: listMemoryEntryOrigins({ agentId: "main" }) };
  }

  it("preserves a later phase write after phase metadata failure", async () => {
    // Eleven retained writes cross the workspace store's cooperative yield.
    const survivorKeys = Array.from({ length: 11 }, (_, index) => `survivor-${index}`);
    const before = await seedEntries(survivorKeys);
    await writeMemoryCoreWorkspaceEntry({
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      workspaceDir,
      key: "later-entry",
      value: recallEntry("later-entry"),
    });
    const db = openOpenClawStateDatabase().db;
    const workspaceKey = memoryCoreWorkspaceStateKey(workspaceDir);
    const deletionSettled = createDeferred<void>();
    let metadataFailureObserved = false;
    db.function("observe_phase_metadata_failure", () => {
      metadataFailureObserved = true;
      return 0;
    });
    db.function("observe_target_phase_deletion", () => {
      // Only two deletions remain after the 11 registrations, with no further
      // store yield. This callback joins their committed microtask continuations.
      setImmediate(deletionSettled.resolve);
      return 0;
    });
    db.exec(`
      CREATE TEMP TRIGGER abort_phase_metadata BEFORE UPDATE ON plugin_state_entries
      WHEN OLD.plugin_id = 'memory-core'
        AND OLD.namespace = '${SHORT_TERM_META_NAMESPACE}'
        AND json_extract(OLD.value_json, '$.workspaceKey') = '${workspaceKey}'
        AND json_extract(OLD.value_json, '$.key') = 'phase'
      BEGIN
        SELECT observe_phase_metadata_failure();
        SELECT RAISE(ABORT, 'synthetic phase metadata failure');
      END;
      CREATE TEMP TRIGGER observe_target_phase_delete AFTER DELETE ON plugin_state_entries
      WHEN OLD.plugin_id = 'memory-core'
        AND OLD.namespace = '${SHORT_TERM_PHASE_SIGNAL_NAMESPACE}'
        AND json_extract(OLD.value_json, '$.workspaceKey') = '${workspaceKey}'
        AND json_extract(OLD.value_json, '$.key') = 'target-entry'
      BEGIN SELECT observe_target_phase_deletion(); END;
    `);
    const laterPhase: ShortTermPhaseSignalEntry = {
      key: "later-entry",
      lightHits: 7,
      remHits: 2,
      lastLightAt: observedAt,
      lastRemAt: observedAt,
    };

    try {
      const outcome = await forgetMemoryEntries({
        cfg,
        agentId: "main",
        sessionIds: ["target"],
      }).then(
        (report) => ({ status: "resolved", report }),
        (error: unknown) => ({ status: "rejected", error }),
      );
      db.exec("DROP TRIGGER abort_phase_metadata");
      await withMemoryWorkspaceLock(workspaceDir, () =>
        writeMemoryCoreWorkspaceEntry({
          namespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
          workspaceDir,
          key: "later-entry",
          value: laterPhase,
        }),
      );
      if (metadataFailureObserved) {
        await deletionSettled.promise;
      }
      expect(outcome).toMatchObject({
        status: "rejected",
        error: { cause: { message: "synthetic phase metadata failure" } },
      });
      const phases = await readPhaseSignalStore(workspaceDir, observedAt);
      expect(phases.entries["later-entry"]).toEqual(laterPhase);
      expect(phases.entries["target-entry"]).toBeUndefined();
      for (const key of survivorKeys) {
        expect(phases.entries[key]).toEqual(before.phases[key]);
      }
      expect(
        await readMemoryCoreWorkspaceEntries<ShortTermRecallEntry>({
          namespace: SHORT_TERM_RECALL_NAMESPACE,
          workspaceDir,
        }),
      ).toEqual(expect.arrayContaining(before.recalls));
      expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual(before.origins);
      const tombstones = listMemorySessionTombstones({ agentId: "main" });
      expect(tombstones).toMatchObject([{ sessionId: "target", reason: "forgotten" }]);

      await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"] });
      expect(
        (
          await readMemoryCoreWorkspaceEntries({
            namespace: SHORT_TERM_RECALL_NAMESPACE,
            workspaceDir,
          })
        ).map(({ key }) => key),
      ).not.toContain("target-entry");
      expect(listMemoryEntryOrigins({ agentId: "main", sessionIds: ["target"] })).toEqual([]);
      expect(listMemorySessionTombstones({ agentId: "main" })).toEqual(tombstones);
      expect((await readPhaseSignalStore(workspaceDir, observedAt)).entries).toEqual(
        phases.entries,
      );
    } finally {
      db.exec("DROP TRIGGER IF EXISTS abort_phase_metadata");
      if (metadataFailureObserved) {
        await deletionSettled.promise;
      }
      db.exec("DROP TRIGGER observe_target_phase_delete");
    }
  });

  it.each([
    { failure: "phase", namespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE, targetPhaseRemains: true },
    { failure: "recall", namespace: SHORT_TERM_RECALL_NAMESPACE, targetPhaseRemains: false },
  ])(
    "retains retry evidence after $failure row deletion fails",
    async ({ namespace, targetPhaseRemains }) => {
      const before = await seedEntries(["survivor-entry"]);
      const db = openOpenClawStateDatabase().db;
      const workspaceKey = memoryCoreWorkspaceStateKey(workspaceDir);
      db.exec(`
        CREATE TEMP TRIGGER abort_target_delete BEFORE DELETE ON plugin_state_entries
        WHEN OLD.plugin_id = 'memory-core'
          AND OLD.namespace = '${namespace}'
          AND json_extract(OLD.value_json, '$.workspaceKey') = '${workspaceKey}'
          AND json_extract(OLD.value_json, '$.key') = 'target-entry'
        BEGIN SELECT RAISE(ABORT, 'synthetic target deletion failure'); END;
      `);
      try {
        await expect(
          forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"] }),
        ).rejects.toMatchObject({ cause: { message: "synthetic target deletion failure" } });
      } finally {
        db.exec("DROP TRIGGER abort_target_delete");
      }
      expect(
        await readMemoryCoreWorkspaceEntries<ShortTermRecallEntry>({
          namespace: SHORT_TERM_RECALL_NAMESPACE,
          workspaceDir,
        }),
      ).toEqual(expect.arrayContaining(before.recalls));
      expect(listMemoryEntryOrigins({ agentId: "main" })).toEqual(before.origins);
      const phases = await readPhaseSignalStore(workspaceDir, observedAt);
      expect(phases.entries["target-entry"]).toEqual(
        targetPhaseRemains ? before.phases["target-entry"] : undefined,
      );
      expect(phases.entries["survivor-entry"]).toEqual(before.phases["survivor-entry"]);
      const tombstones = listMemorySessionTombstones({ agentId: "main" });
      expect(tombstones).toMatchObject([{ sessionId: "target", reason: "forgotten" }]);

      await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"] });
      expect(
        await readMemoryCoreWorkspaceEntries<ShortTermRecallEntry>({
          namespace: SHORT_TERM_RECALL_NAMESPACE,
          workspaceDir,
        }),
      ).toEqual([{ key: "survivor-entry", value: recallEntry("survivor-entry") }]);
      expect((await readPhaseSignalStore(workspaceDir, observedAt)).entries).toEqual({
        "survivor-entry": before.phases["survivor-entry"],
      });
      expect(listMemoryEntryOrigins({ agentId: "main", sessionIds: ["target"] })).toEqual([]);
      expect(listMemoryEntryOrigins({ agentId: "main", sessionIds: ["survivor"] })).toEqual(
        before.origins.filter(({ sessionId }) => sessionId === "survivor"),
      );
      expect(listMemorySessionTombstones({ agentId: "main" })).toEqual(tombstones);
    },
  );
});
