import { describe, expect, it } from "vitest";
import {
  readSessionMessageIdentity,
  readSessionProjectionFinalMessageIdentity,
  reduceSessionProjection as reduce,
  type SessionProjectionEvent,
  type SessionProjectionState,
} from "./session-projection.js";
import { user, assistant, projection } from "./session-projection.test-support.js";

function persistedUser(
  id: string,
  sequence: number,
  options: { runId?: string; text?: string } = {},
) {
  return user(options.text ?? id, {
    id,
    seq: sequence,
    idempotencyKey: `${options.runId ?? id}:user`,
  });
}

const replay = (events: readonly SessionProjectionEvent[]) =>
  events.reduce<SessionProjectionState>(reduce, projection());

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
    let state = projection([enriched]);
    state = reduce(state, { type: "messagePersisted", message: native });
    state = reduce(state, { type: "snapshotLoaded", messages: [enriched] });

    expect(state.messages).toEqual([enriched]);
    expect(readSessionProjectionFinalMessageIdentity(enriched)).toBe(
      readSessionProjectionFinalMessageIdentity(native),
    );
  });

  it.each([
    ["user", "persisted-run", "conflicting-producer-run"],
    ["assistant", "producer-run", "producer-run"],
  ] as const)(
    "keeps persisted %s identity and producer-owned run precedence",
    (role, runId, envelopeRun) => {
      const id = `${role}-row`;
      const idempotencyKey = `${runId}:${role}`;
      const message = (role === "user" ? user : assistant)("persisted", {
        id,
        idempotencyKey,
        seq: 3,
      });
      expect(
        readSessionMessageIdentity(message, {
          clientRunId: "conflicting-client-run",
          messageId: "envelope-id",
          messageSeq: 99,
          runId: envelopeRun,
        }),
      ).toMatchObject({ id, idempotencyKey, role, runId, sequence: 3 });
    },
  );

  it("falls back from an unsafe persisted sequence to the envelope", () => {
    expect(
      readSessionMessageIdentity(persistedUser("unsafe-sequence", Number.MAX_SAFE_INTEGER + 1), {
        messageSeq: 5,
      }),
    ).toMatchObject({ id: "unsafe-sequence", role: "user", sequence: 5 });
  });

  it("replays stale history, same-text sends, duplicates, gaps, and terminal events", () => {
    const text = "The same prompt from both clients.";
    const pending = { ...user(text), idempotencyKey: "local-run:user" };
    const peer = persistedUser("peer-message", 1, { runId: "peer-run", text });
    const local = persistedUser("local-message", 2, { runId: "local-run", text });
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
});
