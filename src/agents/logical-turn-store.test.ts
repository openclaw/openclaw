import { createHash } from "node:crypto";
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
  commitLogicalTurnToolEffect,
  claimLogicalTurnAttempt,
  dispatchLogicalTurnToolEffect,
  finishLogicalTurnAttempt,
  markLogicalTurnToolEffectUnknown,
  planLogicalTurnToolEffect,
  readLogicalTurn,
  reconcileLogicalTurnToolEffect,
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

  it("keeps one effect identity and pauses replay after an ambiguous dispatch", () => {
    const options = createDatabaseOptions();
    const identity = { sessionId: "session-4", sessionKey: "agent:main:main", eventId: "event-4" };
    seedTranscriptIdentity(options, identity);
    runOpenClawAgentWriteTransaction(
      (database) =>
        acceptLogicalTurnInTransaction(database, {
          logicalTurnId: "telegram:source-4",
          ingressKind: "telegram",
          ingressKey: "source-4",
          userEventId: identity.eventId,
          sessionId: identity.sessionId,
          sessionKey: identity.sessionKey,
          now: 400,
        }),
      options,
    );
    expect(
      claimLogicalTurnAttempt(options, {
        logicalTurnId: "telegram:source-4",
        ownerId: "worker-a",
        leaseDurationMs: 10,
        now: 401,
      }),
    ).toMatchObject({ claimed: true, attemptEpoch: 1 });

    const planned = planLogicalTurnToolEffect(options, {
      logicalTurnId: "telegram:source-4",
      attemptEpoch: 1,
      assistantCheckpointId: "tool-call-1",
      toolCallId: "tool-call-1",
      toolName: "message",
      replayClass: "external",
      now: 402,
    });
    expect(
      planLogicalTurnToolEffect(options, {
        logicalTurnId: "telegram:source-4",
        attemptEpoch: 1,
        assistantCheckpointId: "tool-call-1",
        toolCallId: "tool-call-1",
        toolName: "message",
        replayClass: "external",
        now: 403,
      }).effectId,
    ).toBe(planned.effectId);
    expect(
      dispatchLogicalTurnToolEffect(options, { effectId: planned.effectId, now: 404 }),
    ).toMatchObject({ claimed: true, effect: { state: "dispatched" } });
    expect(markLogicalTurnToolEffectUnknown(options, { effectId: planned.effectId })).toBe(true);
    expect(
      finishLogicalTurnAttempt(options, {
        logicalTurnId: "telegram:source-4",
        attemptEpoch: 1,
        ownerId: "worker-a",
        outcome: "failed",
        terminal: true,
        now: 405,
      }),
    ).toBe(false);

    expect(
      claimLogicalTurnAttempt(options, {
        logicalTurnId: "telegram:source-4",
        ownerId: "worker-b",
        leaseDurationMs: 10,
        now: 412,
      }),
    ).toEqual({ claimed: false, reason: "effect-unknown" });

    expect(() =>
      reconcileLogicalTurnToolEffect(options, {
        effectId: planned.effectId,
        expectedGeneration: 0,
        outcome: "not_occurred",
        operatorAuthorized: false,
        auditIdentity: "operator-1",
        coordinatorId: "coordinator-1",
        now: 413,
      }),
    ).toThrow("authenticated operator");
    expect(
      reconcileLogicalTurnToolEffect(options, {
        effectId: planned.effectId,
        expectedGeneration: 0,
        outcome: "not_occurred",
        operatorAuthorized: true,
        auditIdentity: "operator-1",
        coordinatorId: "coordinator-1",
        now: 414,
      }),
    ).toEqual({ reconciled: true, nextGeneration: 1 });
    expect(
      reconcileLogicalTurnToolEffect(options, {
        effectId: planned.effectId,
        expectedGeneration: 0,
        outcome: "not_occurred",
        operatorAuthorized: true,
        auditIdentity: "operator-1",
        coordinatorId: "coordinator-1",
        now: 415,
      }),
    ).toEqual({ reconciled: false, reason: "stale" });
    expect(
      claimLogicalTurnAttempt(options, {
        logicalTurnId: "telegram:source-4",
        ownerId: "worker-b",
        leaseDurationMs: 10,
        now: 416,
      }),
    ).toMatchObject({ claimed: true, attemptEpoch: 2 });
    expect(
      planLogicalTurnToolEffect(options, {
        logicalTurnId: "telegram:source-4",
        attemptEpoch: 2,
        assistantCheckpointId: "tool-call-1",
        toolCallId: "tool-call-1",
        toolName: "message",
        replayClass: "external",
        now: 417,
      }).effectId,
    ).toBe(planned.effectId);
    expect(
      dispatchLogicalTurnToolEffect(options, { effectId: planned.effectId, now: 418 }),
    ).toMatchObject({ claimed: true, effect: { state: "dispatched" } });
  });

  it("commits one tool effect and refuses a second dispatch", () => {
    const options = createDatabaseOptions();
    const identity = { sessionId: "session-5", sessionKey: "agent:main:main", eventId: "event-5" };
    seedTranscriptIdentity(options, identity);
    runOpenClawAgentWriteTransaction(
      (database) =>
        acceptLogicalTurnInTransaction(database, {
          logicalTurnId: "telegram:source-5",
          ingressKind: "telegram",
          ingressKey: "source-5",
          userEventId: identity.eventId,
          sessionId: identity.sessionId,
          sessionKey: identity.sessionKey,
          now: 500,
        }),
      options,
    );
    claimLogicalTurnAttempt(options, {
      logicalTurnId: "telegram:source-5",
      ownerId: "worker-a",
      leaseDurationMs: 10_000,
      now: 501,
    });
    const effect = planLogicalTurnToolEffect(options, {
      logicalTurnId: "telegram:source-5",
      attemptEpoch: 1,
      assistantCheckpointId: "tool-call-2",
      toolCallId: "tool-call-2",
      toolName: "read",
      replayClass: "replay_safe",
      now: 502,
    });
    expect(
      dispatchLogicalTurnToolEffect(options, { effectId: effect.effectId, now: 503 }).claimed,
    ).toBe(true);
    let toolExecutions = 0;
    const originalResult = (() => {
      toolExecutions += 1;
      return { content: [{ type: "text", text: "same" }], details: { value: 7 } };
    })();
    const resultJson = JSON.stringify(originalResult);
    const resultHash = createHash("sha256").update(resultJson).digest("hex");
    expect(
      commitLogicalTurnToolEffect(options, {
        effectId: effect.effectId,
        resultJson,
        resultHash,
        now: 504,
      }),
    ).toBe(true);
    const replay = dispatchLogicalTurnToolEffect(options, { effectId: effect.effectId, now: 505 });
    expect(replay).toMatchObject({
      claimed: false,
      effect: { state: "committed", resultJson, resultHash },
    });
    expect(JSON.parse(replay.effect.resultJson!)).toEqual(originalResult);
    expect(toolExecutions).toBe(1);
  });
});
