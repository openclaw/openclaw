import path from "node:path";
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
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { SessionManager } from "./session-manager.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const stateDir of dirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
  }),
);
async function fixture(data: unknown = { value: "x".repeat(3 * 1024 * 1024) }, prefixEntries = 0) {
  const dir = dirs.make("retained-transcript-data-");
  const scope = {
    agentId: "main",
    sessionId: "retained",
    sessionKey: "agent:main:retained",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    activeWriterRunId: "writer",
    lifecycleRevision: "lifecycle",
  });
  SessionManager.open(scope, dir).appendMessage({
    role: "user",
    content: "retained user",
    timestamp: 1,
  });
  const manager = SessionManager.openBounded(scope, { cwd: dir, maxEvents: 20, maxBytes: 4096 });
  for (let index = 0; index < prefixEntries; index += 1) {
    manager.appendCustomEntry("prefix", { index });
  }
  const assistantId = manager.appendMessage(
    makeAgentAssistantMessage({
      content: [],
      api: "messages",
      provider: "anthropic",
      stopReason: "aborted",
      timestamp: 2,
    }),
  );
  const metadataId = manager.appendCustomEntry("plugin-state", data);
  const remove = (selected = manager) =>
    selected.removeTrailingEntries((e) => e.id === assistantId, {
      preserveTrailing: (e) => e.type === "custom",
    });
  const options = {
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  };
  const db = openOpenClawAgentDatabase(options).db;
  const live = () => ({
    ids: manager.getEntries().map((e) => e.id),
    parent: manager.getAppendParentId(),
  });
  const durable = () => JSON.stringify(loadTranscriptEventsSync(scope));
  const dataJson = () => {
    const rows = loadTranscriptEventsSync(scope) as Array<{ id?: string; data?: unknown }>;
    return JSON.stringify(rows.find((row) => row.id === metadataId)?.data);
  };
  return { scope, dir, manager, assistantId, remove, db, options, live, durable, dataJson };
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
    const rows = loadTranscriptEventsSync(f.scope) as Array<{
      id?: string;
      type?: string;
      data?: unknown;
      parentId?: string;
    }>;
    expect(rows.filter((row) => row.id === f.assistantId)).toHaveLength(0);
    const metadata = rows.find((row) => row.id === f.metadataId);
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
      const f = await fixture();
      const live = f.live();
      if (failure === "sqlite") {
        // The staging insert succeeds; fail the final compacted metadata insertion after deletion.
        f.db.exec(
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
      const before = f.durable();
      const sessionTarget =
        failure === "writer" || failure === "lifecycle"
          ? {
              ...f.scope,
              expectedWriterRunId: "writer",
              expectedLifecycleRevision: "lifecycle",
            }
          : undefined;
      await expect(
        withOwnedSessionTranscriptWrites(
          {
            sessionTarget,
            withTranscriptWrite: async (run) => await run(),
          },
          async () => f.remove(),
        ),
      ).rejects.toThrow();
      expect(f.durable()).toBe(before);
      expect(f.live()).toEqual(live);
      if (failure === "sqlite") {
        f.db.exec("DROP TRIGGER reject_final_suffix");
        expect(f.remove()).toBe(1);
      }
    },
  );
  it("adopts retained data only when the outer transaction commits", async () => {
    const f = await fixture();
    const before = f.durable();
    const live = f.live();
    expect(() =>
      runOpenClawAgentWriteTransaction(() => {
        expect(f.remove()).toBe(1);
        expect(f.live()).toEqual(live);
        throw new Error("outer rollback");
      }, f.options),
    ).toThrow("outer rollback");
    expect(f.durable()).toBe(before);
    expect(f.live()).toEqual(live);
    runOpenClawAgentWriteTransaction(() => {
      expect(f.remove()).toBe(1);
    }, f.options);
    expect(f.manager.getEntry(f.assistantId)).toBeUndefined();
    expect(f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("keeps unchanged-prefix IDs out of a tiny suffix query", async () => {
    const f = await fixture({ retained: true }, 40);
    const db = requireNativeSqliteDatabase(f.db);
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

  it.each(["reopened", "deep"])("preserves %s custom JSON during suffix removal", async (kind) => {
    const data =
      kind === "deep"
        ? Array.from({ length: 1_100 }).reduce<unknown>((nested) => ({ nested }), "leaf")
        : { value: "x".repeat(3 * 1024 * 1024) };
    const f = await fixture(data);
    const manager =
      kind === "deep"
        ? f.manager
        : SessionManager.openBounded(f.scope, {
            cwd: f.dir,
            maxEvents: 20,
            maxBytes: 8 * 1024 * 1024,
          });
    expect(f.remove(manager)).toBe(1);
    expect(f.dataJson()).toBe(JSON.stringify(data));
  });
});
