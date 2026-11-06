import { expect, it } from "vitest";
import { insertSessionProjectionEntry } from "./session-projection-order.js";
import {
  hasSessionProjectionAcceptedFinal,
  reduceSessionProjection,
  type SessionProjectionState,
} from "./session-projection.js";
import {
  assistant,
  delta,
  persist,
  projection,
  savedReply,
  savedUser,
  terminal,
} from "./session-projection.test-support.js";

const admit = (state: SessionProjectionState, messages: readonly unknown[] = []) =>
  reduceSessionProjection(state, { type: "residencyChanged", messages });

it("preserves explicit local output on refresh but lets residency and reset retire it", () => {
  const output = { role: "system", content: "command result" };
  const before = savedUser("before", "before", 1);
  const after = savedUser("after", "after", 2);
  let state = reduceSessionProjection(projection([before]), {
    type: "localOutput",
    message: output,
  });
  state = reduceSessionProjection(state, { type: "snapshotLoaded", messages: [before, after] });
  expect(state.messages).toEqual([before, output, after]);
  expect(state.entries[1]).toMatchObject({ localOutput: true, live: false, pending: false });
  state = reduceSessionProjection(state, { type: "snapshotLoaded", messages: state.messages });
  expect(state.messages).toEqual([before, output, after]);
  const retired = admit(state, [before, after]);
  expect(retired.messages).toEqual([before, after]);
  expect(reduceSessionProjection(state, { type: "sessionReset" }).messages).toEqual([]);
});

it("records local output after a supported roleless source", () => {
  const before = savedUser("before", "before", 2);
  const marker = { type: "compaction", __openclaw: { seq: 3 } };
  const after = savedUser("after", "after", 4);
  const output = { role: "system", content: "command result" };
  let state = reduceSessionProjection(projection([before, marker]), {
    type: "localOutput",
    message: output,
  });
  expect(state.entries.at(-1)).toMatchObject({ localOutput: true, afterSequence: 3 });
  state = reduceSessionProjection(state, {
    type: "snapshotLoaded",
    messages: [before, marker, after],
  });
  expect(state.messages).toEqual([before, marker, output, after]);
});

it.each([false, true])(
  "keeps local output before a later roleless source with predecessor retired=%s",
  (retired) => {
    const before = savedUser("before", "before", 2);
    const marker = { type: "compaction", __openclaw: { seq: 3 } };
    const after = savedUser("after", "after", 4);
    const output = { role: "system", content: "command result" };
    let state = reduceSessionProjection(projection([before]), {
      type: "localOutput",
      message: output,
    });
    if (retired) {
      state = admit(state, [output, after]);
      expect(state.messages).toEqual([output, after]);
    }
    const messages = retired ? [marker, after] : [before, marker, after];
    state = reduceSessionProjection(state, { type: "snapshotLoaded", messages });
    expect(state.messages).toEqual(
      retired ? [output, marker, after] : [before, output, marker, after],
    );
    expect(state.entries.find((entry) => entry.localOutput)?.message).toBe(output);
  },
);

it("keeps envelope-owned sequence facts in local output cuts and boundaries", () => {
  const durable = { role: "assistant", content: "envelope-owned source" };
  const output = { role: "system", content: "command result" };
  let state = reduceSessionProjection(projection(), {
    type: "messagePersisted",
    message: durable,
    envelope: { messageSeq: 3 },
  });
  state = reduceSessionProjection(state, { type: "localOutput", message: output });
  expect(state.entries[1]).toMatchObject({ localOutput: true, afterSequence: 3 });
  const earlier = reduceSessionProjection(projection([savedUser("before", "before", 2)]), {
    type: "localOutput",
    message: output,
  });
  const durableEntry = state.entries[0];
  const localEntry = earlier.entries[1];
  if (!durableEntry || !localEntry) {
    throw new Error("Expected durable and local projection entries");
  }
  expect(
    insertSessionProjectionEntry([durableEntry], localEntry).map((entry) => entry.message),
  ).toEqual([output, durable]);
});

it("releases a settled durable primary while preserving payload-free replay facts", () => {
  const message = savedReply("large body ".repeat(2_000), "primary", 1, { runId: "run-1" });
  let state = terminal(projection(), { message });
  state = persist(state, message);
  state = admit(state);
  expect(state.messages).toHaveLength(0);
  expect(state.runs["run-1"]?.message).toBeUndefined();
  expect(JSON.stringify(state.runs)).not.toContain("large body");
  expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], message)).toBe(true);
  expect(terminal(state, { message })).toBe(state);
});

it("keeps the primary receipt after it rolls out of the recent-final ring", () => {
  const primary = assistant("primary");
  let state = terminal(projection(), { message: primary });
  for (let index = 0; index < 40; index += 1) {
    state = terminal(state, { message: assistant(`secondary-${index}`) });
  }
  state = admit(state);
  expect(state.runs["run-1"]?.message).toBeUndefined();
  expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], primary)).toBe(true);
  expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], assistant("secondary-39"))).toBe(
    true,
  );
  expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], assistant("secondary-0"))).toBe(
    false,
  );
  expect(terminal(state, { message: primary })).toBe(state);
});

it("does not turn an evicted identified empty terminal into an unkeyed recovery", () => {
  const empty = savedReply("", "primary", 1);
  let state = admit(terminal(projection(), { message: empty }));
  expect(state.runs["run-1"]?.message).toBeUndefined();
  const conflicting = savedReply("different", "other", 2);
  expect(terminal(state, { message: conflicting })).toBe(state);
  const recovered = savedReply("recovered", "primary", 1);
  state = terminal(state, { message: recovered });
  expect(state.runs["run-1"]?.message).toBe(recovered);
  expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], recovered)).toBe(true);
});

it("records the inherited stream primary when a terminal omits its message", () => {
  const stream = assistant("inherited stream");
  const state = admit(terminal(delta(projection(), "run-1", stream)));
  expect(state.runs["run-1"]?.message).toBeUndefined();
  expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], stream)).toBe(true);
  expect(terminal(state, { message: stream })).toBe(state);
  expect(terminal(state, { status: "yielded", message: assistant("different status") })).toBe(
    state,
  );
});

it("preserves semantic fences across pure retirement and ignored replay", () => {
  const message = savedReply("settled", "primary", 1);
  const state = terminal(projection(), { message });
  const before = state.runs["run-1"];
  const retired = admit(state);
  expect(before?.revision).toBeDefined();
  expect(retired.runs["run-1"]?.revision).toBe(before?.revision);
  expect(retired.runs["run-1"]?.messageRevision).toBe(before?.messageRevision);
  expect(terminal(retired, { message })).toBe(retired);
  const advanced = terminal(retired, { seq: 7 });
  expect(advanced.runs["run-1"]?.revision).not.toBe(before?.revision);
  expect(advanced.runs["run-1"]?.messageRevision).toBe(before?.messageRevision);
});

it("advances the message fence only when the effective primary changes", () => {
  const started = delta(projection(), "active");
  expect(started.runs.active?.revision).toBeDefined();
  expect(started.runs.active?.messageRevision).toBeUndefined();
  const message = assistant("same baseline");
  const withMessage = delta(started, "active", message, 1);
  const unchanged = delta(withMessage, "active", message, 2);
  expect(unchanged.runs.active?.revision).not.toBe(withMessage.runs.active?.revision);
  expect(unchanged.runs.active?.messageRevision).toBe(withMessage.runs.active?.messageRevision);
  const replaced = delta(unchanged, "active", assistant("replacement"), 3);
  expect(replaced.runs.active?.messageRevision).not.toBe(unchanged.runs.active?.messageRevision);
});

it("pins streaming, error and pending bodies at their existing owners", () => {
  const active = assistant("still streaming");
  let state = delta(projection(), "active", active);
  const failed = assistant("useful partial");
  state = terminal(state, { runId: "failed", status: "error", message: failed });
  const pending = { role: "user", content: "pending", idempotencyKey: "pending-run" };
  state = reduceSessionProjection(state, {
    type: "sendPending",
    runId: "pending-run",
    message: pending,
  });
  state = admit(state);
  expect(state.runs.active?.message).toBe(active);
  expect(state.runs.failed?.message).toBe(failed);
  expect(state.messages).toContain(pending);
});

it("pins both inference bodies until authority confirms or contradicts the match", () => {
  const original = assistant("selected answer");
  const prompt = savedUser("request", "prompt", 1, { runId: "run-1" });
  const candidate = savedReply("selected answer", "candidate", 2, { runId: "run-1" });
  let state = reduceSessionProjection(terminal(projection(), { message: original }), {
    type: "messagePersisted",
    message: original,
    envelope: { runId: "run-1" },
  });
  state = reduceSessionProjection(state, {
    type: "snapshotLoaded",
    scope: state.scope,
    messages: [prompt, candidate],
  });
  expect(state.runs["run-1"]?.inferredSnapshotTerminal?.entry.message).toBe(original);
  state = admit(state);
  expect(state.messages).toContain(candidate);
  expect(state.runs["run-1"]?.inferredSnapshotTerminal?.entry.message).toBe(original);
  const later = savedReply("different later answer", "later", 3, { runId: "run-1" });
  state = reduceSessionProjection(state, {
    type: "snapshotLoaded",
    scope: state.scope,
    messages: [prompt, candidate, later],
  });
  expect(state.messages).toContain(original);
});

it("does not pin old durable commentary just because its run is still active", () => {
  const commentary = savedReply("old commentary", "commentary", 1, { runId: "active" });
  const active = assistant("current baseline");
  const state = admit(delta(projection([commentary]), "active", active));
  expect(state.messages).not.toContain(commentary);
  expect(state.runs.active?.message).toBe(active);
});

it.each(["pending", "live", "unsequenced", "unknown local", "gap"] as const)(
  "does not start-place a local output ahead of an existing %s predecessor",
  (kind) => {
    let state = projection();
    const prior = { role: "user", content: "prior" };
    if (kind === "pending") {
      state = reduceSessionProjection(state, {
        type: "sendPending",
        runId: "pending",
        message: prior,
      });
    }
    if (kind === "live") {
      state = delta(state, "live", { role: "assistant", content: "live" });
    }
    if (kind === "unsequenced") {
      state = reduceSessionProjection(state, { type: "snapshotLoaded", messages: [prior] });
    }
    if (kind === "unknown local") {
      state = reduceSessionProjection(state, { type: "localOutput", message: prior });
    }
    if (kind === "gap") {
      state = reduceSessionProjection(state, { type: "transportGap" });
    }
    const output = { role: "system", content: "later command" };
    state = reduceSessionProjection(state, {
      type: "localOutput",
      message: output,
      sourceEmpty: true,
    });
    expect(state.entries.find((entry) => entry.message === output)?.atHistoryStart).toBeUndefined();
  },
);

it("preserves consecutive authorized local outputs before later source without inventing sequence zero", () => {
  const first = { role: "system", content: "first" };
  const second = { role: "system", content: "second" };
  let state = projection();
  for (const message of [first, second]) {
    state = reduceSessionProjection(state, { type: "localOutput", message, sourceEmpty: true });
  }
  const user = savedUser("later", "later", 1);
  state = reduceSessionProjection(state, { type: "snapshotLoaded", messages: [user] });
  expect(state.messages).toEqual([first, second, user]);
  expect(
    state.entries
      .slice(0, 2)
      .every(
        (entry) =>
          entry.identity?.sequence == null && entry.afterSequence == null && entry.atHistoryStart,
      ),
  ).toBe(true);
});
