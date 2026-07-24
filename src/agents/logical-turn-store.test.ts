import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db.js";
import {
  acceptLogicalTurnInTransaction,
  claimLogicalTurnAttempt,
  finishLogicalTurnAttempt,
  readLogicalTurn,
} from "./logical-turn-store.js";

const tempDirs: string[] = [];

function createDatabaseOptions(): OpenClawAgentDatabaseOptions {
  return {
    agentId: "main",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "openclaw-logical-turn-"),
    },
  };
}

function seedTranscriptIdentity(
  options: OpenClawAgentDatabaseOptions,
  params: { sessionId: string; sessionKey: string; eventId: string },
): void {
  const database = openOpenClawAgentDatabase(options);
  const now = Date.now();
  database.db
    .prepare(
      `INSERT INTO session_nodes (
         session_key, current_session_id, entry_json, updated_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(params.sessionKey, params.sessionId, "{}", now);
  database.db
    .prepare(
      `INSERT INTO session_windows (
         session_id, session_key, session_scope, created_at, updated_at
       ) VALUES (?, ?, 'conversation', ?, ?)`,
    )
    .run(params.sessionId, params.sessionKey, now, now);
  database.db
    .prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 1, '{}', ?)",
    )
    .run(params.sessionId, now);
  database.db
    .prepare(
      `INSERT INTO transcript_event_identities (
         session_id, event_id, seq, event_type, message_idempotency_key, created_at
       ) VALUES (?, ?, 1, 'message', ?, ?)`,
    )
    .run(params.sessionId, params.eventId, "source:user", now);
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("logical turn store", () => {
  it("accepts one logical turn for repeated ingress identity", () => {
    const options = createDatabaseOptions();
    const identity = { sessionId: "session-1", sessionKey: "agent:main:main", eventId: "event-1" };
    seedTranscriptIdentity(options, identity);

    const accept = () =>
      runOpenClawAgentWriteTransaction(
        (database) =>
          acceptLogicalTurnInTransaction(database, {
            logicalTurnId: "telegram:source:user",
            ingressKind: "telegram",
            ingressKey: "source:user",
            userEventId: identity.eventId,
            sessionId: identity.sessionId,
            sessionKey: identity.sessionKey,
            now: 100,
          }),
        options,
      );

    expect(accept()).toMatchObject({ accepted: true, created: true });
    expect(accept()).toMatchObject({ accepted: true, created: false });
    expect(readLogicalTurn(options, "telegram:source:user")).toMatchObject({
      currentAttemptEpoch: 0,
      state: "accepted",
      userEventId: identity.eventId,
    });
  });

  it("leaves an accepted turn claimable after an accept-before-provider crash", () => {
    const options = createDatabaseOptions();
    const identity = { sessionId: "session-2", sessionKey: "agent:main:main", eventId: "event-2" };
    seedTranscriptIdentity(options, identity);
    runOpenClawAgentWriteTransaction(
      (database) =>
        acceptLogicalTurnInTransaction(database, {
          logicalTurnId: "chat:run-2:user",
          ingressKind: "chat",
          ingressKey: "run-2:user",
          userEventId: identity.eventId,
          sessionId: identity.sessionId,
          sessionKey: identity.sessionKey,
          now: 200,
        }),
      options,
    );

    expect(
      claimLogicalTurnAttempt(options, {
        logicalTurnId: "chat:run-2:user",
        ownerId: "worker-a",
        leaseDurationMs: 30_000,
        now: 201,
      }),
    ).toMatchObject({ claimed: true, attemptEpoch: 1 });
  });

  it("allows only one active attempt and permits a later attempt after settlement", () => {
    const options = createDatabaseOptions();
    const identity = { sessionId: "session-3", sessionKey: "agent:main:main", eventId: "event-3" };
    seedTranscriptIdentity(options, identity);
    runOpenClawAgentWriteTransaction(
      (database) =>
        acceptLogicalTurnInTransaction(database, {
          logicalTurnId: "chat:run-3:user",
          ingressKind: "chat",
          ingressKey: "run-3:user",
          userEventId: identity.eventId,
          sessionId: identity.sessionId,
          sessionKey: identity.sessionKey,
          now: 300,
        }),
      options,
    );

    const first = claimLogicalTurnAttempt(options, {
      logicalTurnId: "chat:run-3:user",
      ownerId: "worker-a",
      leaseDurationMs: 30_000,
      now: 301,
    });
    expect(first).toMatchObject({ claimed: true, attemptEpoch: 1 });
    expect(
      claimLogicalTurnAttempt(options, {
        logicalTurnId: "chat:run-3:user",
        ownerId: "worker-b",
        leaseDurationMs: 30_000,
        now: 302,
      }),
    ).toEqual({ claimed: false, reason: "active-attempt" });

    expect(
      finishLogicalTurnAttempt(options, {
        logicalTurnId: "chat:run-3:user",
        attemptEpoch: 1,
        ownerId: "worker-a",
        outcome: "failed",
        terminal: false,
        now: 303,
      }),
    ).toBe(true);
    const second = claimLogicalTurnAttempt(options, {
      logicalTurnId: "chat:run-3:user",
      ownerId: "worker-b",
      leaseDurationMs: 30_000,
      now: 304,
    });
    expect(second).toMatchObject({ claimed: true, attemptEpoch: 2 });
    expect(
      finishLogicalTurnAttempt(options, {
        logicalTurnId: "chat:run-3:user",
        attemptEpoch: 2,
        ownerId: "worker-b",
        outcome: "succeeded",
        terminal: true,
        now: 305,
      }),
    ).toBe(true);
    expect(
      claimLogicalTurnAttempt(options, {
        logicalTurnId: "chat:run-3:user",
        ownerId: "worker-c",
        leaseDurationMs: 30_000,
        now: 306,
      }),
    ).toEqual({ claimed: false, reason: "terminal-turn" });
  });
});
