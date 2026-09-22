import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.entry.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { historyPages } from "../../config/sessions/session-transcript-worker-resources.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withAgentDatabaseMaintenanceLease } from "../../state/openclaw-agent-db-maintenance-lease.js";
import { ensureOpenClawAgentDatabaseSchema } from "../../state/openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  clearOpenClawDatabaseQuarantine,
  recordOpenClawDatabaseQuarantine,
} from "../../state/openclaw-quarantine-store.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { SessionManager } from "./session-manager.js";

async function seedTranscript(state: OpenClawTestState) {
  const target = {
    agentId: "main",
    sessionId: "streamed-hydration",
    sessionKey: "agent:main:streamed-hydration",
    storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  const source = SessionManager.open(target, "/stored");
  source.appendMessage(makeUserMessage("first complete message", 1));
  // Three-byte characters cross the transport's binary frame boundaries.
  const text = "漢".repeat(400_000);
  source.appendMessage(makeUserMessage(text, 2));
  source.appendMessage(makeUserMessage(text, 3));
  source.appendMessage(makeUserMessage("last complete message", 4));
  await waitForSessionTranscriptProjection(target);
  return { target, entries: source.getPersistedEntries() };
}

function holdFirstChunk() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const run = historyPages.run.bind(historyPages);
  let chunks = 0;
  let splitUtf8 = false;
  const spy = vi.spyOn(historyPages, "run").mockImplementation((input, options) => {
    const receive = options.onRequest;
    return run(input, {
      ...options,
      onRequest: receive
        ? async (value, context) => {
            if (
              !isRecord(value) ||
              value.kind !== "transcript-hydration-chunk" ||
              !Array.isArray(value.frames)
            ) {
              return receive(value, context);
            }
            chunks++;
            for (const frame of value.frames) {
              if (isRecord(frame) && frame.data instanceof Uint8Array) {
                try {
                  new TextDecoder("utf-8", { fatal: true }).decode(frame.data);
                } catch {
                  splitUtf8 = true;
                }
              }
            }
            const response = await receive(value, context);
            if (chunks === 1) {
              entered.resolve();
              await release.promise;
            }
            return response;
          }
        : undefined,
    });
  });
  return {
    release: () => release.resolve(),
    restore: () => spy.mockRestore(),
    get chunks() {
      return chunks;
    },
    get splitUtf8() {
      return splitUtf8;
    },
    wait: (pending: Promise<unknown>) =>
      Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Hydration finished without transferring a transcript chunk");
        }),
      ]),
  };
}

it("rejects a persisted quarantine through the history worker without retargeting the manager", async () => {
  await withOpenClawTestState({ label: "session-hydration-stream-quarantine" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "quarantined-hydration",
      sessionKey: "agent:main:quarantined-hydration",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    SessionManager.open(target).appendMessage(makeUserMessage("quarantined history", 1));
    await waitForSessionTranscriptProjection(target);
    await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
    const reason = "synthetic persisted hydration quarantine";
    expect(
      recordOpenClawDatabaseQuarantine({
        kind: "agent",
        path: target.storePath,
        env: state.env,
        reason,
      }),
    ).toBe(true);
    const manager = SessionManager.inMemory("/retained");
    manager.appendMessage(makeUserMessage("keep the original view", 2));
    const before = manager.getPersistedEntries();
    const priorTarget = manager.getSessionTarget();
    const dispatch = vi.spyOn(historyPages, "run");
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
      expect(manager.getPersistedEntries()).toEqual(before);
      expect(manager.getSessionTarget()).toEqual(priorTarget);
      expect(manager.getCwd()).toBe("/retained");
      expect(manager.isPersisted()).toBe(false);
      expect(historyPages.getSnapshot()).toMatchObject({ activeTasks: 0, pendingTasks: 0 });
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
      const target = {
        agentId: "main",
        sessionId: "encoded-hydration",
        sessionKey: "agent:main:encoded-hydration",
        storePath: state.path("utf16-agent.sqlite"),
      };
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
      await replaceTranscriptEvents(target, replacementEntries);
      gate.release();
      const hydrated = await pending;
      expect(hydrated.getPersistedEntries()).toEqual(entries);
      expect(gate.chunks).toBeGreaterThan(1);
      expect(gate.splitUtf8).toBe(true);
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

it("joins a cancelled stream without adopting its already received prefix", async () => {
  await withOpenClawTestState({ label: "session-hydration-stream-abort" }, async (state) => {
    const { target, entries } = await seedTranscript(state);
    const manager = SessionManager.inMemory("/retained");
    manager.appendMessage(makeUserMessage("keep the original view", 10));
    const before = manager.getPersistedEntries();
    const controller = new AbortController();
    const reason = new Error("cancelled streaming hydration");
    const gate = holdFirstChunk();
    const pending = manager.setSessionTargetAsync(target, controller.signal);
    const refused = expect(pending).rejects.toBe(reason);
    try {
      await gate.wait(pending);
      controller.abort(reason);
      await refused;
      expect(historyPages.getSnapshot()).toMatchObject({
        workers: 0,
        activeTasks: 0,
        pendingTasks: 0,
      });
      expect(manager.getPersistedEntries()).toEqual(before);
      expect(manager.getCwd()).toBe("/retained");
      expect(manager.isPersisted()).toBe(false);
      gate.release();
      await manager.setSessionTargetAsync(target);
      expect(manager.getPersistedEntries()).toEqual(entries);
    } finally {
      gate.release();
      gate.restore();
      await Promise.allSettled([pending, refused]);
    }
  });
});

it.each([
  { label: "malformed JSON", corrupt: "{malformed" },
  { label: "leading BOM", corrupt: "\uFEFF{}" },
])(
  "preserves a manager when a later $label row rejects after chunks were received",
  async ({ corrupt }) => {
    await withOpenClawTestState({ label: "session-hydration-stream-malformed" }, async (state) => {
      const { target } = await seedTranscript(state);
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
      const manager = SessionManager.inMemory("/retained");
      manager.appendMessage(makeUserMessage("keep the original view", 10));
      const before = manager.getPersistedEntries();
      const gate = holdFirstChunk();
      const pending = manager.setSessionTargetAsync(target);
      const refused = expect(pending).rejects.toThrow();
      try {
        await gate.wait(pending);
        gate.release();
        await refused;
        expect(gate.chunks).toBeGreaterThan(1);
        expect(manager.getPersistedEntries()).toEqual(before);
        expect(manager.getCwd()).toBe("/retained");
        expect(manager.isPersisted()).toBe(false);
      } finally {
        gate.release();
        gate.restore();
        await Promise.allSettled([pending, refused]);
      }
    });
  },
);
