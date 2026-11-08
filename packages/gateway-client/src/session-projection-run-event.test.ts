import { assert, expect, it } from "vitest";
import {
  reduceSessionProjectionRunEvent,
  reduceSessionProjection as reduce,
  readSessionMessageIdentity,
  readSessionProjectionFinalMessageIdentity,
  type SessionProjectionGatewayRunEvent,
  type SessionProjectionState,
} from "./session-projection.js";
import {
  primaryScope as scope,
  projection,
  user,
  assistant,
} from "./session-projection.test-support.js";

function runEvent(state: SessionProjectionState, event: SessionProjectionGatewayRunEvent) {
  const transition = reduceSessionProjectionRunEvent(state, { runId: "shared-run", ...event });
  assert(transition);
  return transition;
}

it("clears an existing diagnostic when the terminal owner suppresses its notice", () => {
  const failure = { state: "error", errorMessage: "No answer was returned" };
  const failed = runEvent(projection(), failure);
  const suppressed = runEvent(failed.projection, { ...failure, suppressErrorNotice: true });
  expect(suppressed.currentRun).toMatchObject({
    status: "error",
    suppressErrorNotice: true,
    errorMessage: undefined,
  });
  expect(runEvent(suppressed.projection, failure).currentRun?.errorMessage).toBeUndefined();
});

it("reconstructs append-only output without losing rich content or duplicating snapshot text", () => {
  let state = projection();
  const canvas = { type: "canvas", id: "canvas-1" };
  const metadata = { media: [{ id: "image-1" }] };
  const snapshot = {
    role: "assistant",
    content: [{ type: "text", text: "hello " }, canvas],
    __openclaw: metadata,
  };
  for (const event of [
    { message: snapshot, deltaText: "hello ", text: "hello " },
    { deltaText: " world\n", text: "hello  world\n" },
    { deltaText: "reset", replace: true, text: "reset" },
    { deltaText: "", replace: true, text: "" },
    { deltaText: "done", text: "done" },
  ]) {
    const transition = runEvent(state, { ...event, state: "delta" });
    state = transition.projection;
    expect(transition.currentRun?.message).toEqual({
      ...snapshot,
      content: [{ type: "text", text: event.text }, canvas],
    });
  }
  expect(snapshot.content[0]).toEqual({ type: "text", text: "hello " });
  const final = { role: "assistant", content: "done!" };
  expect(runEvent(state, { state: "final", message: final }).currentRun?.message).toBe(final);
});

it("does not invent a baseline from an orphan append", () => {
  const orphan = runEvent(projection(), { state: "delta", deltaText: "missing prefix" });
  expect(orphan.currentRun?.message).toBeUndefined();
});

it.each([
  { terminalSeq: 10, repeatedSeq: 12, deltaSeq: 11, resumes: false },
  { terminalSeq: 10, repeatedSeq: 12, deltaSeq: 13, resumes: true },
  { terminalSeq: 10, repeatedSeq: 12, deltaSeq: undefined, resumes: false },
  { terminalSeq: undefined, repeatedSeq: undefined, deltaSeq: 13, resumes: false },
])("requires newer run-event order before resuming an error: %j", (scenario) => {
  let state = projection();
  const message = { role: "assistant", content: [], stopReason: "error" };
  for (const event of [
    { state: "delta", seq: 8 },
    { state: "error", seq: scenario.terminalSeq, message },
    { state: "error", seq: scenario.repeatedSeq, message },
  ]) {
    const result = runEvent(state, {
      ...event,
      errorMessage: "provider unavailable",
    });
    state = result.projection;
  }
  const delta = {
    state: "delta",
    seq: scenario.deltaSeq,
    message: { role: "assistant", content: "resumed output" },
  };
  const resumed = runEvent(state, delta);
  expect(resumed?.currentRun?.status).toBe(scenario.resumes ? "streaming" : "error");
  if (!scenario.resumes) {
    expect(resumed?.projection).toBe(state);
    expect(resumed?.currentRun?.message).toBe(message);
    expect(resumed?.currentRun?.errorMessage).toBe("provider unavailable");
  }
});

it.each([
  ["yielded end turn", { state: "final", yielded: true, stopReason: "end_turn" }, "yielded"],
  [
    "message-owned error",
    {
      state: "final",
      message: { role: "assistant", content: "failure", stopReason: "error" },
    },
    "error",
  ],
  ["provider timeout", { state: "error", errorKind: "timeout" }, "timeout"],
  ["aborted run", { state: "aborted" }, "aborted"],
] as const)("normalizes %s for browser and TUI", (_name, event, status) => {
  const result = reduceSessionProjectionRunEvent(
    projection(),
    { ...event, runId: "shared-run" },
    scope,
  );
  expect(result?.previousRun).toBeUndefined();
  expect(result?.currentRun?.status).toBe(status);
  expect(result?.projection.runs["shared-run"]?.status).toBe(status);
});

it("rejects non-run Gateway event states", () => {
  expect(
    reduceSessionProjectionRunEvent(projection(), {
      runId: "shared-run",
      state: "status",
    }),
  ).toBeNull();
});

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
  state = reduce(state, { type: "transportGap" });
  state = reduce(state, { type: "reconnected" });
  state = reduce(state, { type: "snapshotLoaded", messages: [enriched] });

  expect(state.messages).toEqual([enriched]);
  expect(state.hasTransportGap).toBe(false);
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
    readSessionMessageIdentity(
      user("unsafe-sequence", { id: "unsafe-sequence", seq: Number.MAX_SAFE_INTEGER + 1 }),
      {
        messageSeq: 5,
      },
    ),
  ).toMatchObject({ id: "unsafe-sequence", role: "user", sequence: 5 });
});
