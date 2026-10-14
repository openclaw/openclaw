import { describe, expect, it } from "vitest";
import {
  createSessionProjection,
  readSessionMessageIdentity,
  readSessionProjectionFinalMessageIdentity,
  reduceSessionProjection,
  type SessionProjectionEvent,
  type SessionProjectionScope,
  type SessionProjectionState,
} from "./session-projection.js";

const sharedScope: SessionProjectionScope = {
  activeLeafEntryId: "shared-leaf",
  agentId: "main",
  lifecycleRevision: 7,
  sessionId: "shared-session",
  sessionKey: "agent:main:shared",
};

function persistedUser(params: {
  id: string;
  sequence: number;
  runId?: string;
  text?: string;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    __openclaw: {
      id: params.id,
      idempotencyKey: `${params.runId ?? params.id}:user`,
      seq: params.sequence,
      ...params.metadata,
    },
    content: [{ text: params.text ?? params.id, type: "text" }],
    role: "user",
  };
}

function replay(
  events: readonly SessionProjectionEvent[],
  scope: SessionProjectionScope = sharedScope,
): SessionProjectionState {
  let state = createSessionProjection(scope);
  for (const event of events) {
    state = reduceSessionProjection(state, event);
  }
  return state;
}

describe("session projection identity conformance", () => {
  it.each([
    { role: "user", rawSeq: 0 },
    { role: "assistant", rawSeq: 9 },
  ] as const)("keeps a canonical $role row stable through CLI enrichment", ({ role, rawSeq }) => {
    const metadata = {
      id: "native-row",
      seq: 1,
      transcriptPosition: { source: "canonical-transcript", rawSeq },
    };
    const native = { role, content: "Persisted message", __openclaw: metadata };
    const enriched = {
      ...native,
      __openclaw: {
        ...metadata,
        importedFrom: "claude-cli",
        cliSessionId: "external-session",
        externalId: "provider-row",
      },
    };
    let state = createSessionProjection(sharedScope, [enriched]);
    state = reduceSessionProjection(state, { type: "messagePersisted", message: native });
    state = reduceSessionProjection(state, { type: "snapshotLoaded", messages: [enriched] });

    expect(state.messages).toEqual([enriched]);
    expect(readSessionProjectionFinalMessageIdentity(enriched)).toBe(
      readSessionProjectionFinalMessageIdentity(native),
    );
  });

  it.each([
    {
      name: "persisted identity wins over conflicting Gateway envelope",
      message: persistedUser({ id: "persisted-id", runId: "persisted-run", sequence: 3 }),
      envelope: {
        clientRunId: "envelope-run",
        messageId: "envelope-id",
        messageSeq: 99,
        runId: "conflicting-producer-run",
      },
      expected: {
        id: "persisted-id",
        idempotencyKey: "persisted-run:user",
        role: "user",
        runId: "persisted-run",
        sequence: 3,
      },
    },
    {
      name: "producer-owned assistant run wins over its assistant idempotency suffix",
      message: {
        __openclaw: {
          id: "aborted-assistant",
          idempotencyKey: "producer-run:assistant",
          seq: 3,
        },
        content: [{ text: "held partial", type: "text" }],
        role: "assistant",
      },
      envelope: {
        clientRunId: "conflicting-client-run",
        messageId: "aborted-assistant",
        messageSeq: 3,
        runId: "producer-run",
      },
      expected: {
        id: "aborted-assistant",
        idempotencyKey: "producer-run:assistant",
        role: "assistant",
        runId: "producer-run",
        sequence: 3,
      },
    },
    {
      name: "unsafe persisted sequence falls back to a valid envelope sequence",
      message: persistedUser({
        id: "unsafe-sequence",
        sequence: Number.MAX_SAFE_INTEGER + 1,
      }),
      envelope: { messageSeq: 5 },
      expected: { id: "unsafe-sequence", role: "user", sequence: 5 },
    },
  ])("normalizes $name", ({ message, envelope, expected }) => {
    expect(readSessionMessageIdentity(message, envelope)).toMatchObject(expected);
  });

  it("keeps imported IDs isolated from colliding native and other-provider messages", () => {
    const externalId = "colliding-id";
    const native = persistedUser({ id: externalId, sequence: 1 });
    const firstImport = persistedUser({
      id: externalId,
      metadata: { cliSessionId: "cli-a", externalId, importedFrom: "provider-a" },
      sequence: 2,
    });
    const secondImport = persistedUser({
      id: externalId,
      metadata: { cliSessionId: "cli-b", externalId, importedFrom: "provider-a" },
      sequence: 3,
    });
    const incompleteImport = persistedUser({
      id: externalId,
      metadata: { importedFrom: "provider-a" },
      sequence: 4,
    });

    const state = replay([
      { message: native, type: "messagePersisted" },
      { message: firstImport, type: "messagePersisted" },
      { message: secondImport, type: "messagePersisted" },
      { message: incompleteImport, type: "messagePersisted" },
      { message: firstImport, type: "messagePersisted" },
    ]);

    expect(state.entries.map((entry) => entry.identity?.externalSource)).toEqual([
      null,
      JSON.stringify(["provider-a", "cli-a", externalId]),
      JSON.stringify(["provider-a", "cli-b", externalId]),
      null,
    ]);
  });
  it("replays stale history, same-text sends, duplicates, gaps, and terminal events", () => {
    const text = "The same prompt from both clients.";
    const pending = {
      content: [{ text, type: "text" }],
      idempotencyKey: "local-run:user",
      role: "user",
    };
    const peer = persistedUser({ id: "peer-message", runId: "peer-run", sequence: 1, text });
    const local = persistedUser({ id: "local-message", runId: "local-run", sequence: 2, text });
    const events: SessionProjectionEvent[] = [
      { message: pending, runId: "local-run", type: "sendPending" },
      {
        envelope: { messageId: "wrong-peer-envelope", messageSeq: 99 },
        message: peer,
        type: "messagePersisted",
      },
      { idempotencyKey: "local-run:user", type: "sendAcknowledged" },
      { message: local, type: "messagePersisted" },
      {
        envelope: { messageId: "another-wrong-envelope", messageSeq: 100 },
        message: peer,
        type: "messagePersisted",
      },
      { messages: [peer], type: "snapshotLoaded" },
      { type: "transportGap" },
      { type: "reconnected" },
      { message: { content: "streaming" }, runId: "local-run", type: "runDelta" },
      { runId: "local-run", status: "completed", type: "runTerminal" },
      {
        errorMessage: "A delayed diagnostic must not reopen the run.",
        runId: "local-run",
        status: "error",
        type: "runTerminal",
      },
      { messages: [peer], type: "snapshotLoaded" },
    ];

    const state = replay(events);

    expect(state.entries.map((entry) => entry.identity?.id)).toEqual([
      "peer-message",
      "local-message",
    ]);
    expect(state.entries.map((entry) => entry.pending)).toEqual([false, false]);
    expect(state.hasTransportGap).toBe(false);
    expect(state.runs["local-run"]).toMatchObject({
      errorMessage: "A delayed diagnostic must not reopen the run.",
      status: "completed",
    });
  });

  it("drops obsolete leaf and lifecycle events after a session reset", () => {
    const obsolete = persistedUser({ id: "before-reset", sequence: 1 });
    const current = persistedUser({ id: "after-reset", sequence: 1 });
    const currentScope = {
      ...sharedScope,
      activeLeafEntryId: "reset-leaf",
      lifecycleRevision: 8,
    };

    const state = replay([
      { message: obsolete, scope: sharedScope, type: "messagePersisted" },
      { scope: currentScope, type: "sessionReset" },
      { message: obsolete, scope: sharedScope, type: "messagePersisted" },
      { messages: [obsolete], scope: sharedScope, type: "snapshotLoaded" },
      { message: current, scope: currentScope, type: "messagePersisted" },
    ]);

    expect(state.scope).toEqual(currentScope);
    expect(state.entries.map((entry) => entry.identity?.id)).toEqual(["after-reset"]);
  });
});
