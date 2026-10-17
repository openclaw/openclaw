import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { openOpenClawStateDatabase } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import {
  SHORT_TERM_META_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  memoryCoreWorkspaceStateKey,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import { memoryForgetHarness, memoryOrigin } from "./memory-forget.suite.test-support.js";
import { seedMemoryForgetSession } from "./memory-forget.test-helpers.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import { readPhaseSignalStore, writePhaseSignalStore } from "./short-term-promotion-store.js";
import type {
  ShortTermPhaseSignalEntry,
  ShortTermRecallEntry,
} from "./short-term-promotion-types.js";

const observedAt = "2026-09-11T00:00:00.000Z";

type RecallFixture = Pick<ShortTermRecallEntry, "key" | "path" | "snippet" | "recallCount">;
function recallEntry(key: string): RecallFixture {
  return {
    key,
    path: "memory/2026-09-11.md",
    snippet: `Synthetic memory fact for ${key}.`,
    recallCount: 1,
  };
}

describe("memory forget phase-signal failures", () => {
  const h = memoryForgetHarness();
  const { origins, tombstones } = h;
  const forget = () => h.forget({ sessionIds: ["target"] });

  const readRecalls = () => h.readEntries<RecallFixture>(SHORT_TERM_RECALL_NAMESPACE);
  const readPhases = async () => (await readPhaseSignalStore(h.workspaceDir, observedAt)).entries;
  function abortWrite(event: string, namespace: string, key: string, message: string) {
    const db = openOpenClawStateDatabase().db;
    db.exec(`CREATE TRIGGER abort_write ${event} ON plugin_state_entries
      WHEN OLD.plugin_id = 'memory-core' AND OLD.namespace = '${namespace}'
        AND json_extract(OLD.value_json, '$.workspaceKey') = '${memoryCoreWorkspaceStateKey(h.workspaceDir)}'
        AND json_extract(OLD.value_json, '$.key') = '${key}'
      BEGIN SELECT RAISE(ABORT, '${message}'); END;`);
    return () => db.exec("DROP TRIGGER IF EXISTS abort_write");
  }

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
    await h.recordOrigins(
      keys.map((entryKey) =>
        memoryOrigin(entryKey, entryKey === "target-entry" ? "target" : "survivor", {
          observedAt: Date.parse(observedAt),
        }),
      ),
    );
    await h.writeEntries(SHORT_TERM_RECALL_NAMESPACE, recalls);
    await writePhaseSignalStore(h.workspaceDir, {
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
    await h.writeEntry(SHORT_TERM_RECALL_NAMESPACE, "later-entry", recallEntry("later-entry"));
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
      await expect(forget()).rejects.toMatchObject({
        cause: { message: "synthetic phase metadata failure" },
      });
      restore();
      await withMemoryWorkspaceLock(h.workspaceDir, () =>
        h.writeEntry(SHORT_TERM_PHASE_SIGNAL_NAMESPACE, "later-entry", laterPhase),
      );
      await rowsSettled.promise;
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
