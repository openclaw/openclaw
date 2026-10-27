import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { assistantText, sessionScope } from "./session-manager-fixtures.test-support.js";
import { SessionManager } from "./session-manager.js";
import { cleanupTrackedSessionState } from "./session-state-cleanup.test-support.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await cleanupTrackedSessionState(dirs.dirs, cleanup);
  }),
);
async function fixture(data: unknown, prefixEntries = 0) {
  const dir = dirs.make("retained-transcript-data-");
  const scope = sessionScope(path.join(dir, "sessions.json"), "retained");
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    activeWriterRunId: "writer",
    lifecycleRevision: "lifecycle",
  });
  const seed = SessionManager.open(scope, dir);
  const userId = seed.appendMessage({ role: "user", content: "retained user", timestamp: 1 });
  const manager = SessionManager.openBounded(scope, { cwd: dir, maxEvents: 20, maxBytes: 4096 });
  for (let index = 0; index < prefixEntries; index += 1) {
    manager.appendCustomEntry("prefix", { index });
  }
  const assistantId = manager.appendMessage({
    ...assistantText(""),
    content: [],
    api: "messages",
    provider: "anthropic",
    stopReason: "aborted",
    timestamp: 2,
  });
  const metadataId = manager.appendCustomEntry("plugin-state", data);
  const remove = () =>
    manager.removeTrailingEntries((e) => e.id === assistantId, {
      preserveTrailing: (e) => e.type === "custom",
    });
  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  const snapshot = () => ({
    durable: JSON.stringify(loadTranscriptEventsSync(scope)),
    live: manager.getEntries().map((entry) => entry.id),
    parent: manager.getAppendParentId(),
  });
  const metadata = () =>
    loadTranscriptEventsSync(scope)
      .filter(isRecord)
      .find((row) => row.id === metadataId);
  const options = { agentId: scope.agentId, path: resolveSessionTranscriptDatabasePath(scope) };
  return {
    scope,
    dir,
    userId,
    manager,
    assistantId,
    metadataId,
    remove,
    database,
    snapshot,
    metadata,
    options,
  };
}

describe("bounded cleanup retaining opaque custom data", () => {
  it.each([
    { label: "null", data: null },
    { label: "boolean", data: true },
    { label: "3 MiB", data: { value: "x".repeat(3 * 1024 * 1024) } },
    { label: "5 MiB", data: { value: "x".repeat(5 * 1024 * 1024) } },
  ])("preserves $label data and repaired parent without staged rows escaping", async ({ data }) => {
    const f = await fixture(data);
    const before = loadTranscriptEventsSync(f.scope);
    expect(f.remove()).toBe(1);
    const rows = loadTranscriptEventsSync(f.scope);
    expect(rows.filter((row) => isRecord(row) && row.id === f.assistantId)).toHaveLength(0);
    const metadata = f.metadata();
    expect(metadata?.parentId).toBe(f.userId);
    expect(isDeepStrictEqual(metadata?.data, data)).toBe(true);
    expect(isDeepStrictEqual(f.manager.getEntry(f.metadataId), metadata)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(before.length);
    const integrity = f.database.db.prepare("PRAGMA foreign_key_check").all();
    expect(integrity).toEqual([]);
    const sequences = f.database.db
      .prepare("SELECT seq FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(f.scope.sessionId) as Array<{ seq: number }>;
    expect(sequences.map((row) => row.seq)).toEqual(
      Array.from({ length: rows.length }, (_, index) => index),
    );
  });

  it.each(["sqlite", "identity", "writer", "lifecycle", "append"])(
    "keeps durable and live history intact after %s rejection",
    async (failure) => {
      const f = await fixture({ value: "x".repeat(3 * 1024 * 1024) });
      const liveBefore = f.snapshot();
      if (failure === "sqlite") {
        // The staging insert succeeds; fail the final compacted metadata insertion after deletion.
        f.database.db.exec(
          "CREATE TRIGGER reject_final_suffix BEFORE INSERT ON transcript_events WHEN NEW.seq = 2 BEGIN SELECT RAISE(ABORT, 'reject final suffix'); END;",
        );
      } else if (failure === "append") {
        await appendTranscriptMessage(f.scope, {
          cwd: f.dir,
          eventId: "concurrent",
          message: { role: "user", content: "concurrent", timestamp: 3 },
        });
      } else {
        await updateSessionEntry(f.scope, () =>
          failure === "identity"
            ? { sessionId: "replacement" }
            : failure === "writer"
              ? { activeWriterRunId: "replacement" }
              : { lifecycleRevision: "replacement" },
        );
      }
      const before = { ...liveBefore, durable: f.snapshot().durable };
      await expect(
        withOwnedSessionTranscriptWrites(
          {
            ...(failure === "writer" || failure === "lifecycle"
              ? {
                  sessionTarget: {
                    ...f.scope,
                    expectedWriterRunId: "writer",
                    expectedLifecycleRevision: "lifecycle",
                  },
                }
              : {}),
            withTranscriptWrite: async (run) => await run(),
          },
          async () => f.remove(),
        ),
      ).rejects.toThrow();
      expect(f.snapshot()).toEqual(before);
      if (failure === "sqlite") {
        f.database.db.exec("DROP TRIGGER reject_final_suffix");
        expect(f.remove()).toBe(1);
      }
    },
  );
  it("adopts retained data only when the outer transaction commits", async () => {
    const f = await fixture({ value: "x".repeat(3 * 1024 * 1024) });
    const before = f.snapshot();
    expect(() =>
      runOpenClawAgentWriteTransaction(() => {
        expect(f.remove()).toBe(1);
        expect(f.snapshot().live).toEqual(before.live);
        throw new Error("outer rollback");
      }, f.options),
    ).toThrow("outer rollback");
    expect(f.snapshot()).toEqual(before);
    runOpenClawAgentWriteTransaction(() => {
      expect(f.remove()).toBe(1);
    }, f.options);
    expect(f.manager.getEntry(f.assistantId)).toBeUndefined();
    expect(f.database.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("recovers retained metadata after reopening an existing bounded session", async () => {
    const data = { value: "x".repeat(3 * 1024 * 1024) };
    const f = await fixture(data);
    const reopened = SessionManager.openBounded(f.scope, {
      cwd: f.dir,
      maxEvents: 20,
      maxBytes: 8 * 1024 * 1024,
    });
    expect(
      reopened.removeTrailingEntries((entry) => entry.id === f.assistantId, {
        preserveTrailing: (entry) => entry.type === "custom",
      }),
    ).toBe(1);
    expect(isDeepStrictEqual(f.metadata()?.data, data)).toBe(true);
  });

  it("keeps unchanged-prefix IDs out of a tiny suffix query", async () => {
    const f = await fixture({ retained: true }, 40);
    const db = requireNativeSqliteDatabase(f.database.db);
    const prepare = db.prepare.bind(db);
    let maxParameters = 0;
    const spy = vi.spyOn(db, "prepare").mockImplementation((query) => {
      maxParameters = Math.max(maxParameters, query.match(/\?/g)?.length ?? 0);
      return prepare(query);
    });
    try {
      expect(f.remove()).toBe(1);
      expect(maxParameters).toBeGreaterThan(0);
      expect(maxParameters).toBeLessThan(20);
    } finally {
      spy.mockRestore();
    }
  });

  it("preserves deep custom JSON that SQLite cannot project", async () => {
    let data: unknown = "leaf";
    for (let index = 0; index < 1_100; index += 1) {
      data = { nested: data };
    }
    const f = await fixture(data);
    expect(f.remove()).toBe(1);
    expect(JSON.stringify(f.metadata()?.data)).toBe(JSON.stringify(data));
  });
});
