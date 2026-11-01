import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.entry.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import {
  historyLane,
  targetDiscoveryLane,
} from "../../config/sessions/session-transcript-worker-resources.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withAgentDatabaseMaintenanceLease } from "../../state/openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchema } from "../../state/openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { clearOpenClawDatabaseQuarantine } from "../../state/openclaw-quarantine-store.js";
import { seedOpenClawDatabaseQuarantine } from "../../state/openclaw-quarantine-store.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { sessionScope } from "./session-manager-fixtures.test-support.js";
import { SessionManager, type SessionMessageEntry } from "./session-manager.js";

function makeTarget(state: OpenClawTestState, sessionId: string) {
  return sessionScope(path.join(state.agentDir("main"), "openclaw-agent.sqlite"), sessionId);
}

function retainedManager(timestamp: number) {
  const manager = SessionManager.inMemory("/retained");
  manager.appendMessage(makeUserMessage("keep the original view", timestamp));
  return { manager, before: { ...managerView(manager), cwd: "/retained", persisted: false } };
}

function managerView(manager: SessionManager) {
  return {
    entries: manager.getPersistedEntries(),
    target: manager.getSessionTarget(),
    cwd: manager.getCwd(),
    persisted: manager.isPersisted(),
  };
}

async function seedTranscript(state: OpenClawTestState) {
  const target = makeTarget(state, "streamed-hydration");
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  const source = SessionManager.open(target, "/stored");
  // Three-byte characters cross the transport's binary frame boundaries.
  const text = "漢".repeat(400_000);
  ["first complete message", text, text, "last complete message"].forEach((content, index) =>
    source.appendMessage(makeUserMessage(content, index + 1)),
  );
  await waitForSessionTranscriptProjection(target);
  return { target, entries: source.getPersistedEntries() };
}

function holdFirstChunk() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const run = historyLane.pool.run.bind(historyLane.pool);
  const observed = { chunks: 0, splitUtf8: false };
  const spy = vi.spyOn(historyLane.pool, "run").mockImplementation((input, options) => {
    const receive = options.onRequest;
    if (!receive) {
      return run(input, options);
    }
    return run(input, {
      ...options,
      onRequest: async (value, context) => {
        if (
          !isRecord(value) ||
          value.kind !== "transcript-hydration-chunk" ||
          !Array.isArray(value.frames)
        ) {
          return receive(value, context);
        }
        observed.chunks++;
        for (const frame of value.frames) {
          if (isRecord(frame) && frame.data instanceof Uint8Array) {
            try {
              new TextDecoder("utf-8", { fatal: true }).decode(frame.data);
            } catch {
              observed.splitUtf8 = true;
            }
          }
        }
        const response = await receive(value, context);
        if (observed.chunks === 1) {
          entered.resolve();
          await release.promise;
        }
        return response;
      },
    });
  });
  return {
    release: () => release.resolve(),
    restore: () => spy.mockRestore(),
    observed,
    wait: (pending: Promise<unknown>) =>
      awaitGateBeforeSettlement(
        entered.promise,
        pending,
        "Hydration finished without transferring a transcript chunk",
      ),
  };
}

it("rejects a persisted quarantine through the history worker without retargeting the manager", async () => {
  await withOpenClawTestState({ label: "session-hydration-stream-quarantine" }, async (state) => {
    const target = makeTarget(state, "quarantined-hydration");
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    SessionManager.open(target).appendMessage(makeUserMessage("quarantined history", 1));
    await waitForSessionTranscriptProjection(target);
    await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
    const reason = "synthetic persisted hydration quarantine";
    seedOpenClawDatabaseQuarantine({
      kind: "agent",
      path: target.storePath,
      env: state.env,
      reason,
    });
    const { manager, before } = retainedManager(2);
    // The closed database makes this a cold read, which runs on the target-discovery lane.
    const dispatch = vi.spyOn(targetDiscoveryLane.pool, "run");
    try {
      const failure = await manager.setSessionTargetAsync(target).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        name: "SqliteIntegrityError",
        message: expect.stringContaining(reason),
      });
      expect(dispatch).toHaveBeenCalledOnce();
      expect(await dispatch.mock.results[0]?.value).toMatchObject({
        ok: false,
        error: { kind: "read-error" },
      });
      expect(managerView(manager)).toEqual(before);
      expect(targetDiscoveryLane.pool.getSnapshot()).toMatchObject({
        activeTasks: 0,
        pendingTasks: 0,
      });
    } finally {
      dispatch.mockRestore();
      expect(clearOpenClawDatabaseQuarantine(target.storePath, { env: state.env })).toBe(true);
    }
  });
});

it.each(["UTF-16le", "UTF-16be"] as const)(
  "hydrates canonical %s transcripts with the same Unicode content as the synchronous reader",
  async (encoding) => {
    await withOpenClawTestState({ label: "session-hydration-stream-encoding" }, async (state) => {
      const target = makeTarget(state, "encoded-hydration");
      target.storePath = state.path("utf16-agent.sqlite");
      const database = new DatabaseSync(target.storePath);
      try {
        database.exec(`PRAGMA encoding = '${encoding}'`);
        await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
          ensureOpenClawAgentDatabaseSchema(database, {
            agentId: target.agentId,
            path: target.storePath,
            env: state.env,
          });
        });
        expect(database.prepare("PRAGMA encoding").get()?.encoding).toBe(encoding);
      } finally {
        database.close();
      }
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const source = SessionManager.open(target, "/stored");
      const message = makeUserMessage("雪 🦞 café العربية \uFEFF preserved", 1);
      source.appendMessage(message);
      await waitForSessionTranscriptProjection(target);
      const expected = SessionManager.open(target).getPersistedEntries();
      const hydrated = await SessionManager.openAsync(target);
      expect(hydrated.getPersistedEntries()).toEqual(expected);
      expect(hydrated.buildSessionContext().messages).toEqual([message]);
    });
  },
);

it("hydrates events below, on, and above byte-slice boundaries without dropping their successors", async () => {
  await withOpenClawTestState({ label: "session-hydration-stream-boundaries" }, async (state) => {
    const target = makeTarget(state, "boundary-hydration");
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const entries = SessionManager.open(target).getPersistedEntries();
    let parentId: string | null = null;
    for (const size of [65_535, 65_536, 65_537, 131_072]) {
      const event: SessionMessageEntry = {
        type: "message",
        id: `boundary-${size}`,
        parentId,
        timestamp: new Date(size).toISOString(),
        message: makeUserMessage("", size),
      };
      event.message = makeUserMessage(
        "x".repeat(size - Buffer.byteLength(JSON.stringify(event))),
        size,
      );
      expect(Buffer.byteLength(JSON.stringify(event))).toBe(size);
      entries.push(event);
      parentId = event.id;
    }
    expect(replaceTranscriptEventsSync(target, entries)).toBe(true);
    expect((await SessionManager.openAsync(target)).getPersistedEntries()).toEqual(entries);
  });
});

it("hydrates one complete UTF-8 snapshot while a writer replaces rows between chunks", async () => {
  await withOpenClawTestState({ label: "session-hydration-stream-snapshot" }, async (state) => {
    const { target, entries } = await seedTranscript(state);
    const gate = holdFirstChunk();
    const pending = SessionManager.openAsync(target);
    try {
      await gate.wait(pending);
      const replacement = SessionManager.inMemory("/replacement");
      replacement.appendMessage(makeUserMessage("replacement history", 5));
      const replacementEntries = replacement
        .getPersistedEntries()
        .map((entry) =>
          isRecord(entry) && entry.type === "session"
            ? Object.assign(entry, { id: target.sessionId })
            : entry,
        );
      // The hot fixture writer must not queue cold preflight on the history worker
      // whose snapshot this test deliberately holds until the write completes.
      expect(replaceTranscriptEventsSync(target, replacementEntries)).toBe(true);
      gate.release();
      const hydrated = await pending;
      expect(hydrated.getPersistedEntries()).toEqual(entries);
      expect(gate.observed.chunks).toBeGreaterThan(1);
      expect(gate.observed.splitUtf8).toBe(true);
      expect((await SessionManager.openAsync(target)).getPersistedEntries()).toEqual(
        replacementEntries,
      );
    } finally {
      gate.release();
      gate.restore();
      await Promise.allSettled([pending]);
    }
  });
});

it.each([
  { label: "cancellation", corrupt: undefined },
  { label: "malformed JSON", corrupt: "{malformed" },
  { label: "leading BOM", corrupt: "\uFEFF{}" },
])("preserves the manager after streaming $label", async ({ corrupt }) => {
  await withOpenClawTestState({ label: "session-hydration-stream-failure" }, async (state) => {
    const { target, entries } = await seedTranscript(state);
    if (corrupt !== undefined) {
      const database = openOpenClawAgentDatabase({ agentId: "main", path: target.storePath });
      // Corrupt only the final fixture row after its canonical write has settled.
      database.db
        .prepare(
          `UPDATE transcript_events SET event_json = ?, event_zstd = NULL,
           event_utf8_bytes = ?, navigation_json = NULL
           WHERE session_id = ? AND seq = (
             SELECT MAX(seq) FROM transcript_events WHERE session_id = ?
           )`,
        )
        .run(corrupt, Buffer.byteLength(corrupt), target.sessionId, target.sessionId);
      expect(() => SessionManager.open(target)).toThrow(SyntaxError);
    }
    const { manager, before } = retainedManager(10);
    const controller = new AbortController();
    const reason = new Error("cancelled streaming hydration");
    const gate = holdFirstChunk();
    const pending = manager.setSessionTargetAsync(
      target,
      corrupt === undefined ? controller.signal : undefined,
    );
    const refused =
      corrupt === undefined
        ? expect(pending).rejects.toBe(reason)
        : expect(pending).rejects.toThrow();
    try {
      await gate.wait(pending);
      if (corrupt === undefined) {
        controller.abort(reason);
      } else {
        gate.release();
      }
      await refused;
      if (corrupt === undefined) {
        expect(historyLane.pool.getSnapshot()).toMatchObject({
          workers: 0,
          activeTasks: 0,
          pendingTasks: 0,
        });
      } else {
        expect(gate.observed.chunks).toBeGreaterThan(1);
      }
      expect(managerView(manager)).toEqual(before);
      if (corrupt === undefined) {
        gate.release();
        await manager.setSessionTargetAsync(target);
        expect(manager.getPersistedEntries()).toEqual(entries);
      }
    } finally {
      gate.release();
      gate.restore();
      await Promise.allSettled([pending, refused]);
    }
  });
});
