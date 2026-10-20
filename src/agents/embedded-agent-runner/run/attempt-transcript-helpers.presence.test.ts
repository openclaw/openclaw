import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { hasSessionTranscriptMessageInDatabase } from "../../../config/sessions/session-accessor.sqlite-transcript-metadata-read.js";
import { replaceTranscriptEventsSync } from "../../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import type { SessionTranscriptRuntimeTarget } from "../../../config/sessions/session-accessor.types.js";
import { createTranscriptEventInserter } from "../../../config/sessions/transcript-payload.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { resolveExistingAttemptTranscriptState } from "./attempt-transcript-helpers.js";

function withPresence(
  run: (
    target: SessionTranscriptRuntimeTarget,
    database: ReturnType<typeof openOpenClawAgentDatabase>,
    expectPresence: (expected: boolean) => Promise<void>,
  ) => Promise<void>,
) {
  return withOpenClawTestState({ label: "bootstrap-presence" }, async (state) => {
    const sessionTarget = {
      agentId: "main",
      sessionId: "bootstrap-presence",
      sessionKey: "agent:main:bootstrap-presence",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    replaceSessionEntrySync(sessionTarget, { sessionId: sessionTarget.sessionId, updatedAt: 1 });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    await run(sessionTarget, database, async (expected) => {
      expect(
        await resolveExistingAttemptTranscriptState({
          ...sessionTarget,
          sessionTarget,
          sessionFile: sessionTarget.sessionKey,
        }),
      ).toEqual({ hasBootstrapTranscriptState: expected });
    });
  });
}

it("checks bootstrap history without decoding canonical message payloads", async () => {
  await withPresence(async (sessionTarget, database, expectPresence) => {
    const payload = "x".repeat(4 * 1024 * 1024);
    replaceTranscriptEventsSync(sessionTarget, [
      { type: "session", id: sessionTarget.sessionId, version: 3 },
      { type: "message", id: "user", message: { role: "user", content: payload } },
      { type: "reset", id: "reset", parentId: null, reason: "new" },
    ]);
    const parse = JSON.parse;
    let parsedPayloadBytes = 0;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (text.length >= payload.length) {
        parsedPayloadBytes += text.length;
      }
      return parse(text, reviver);
    });
    try {
      // The history worker uses this query; caller-only spies cannot observe its decoding.
      expect(hasSessionTranscriptMessageInDatabase(database, sessionTarget.sessionId)).toBe(true);
      await expectPresence(true);
      expect(parsedPayloadBytes).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

it("keeps one presence snapshot while another connection classifies a message", async () => {
  await withPresence(async (sessionTarget, database, expectPresence) => {
    replaceTranscriptEventsSync(sessionTarget, [
      { type: "message", id: "user", message: { role: "user", content: "present throughout" } },
    ]);
    const writer = new DatabaseSync(database.path);
    writer
      .prepare("UPDATE transcript_event_identities SET event_type = NULL WHERE session_id = ?")
      .run(sessionTarget.sessionId);
    const native = requireNativeSqliteDatabase(database.db);
    const prepare = native.prepare.bind(native);
    let classified = false;
    const spy = vi.spyOn(native, "prepare").mockImplementation((query) => {
      const statement = prepare(query);
      if (
        !query.includes('"transcript_event_identities"') ||
        query.includes('"transcript_events"')
      ) {
        return statement;
      }
      const classify = () => {
        // Commit classification after the index probe, with the physical message still present.
        writer
          .prepare(
            "UPDATE transcript_event_identities SET event_type = 'message' WHERE session_id = ?",
          )
          .run(sessionTarget.sessionId);
        classified = true;
      };
      return new Proxy(statement, {
        get(target, property) {
          if (property === "get") {
            return (...params: Parameters<typeof target.get>) => {
              const row = target.get(...params);
              classify();
              return row;
            };
          }
          if (property === "iterate") {
            return (...params: Parameters<typeof target.iterate>) => {
              const rows = [...target.iterate(...params)];
              classify();
              return rows.values();
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    try {
      // Inject the concurrent classification into the query that the history worker executes.
      expect(hasSessionTranscriptMessageInDatabase(database, sessionTarget.sessionId)).toBe(true);
      await expectPresence(true);
      expect(classified).toBe(true);
    } finally {
      spy.mockRestore();
      writer.close();
    }
  });
});

it.each([
  ["metadata", '{"type":"custom","data":{"message":"metadata"}}', false],
  ["native evidence", '{"type":"response_item","message":{"role":"user"}}', false],
  ["id-less message", '{"type":"message","message":{"role":"user"}}', true],
  ["nullable identity type", '{"type":"message","id":"unclassified"}', true, "unclassified"],
  ["message without a body", '{"type":"message"}', true],
  ["non-object", "null", false],
  ["malformed", "{malformed", false],
  ["deep message", `{"type":"message","payload":${"[".repeat(1100)}0${"]".repeat(1100)}}`, true],
] as const)(
  "preserves bootstrap presence for unclassified %s",
  async (_name, raw, expected, identityId?: string) => {
    await withPresence(async (sessionTarget, database, expectPresence) => {
      // Imported or malformed raw rows can lack the optional identity projection.
      createTranscriptEventInserter(
        database.db,
        sessionTarget.sessionId,
      )({
        seq: 0,
        eventJson: raw,
        createdAt: 1,
      });
      if (identityId) {
        database.db
          .prepare(
            "INSERT INTO transcript_event_identities (session_id, event_id, seq, event_type, created_at) VALUES (?, ?, 0, NULL, 1)",
          )
          .run(sessionTarget.sessionId, identityId);
      }
      await expectPresence(expected);
      expect(database.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({
        busy: 0,
      });
    });
  },
);
