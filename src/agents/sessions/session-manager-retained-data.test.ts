import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { SessionManager } from "./session-manager.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const stateDir of dirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
  }),
);
async function fixture(data: unknown, prefixEntries = 0) {
  const dir = dirs.make("retained-transcript-data-");
  const scope = {
    agentId: "main",
    sessionId: "retained",
    sessionKey: "agent:main:retained",
    storePath: path.join(dir, "sessions.json"),
  };
  const entry = {
    sessionId: scope.sessionId,
    updatedAt: 1,
    activeWriterRunId: "writer",
    lifecycleRevision: "lifecycle",
  };
  await upsertSessionEntryCore(scope, entry);
  const seed = await SessionManager.openAsync(scope, dir);
  const userId = expectDefined(
    await seed.appendMessageAsync({
      role: "user",
      content: "retained user",
      timestamp: 1,
    }),
    "Expected appended message",
  );
  const manager = await SessionManager.openBoundedAsync(scope, {
    cwd: dir,
    maxEvents: 20,
    maxBytes: 4096,
  });
  for (let index = 0; index < prefixEntries; index += 1) {
    await manager.appendCustomEntryAsync("prefix", { index });
  }
  const assistantId = expectDefined(
    await manager.appendMessageAsync({
      role: "assistant",
      content: [],
      api: "messages",
      provider: "anthropic",
      model: "test-model",
      usage: createZeroUsageFixture(),
      stopReason: "aborted",
      timestamp: 2,
    }),
    "Expected appended message",
  );
  const metadataId = await manager.appendCustomEntryAsync("plugin-state", data);
  const remove = async () =>
    await manager.removeTrailingEntriesAsync((e) => e.id === assistantId, {
      preserveTrailing: (e) => e.type === "custom",
    });
  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  return { scope, entry, dir, userId, manager, assistantId, metadataId, remove, database };
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
    expect(await f.remove()).toBe(1);
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
      const f = await fixture({ value: "x".repeat(3 * 1024 * 1024) });
      const liveIds = f.manager.getEntries().map((e) => e.id);
      const parent = f.manager.getAppendParentId();
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
      const before = JSON.stringify(loadTranscriptEventsSync(f.scope));
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
      expect(JSON.stringify(loadTranscriptEventsSync(f.scope)) === before).toBe(true);
      expect(f.manager.getEntries().map((e) => e.id)).toEqual(liveIds);
      expect(f.manager.getAppendParentId()).toBe(parent);
      if (failure === "sqlite") {
        f.database.db.exec("DROP TRIGGER reject_final_suffix");
        expect(await f.remove()).toBe(1);
      }
    },
  );

  it("recovers retained metadata after reopening an existing bounded session", async () => {
    const data = { value: "x".repeat(3 * 1024 * 1024) };
    const f = await fixture(data);
    const reopened = await SessionManager.openBoundedAsync(f.scope, {
      cwd: f.dir,
      maxEvents: 20,
      maxBytes: 8 * 1024 * 1024,
    });
    expect(
      await reopened.removeTrailingEntriesAsync((entry) => entry.id === f.assistantId, {
        preserveTrailing: (entry) => entry.type === "custom",
      }),
    ).toBe(1);
    const rows = loadTranscriptEventsSync(f.scope) as Array<{ id?: string; data?: unknown }>;
    expect(isDeepStrictEqual(rows.find((row) => row.id === f.metadataId)?.data, data)).toBe(true);
  });

  it("preserves deep custom JSON that SQLite cannot project", async () => {
    let data: unknown = "leaf";
    for (let index = 0; index < 1_100; index += 1) {
      data = { nested: data };
    }
    const f = await fixture(data);
    expect(await f.remove()).toBe(1);
    const rows = loadTranscriptEventsSync(f.scope) as Array<{ id?: string; data?: unknown }>;
    expect(JSON.stringify(rows.find((row) => row.id === f.metadataId)?.data)).toBe(
      JSON.stringify(data),
    );
  });
});
