import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { openOpenClawStateDatabase } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHORT_TERM_META_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  memoryCoreWorkspaceStateKey,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";
import { listMemoryEntryOrigins, recordMemoryEntryOrigins } from "./memory-entry-origins.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  createMemoryForgetFixture,
  seedMemoryForgetSession,
} from "./memory-forget.test-helpers.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import { readPhaseSignalStore, writePhaseSignalStore } from "./short-term-promotion-store.js";
import type {
  ShortTermPhaseSignalEntry,
  ShortTermRecallEntry,
} from "./short-term-promotion-types.js";
import { readMemoryForgetTombstonesForTest } from "./test-helpers.js";

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
  const forget = () => forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"] });
  const tombstones = () => readMemoryForgetTombstonesForTest({ agentId: "main" });
  const origins = (filter: Omit<Parameters<typeof listMemoryEntryOrigins>[0], "agentId"> = {}) =>
    listMemoryEntryOrigins({ agentId: "main", ...filter });
  let fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>;
  let workspaceDir: string;
  let cfg: OpenClawConfig;
  const readRecalls = () =>
    readMemoryCoreWorkspaceEntries<ShortTermRecallEntry>({
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      workspaceDir,
    });
  const readPhases = async () => (await readPhaseSignalStore(workspaceDir, observedAt)).entries;
  function abortWrite(event: string, namespace: string, key: string, message: string) {
    const db = openOpenClawStateDatabase().db;
    db.exec(`CREATE TRIGGER abort_write ${event} ON plugin_state_entries
      WHEN OLD.plugin_id = 'memory-core' AND OLD.namespace = '${namespace}'
        AND json_extract(OLD.value_json, '$.workspaceKey') = '${memoryCoreWorkspaceStateKey(workspaceDir)}'
        AND json_extract(OLD.value_json, '$.key') = '${key}'
      BEGIN SELECT RAISE(ABORT, '${message}'); END;`);
    return () => db.exec("DROP TRIGGER IF EXISTS abort_write");
  }

  afterEach(async () => {
    await fixture.cleanup();
  });

  beforeEach(async () => {
    fixture = await createMemoryForgetFixture("openclaw-memory-forget-phase-");
    ({ workspaceDir, cfg } = fixture);
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
    await recordMemoryEntryOrigins({
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
    return { recalls, phases, origins: await origins() };
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
    const rowsSettled = createDeferred<void>();
    const restore = abortWrite(
      "BEFORE UPDATE",
      SHORT_TERM_META_NAMESPACE,
      "phase",
      "synthetic phase metadata failure",
    );
    const writeEntries = writeMemoryCoreWorkspaceEntries;
    let rowsStarted = false;
    const rowWrites = vi
      .spyOn(await import("./dreaming-state.js"), "writeMemoryCoreWorkspaceEntries")
      .mockImplementation(async (params) => {
        if (params.namespace === SHORT_TERM_PHASE_SIGNAL_NAMESPACE) {
          rowsStarted = true;
        }
        try {
          await writeEntries(params);
        } finally {
          if (params.namespace === SHORT_TERM_PHASE_SIGNAL_NAMESPACE) {
            rowsSettled.resolve();
          }
        }
      });
    const laterPhase: ShortTermPhaseSignalEntry = {
      key: "later-entry",
      lightHits: 7,
      remHits: 2,
      lastLightAt: observedAt,
      lastRemAt: observedAt,
    };

    try {
      const outcome = await forget().then(
        (report) => ({ status: "resolved", report }),
        (error: unknown) => ({ status: "rejected", error }),
      );
      restore();
      await withMemoryWorkspaceLock(workspaceDir, () =>
        writeMemoryCoreWorkspaceEntry({
          namespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
          workspaceDir,
          key: "later-entry",
          value: laterPhase,
        }),
      );
      await rowsSettled.promise;
      expect(outcome).toMatchObject({
        status: "rejected",
        error: { cause: { message: "synthetic phase metadata failure" } },
      });
      const storedPhases = await readPhases();
      expect(storedPhases["later-entry"]).toEqual(laterPhase);
      expect(storedPhases["target-entry"]).toBeUndefined();
      for (const key of survivorKeys) {
        expect(storedPhases[key]).toEqual(before.phases[key]);
      }
      expect(await readRecalls()).toEqual(expect.arrayContaining(before.recalls));
      expect(await origins()).toEqual(before.origins);
      const savedTombstones = tombstones();
      expect(savedTombstones).toMatchObject([{ sessionId: "target", reason: "forgotten" }]);

      await forget();
      expect((await readRecalls()).map(({ key }) => key)).not.toContain("target-entry");
      expect(await origins({ sessionIds: ["target"] })).toEqual([]);
      expect(tombstones()).toEqual(savedTombstones);
      expect(await readPhases()).toEqual(storedPhases);
    } finally {
      restore();
      if (rowsStarted) {
        await rowsSettled.promise;
      }
      rowWrites.mockRestore();
    }
  });

  it.each([
    { failure: "phase", namespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE, targetPhaseRemains: true },
    { failure: "recall", namespace: SHORT_TERM_RECALL_NAMESPACE, targetPhaseRemains: false },
  ])(
    "retains retry evidence after $failure row deletion fails",
    async ({ namespace, targetPhaseRemains }) => {
      const before = await seedEntries(["survivor-entry"]);
      const restore = abortWrite(
        "BEFORE DELETE",
        namespace,
        "target-entry",
        "synthetic target deletion failure",
      );
      try {
        await expect(forget()).rejects.toMatchObject({
          cause: { message: "synthetic target deletion failure" },
        });
      } finally {
        restore();
      }
      expect(await readRecalls()).toEqual(expect.arrayContaining(before.recalls));
      expect(await origins()).toEqual(before.origins);
      const storedPhases = await readPhases();
      expect(storedPhases["target-entry"]).toEqual(
        targetPhaseRemains ? before.phases["target-entry"] : undefined,
      );
      expect(storedPhases["survivor-entry"]).toEqual(before.phases["survivor-entry"]);
      const savedTombstones = tombstones();
      expect(savedTombstones).toMatchObject([{ sessionId: "target", reason: "forgotten" }]);

      await forget();
      expect(await readRecalls()).toEqual([
        { key: "survivor-entry", value: recallEntry("survivor-entry") },
      ]);
      expect(await readPhases()).toEqual({
        "survivor-entry": before.phases["survivor-entry"],
      });
      expect(await origins({ sessionIds: ["target"] })).toEqual([]);
      expect(await origins({ sessionIds: ["survivor"] })).toEqual(
        before.origins.filter(({ sessionId }) => sessionId === "survivor"),
      );
      expect(tombstones()).toEqual(savedTombstones);
    },
  );
});
