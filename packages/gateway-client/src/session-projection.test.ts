import { expect, it } from "vitest";
import { readSessionMessageIdentity as readBrowserSessionMessageIdentity } from "./browser.js";
import { readSessionMessageIdentity as readNodeSessionMessageIdentity } from "./index.js";
import {
  hasSessionProjectionAcceptedFinal as acceptedFinal,
  isLocallyOptimisticSessionMessage as isOptimistic,
  normalizeSessionProjectionRunId,
  projectLiveSessionMessage as project,
  readSessionMessageIdentity as identity,
  readSessionMessageSequence,
  reconcileSessionProjectionSnapshot as reconcile,
  reduceSessionProjection as reduce,
  type SessionProjectionState,
} from "./session-projection.js";
import {
  assistant as reply,
  primaryScope,
  projection,
  terminal,
  user,
  savedUser,
  savedReply,
  prompt as keyedUser,
  persist,
  pending as sendPending,
  acknowledge,
  delta,
} from "./session-projection.test-support.js";
const expectRows = (state: SessionProjectionState, ...messages: unknown[]) =>
  expect(state.messages).toEqual(messages);
const segment = <T extends object>(message: T, runId?: string) => ({
  ...message,
  openclawStreamFallback: { itemId: "item-1", runId, source: "segment" },
});
it("reads the same canonical contract from both supported package barrels", () => {
  const message = savedUser("hello", "persisted", 7);
  expect(readBrowserSessionMessageIdentity(message)).toEqual(identity(message));
  expect(readNodeSessionMessageIdentity(message)).toEqual(identity(message));
});
it("normalizes an empty user-suffixed run ID", () => {
  expect(normalizeSessionProjectionRunId(":user")).toBe(null);
});
it("keeps assistant dedupe identity separate from producer-owned run identity", () => {
  const assistant = (idempotencyKey: string, runId?: string) => ({
    ...reply("commentary", { mirrorOrigin: "codex-app-server", runId }),
    idempotencyKey,
  });
  const key = "codex-app-server:thread-1:turn-1:commentary:item-1";
  expect(identity(assistant(key, "run-1"))).toMatchObject({
    idempotencyKey: key,
    runId: "run-1",
  });
  expect(identity(assistant("codex-app-server:thread-1:history:turn-1:assistant"))).toHaveProperty(
    "runId",
    null,
  );
});
it("preserves the durable sequence of role-less history and status markers", () => {
  expect(readSessionMessageSequence({ __openclaw: { seq: 7 } })).toBe(7);
});
it("keeps every early same-run reply behind its delayed durable prompt", () => {
  const first = reply("first current reply");
  const second = reply("second current reply");
  const later = reply("later current reply");
  const unrelated = reply("unrelated live reply");
  const previous = savedReply("previous durable reply", "previous", 10);
  const following = savedUser("following durable prompt", "following", 20);
  const prompt = savedUser("delayed current prompt", "current-prompt", 11, {
    idempotencyKey: "current-run:user",
  });
  let state = project(projection(), unrelated, { runId: "unrelated-run" });
  state = project(state, first, { runId: "current-run" });
  state = project(state, second, { runId: "current-run" });
  state = project(state, previous);
  state = project(state, following);
  state = project(state, later, { runId: "current-run" });
  state = project(state, prompt);
  expect(state.messages).toEqual([unrelated, previous, prompt, first, second, following, later]);
  expect(reconcile(state, [], primaryScope).messages).toEqual(state.messages);
});
it("does not promote a provisional final into same-run Codex commentary", () => {
  const commentary = reply("commentary", {
    id: "commentary-1",
    mirrorOrigin: "codex-app-server",
    runId: "run-1",
  });
  const final = reply("final answer");
  let state = project(projection(), commentary, { runId: "run-1" });
  state = project(state, final, { runId: "run-1" });
  expect(state.messages).toEqual([commentary, final]);
});
it("does not adopt commentary with an unknown run", () => {
  const local = segment(
    reply("Repeated progress.", { id: undefined, seq: undefined, importedFrom: undefined }),
  );
  const durable = segment(
    savedReply("Repeated progress.", "persisted", 3, {
      runId: "run-1",
      mirrorOrigin: "codex-app-server",
    }),
  );
  const final = savedReply("Finished.", "final", 4, { runId: "run-1" });
  let state = projection([local, final]);
  state = project(state, durable);
  expectRows(state, local, durable, final);
  state = reduce(state, { type: "transportGap" });
  state = reduce(state, { type: "reconnected" });
  state = project(state, durable);
  expectRows(state, local, durable, final);
});
it("keeps authoritative commentary when its provisional item replays with different text", () => {
  const durable = segment(
    savedReply("Authoritative progress.", "persisted", 3, { runId: "run-1" }),
  );
  const local = segment(reply("Partial progress."), "run-1");
  const state = project(projection(), durable);
  expectRows(project(state, local), durable);
  expectRows(reconcile(state, [durable], primaryScope), durable);
});
it("keeps a post-boundary tail until its own durable row arrives live", () => {
  const prefix = savedReply("saved prefix", "prefix", 2, { runId: "active-run" });
  const steer = savedUser("continue", "steer", 3);
  const tail = reply("unseen tail");
  const savedTail = savedReply("unseen tail", "tail", 4, { runId: "active-run" });
  let state = project(projection([prefix, steer]), tail, {
    runId: "active-run",
    afterSequence: 3,
  });
  state = reconcile(state, [prefix, steer], primaryScope);
  expectRows(state, prefix, steer, tail);
  state = project(state, savedTail);
  expectRows(state, prefix, steer, savedTail);
});
it("does not adopt an ambiguous synthetic final across distinct same-run assistants", () => {
  const synthetic = reply("delta-only final", { idempotencyKey: "final-run" });
  const first = savedReply("first final", "assistant-first", 7, { idempotencyKey: "final-run" });
  const second = savedReply("second final", "assistant-second", 8, {
    idempotencyKey: "final-run",
  });
  const state = project(projection(), synthetic);
  expectRows(reconcile(state, [first, second], primaryScope), first, second, synthetic);
  expectRows(project(projection([first, second]), synthetic), first, second, synthetic);
  const ambiguous = reconcile(state, [first, second], primaryScope);
  expectRows(project(ambiguous, structuredClone(first)), first, second, synthetic);
});
it("promotes a native sequence-only live row to its durable snapshot identity", () => {
  const live = user("live projection", { seq: 7 });
  const persisted = savedUser("persisted projection", "canonical-user-7", 7);
  const state = project(projection(), live);
  expectRows(reconcile(state, [persisted], primaryScope), persisted);
});
it("rejects live events from another agent, session, reset epoch, or branch", () => {
  const prompt = savedUser("isolated", "isolated", 1);
  const state = projection();
  for (const scope of [
    { sessionKey: "agent:other:shared" },
    { sessionId: "other-session" },
    { agentId: "other" },
    { lifecycleRevision: 2 },
    { activeLeafEntryId: "other-leaf" },
  ]) {
    expect(project(state, prompt, undefined, scope)).toBe(state);
  }
});
it("keeps imported ID collisions separate without valid placement", () => {
  const native = savedUser("native", "provider-local", 1);
  const imported = savedUser("imported", "provider-local", 2, {
    importedFrom: "claude-cli",
    cliSessionId: "cli-session",
    externalId: "provider-local",
    transcriptPosition: { source: "foreign", rawSeq: -1 },
  });
  let state = project(projection(), native);
  state = project(state, imported);
  const otherSession = {
    ...imported,
    __openclaw: { ...imported["__openclaw"], cliSessionId: "other" },
  };
  const partial = user("partial", { importedFrom: "claude-cli", seq: 3 });
  state = project(project(project(state, otherSession), partial), imported);
  expectRows(state, native, imported, otherSession, partial);
});
it("adopts snapshot projections of partial imports by canonical session sequence", () => {
  const live = savedUser("live imported projection", "provider-local", 7, {
    importedFrom: "claude-cli",
  });
  const snapshot = savedUser("snapshot imported projection", "provider-local", 7, {
    importedFrom: "claude-cli",
  });
  const state = project(projection(), live);
  expectRows(reconcile(state, [snapshot], primaryScope), snapshot);
});
it("does not merge a partial import into a complete source tuple at the same sequence", () => {
  const partial = user("partial source", { importedFrom: "claude-cli", seq: 7 });
  const complete = user("complete source", {
    importedFrom: "claude-cli",
    cliSessionId: "cli-session",
    externalId: "provider-local",
    seq: 7,
  });
  let state = project(projection(), partial);
  state = project(state, complete);
  expectRows(state, partial, complete);
});
it("explicitly promotes only the admitted sequenced handoff", () => {
  const turn = (seq: number, id?: string) =>
    user("continue", {
      idempotencyKey: "initial-run:user",
      seq,
      ...(id ? { id } : {}),
    });
  const peer = turn(1);
  const handoff = turn(2);
  const answer = reply("already working", { seq: 3 });
  let state = projection([peer, handoff, answer]);
  state = sendPending(state, "initial-run", handoff);
  expectRows(reduce(state, { type: "sendFailed", runId: "initial-run" }), peer, answer);
  const wrongSequence = turn(4, "wrong-sequence-user");
  state = persist(state, wrongSequence);
  expectRows(state, peer, handoff, answer, wrongSequence);
  expect(state.entries[1]).toMatchObject({ pending: true, pendingRunId: "initial-run" });
  const authoritative = turn(2, "initial-user");
  state = persist(state, authoritative);
  expectRows(state, peer, authoritative, answer, wrongSequence);
  expect(reduce(state, { type: "sendFailed", runId: "initial-run" })).toBe(state);
  for (const protectedMessage of [
    savedUser("persisted", "persisted-user", 4, { idempotencyKey: "protected-run:user" }),
    user("imported", {
      importedFrom: "claude-cli",
      cliSessionId: "cli-session",
      externalId: "external-user",
      idempotencyKey: "protected-run:user",
      seq: 4,
    }),
  ]) {
    const protectedState = projection([protectedMessage]);
    expect(sendPending(protectedState, "protected-run", protectedMessage)).toBe(protectedState);
  }
});
it("reconciles a restored pending send with a completed queued execution", () => {
  const pending = keyedUser("Update the menu", "queued-send:user");
  const persisted = savedUser("Update the menu", "persisted-prompt", 1, {
    idempotencyKey: "queued-send:user",
    runId: "queued-execution",
  });
  const response = savedReply("Menu updated", "persisted-reply", 2, {
    runId: "queued-execution",
  });
  const state = projection([persisted, response, pending]);
  const reconciled = reconcile(state, [persisted, response], primaryScope);
  expectRows(reconciled, persisted, response);
  expectRows(sendPending(reconciled, "queued-send", pending), persisted, response);
});
it("rejects a delayed old-epoch snapshot after the selected session resets", () => {
  const oldMessage = savedUser("before reset", "old", 1);
  let state = project(projection(), oldMessage);
  const currentScope = { ...primaryScope, lifecycleRevision: 2, activeLeafEntryId: "reset-leaf" };
  state = reduce(state, { type: "sessionReset", ...currentScope });
  const resetState = state;
  expect(project(state, oldMessage, undefined, primaryScope)).toBe(resetState);
  state = reduce(state, {
    type: "snapshotLoaded",
    scope: primaryScope,
    messages: [oldMessage],
  });
  expect(state).toBe(resetState);
  expectRows(state);
  const current = savedUser("after reset", "current", 1);
  state = project(state, current, undefined, currentScope);
  expect(state.scope).toEqual(currentScope);
  expectRows(state, current);
});
it("classifies only metadata-free or send-key-only local turns as optimistic", () => {
  const pending = keyedUser("local", "local-run:user");
  const assistant = reply("streaming locally");
  const sequenced = user("durable sequence", { seq: 2 });
  const persisted = savedUser("durable", "persisted-user", 3, {
    idempotencyKey: "local-run:user",
  });
  expect(isOptimistic(pending)).toBe(true);
  expect(isOptimistic(assistant)).toBe(true);
  expect(isOptimistic(sequenced)).toBe(false);
  expect(isOptimistic(persisted)).toBe(false);
  expect(isOptimistic({ role: "system", content: "marker" })).toBe(false);
});
it("filters hidden snapshot, authoritative live, and pending rows in one canonical pass", () => {
  const visible = savedUser("visible", "visible", 1);
  const hiddenSnapshot = savedReply("hidden snapshot", "hidden-snapshot", 2);
  const hiddenLive = savedUser("hidden live", "hidden-live", 3);
  const hiddenPending = keyedUser("hidden pending", "hidden-run:user");
  let state = sendPending(projection(), "hidden-run", hiddenPending);
  state = project(state, hiddenLive);
  state = reduce(state, {
    type: "snapshotLoaded",
    messages: [visible, hiddenSnapshot],
    scope: primaryScope,
    options: {
      shouldIncludeMessage: (message) =>
        message !== hiddenSnapshot && message !== hiddenLive && message !== hiddenPending,
    },
  });
  expectRows(state, visible);
});
it("rekeys provisional pending turns without adopting a same-text peer", () => {
  const pending = keyedUser("same prompt", "provisional-run:user");
  const peer = savedUser("same prompt", "peer-user", 1, {
    idempotencyKey: "peer-run:user",
    runId: "provisional-run",
  });
  let state = project(projection([pending]), peer);
  state = acknowledge(state, "provisional-run", "accepted-run");
  expectRows(state, pending, peer);
  expect(state.entries[0]).toMatchObject({ pending: true, pendingRunId: "accepted-run" });
  const accepted = savedUser("same prompt", "accepted-user", 2, {
    idempotencyKey: "accepted-run:user",
    runId: "queued-execution",
  });
  expectRows(project(state, accepted), peer, accepted);
  const persistedBeforeAck = project(projection([pending]), accepted);
  const adopted = acknowledge(persistedBeforeAck, "provisional-run", "accepted-run");
  expectRows(adopted, accepted);
  expect(acknowledge(adopted, "provisional-run", "accepted-run")).toBe(adopted);
});
it("removes only a failed pending turn while preserving same-text authoritative peers", () => {
  const pending = keyedUser("same prompt", "failed-run:user");
  const assistant = reply("optimistic stream");
  const otherAnswer = reply("independent stream", { idempotencyKey: "other-run" });
  const unkeyedUser = user("intervening unkeyed user");
  const unownedAssistant = reply("unowned stream");
  const peer = savedUser("same prompt", "peer-user", 1, { idempotencyKey: "peer-run:user" });
  const initial = projection([
    pending,
    assistant,
    otherAnswer,
    unkeyedUser,
    unownedAssistant,
    peer,
  ]);
  const failed = reduce(initial, { type: "sendFailed", runId: "failed-run" });
  expectRows(failed, otherAnswer, unkeyedUser, unownedAssistant, peer);
  expect(reduce(failed, { type: "sendFailed", runId: "failed-run" })).toBe(failed);
});
it("places an authoritative prompt ahead of its already projected same-run final", () => {
  const assistant = reply("already delivered", {
    id: "assistant-1",
    idempotencyKey: "shared-run",
  });
  let state = projection([assistant]);
  state = terminal(state, { runId: "shared-run", message: assistant });
  const prompt = user("late peer prompt", { id: "user-1", idempotencyKey: "shared-run:user" });
  expectRows(project(state, prompt), prompt, assistant);
});
const runId = "run-1";
const snapshot = (state: SessionProjectionState, messages: unknown[]) =>
  reconcile(state, messages, state.scope);
const partial = (metadata = {}) => reply("Saved partial reply", metadata);
const receipt = (id: string, seq: number, metadata = {}) => ({
  ...partial({ id, seq, runId, mirrorOrigin: "codex-app-server", idempotencyKey: id, ...metadata }),
  stopReason: "error",
});
const selected = reply("Selected answer");
// #148297: a selected final can inherit the run's toolUse stop reason.
const saved = { ...savedReply("Selected answer", "saved", 217, { runId }), stopReason: "toolUse" };
const tool = (id = "later-tool", seq = 218, stopReason?: string) => ({
  ...savedReply("Checking another file.", id, seq, { runId }),
  content: [
    { type: "text", text: "Checking another file." },
    { type: "toolCall", id: "read-next", name: "read", arguments: {} },
  ],
  ...(stopReason ? { stopReason } : {}),
});
const announce = (message: unknown = selected, state = projection(), cloneLive = false) =>
  project(terminal(state, { message }), cloneLive ? structuredClone(message) : message, { runId });
const text = (...parts: string[]) => parts.map((value) => ({ type: "text", text: value }));
it("recovers an empty terminal only with its matching saved occurrence", () => {
  const empty = { ...partial({ runId, idempotencyKey: "selected" }), content: [] };
  let state = terminal(projection(), { message: empty });
  state = terminal(state, { message: receipt("other", 2) });
  expect(state.runs[runId]?.message).toBe(empty);
  const durable = receipt("selected", 3);
  expect(terminal(state, { message: durable }).runs[runId]?.message).toBe(durable);
});
it.each([
  { status: "error", stopReason: "error" },
  { status: "completed", stopReason: "toolUse" },
] as const)("reconciles $status/$stopReason by receipt", ({ status, stopReason }) => {
  const live = partial({ runId, idempotencyKey: "saved-final" });
  const durable = {
    ...receipt("saved-final", 2),
    stopReason,
    content: [
      { type: "text", text: "Saved transformed text" },
      { type: "image", source: { type: "url", url: "https://example.test/image.png" } },
    ],
  };
  for (const persistedFirst of [false, true]) {
    let state = terminal(persistedFirst ? persist(projection(), durable) : projection(), {
      message: live,
      status,
    });
    state = reduce(state, { type: "messagePersisted", message: live, runId });
    if (!persistedFirst) {
      state = persist(state, durable);
    }
    expectRows(state, durable);
    expectRows(persist(snapshot(state, [structuredClone(durable)]), durable), durable);
  }
});
it("does not merge distinct saved occurrences, commentary, tools, or imported identity", () => {
  const first = receipt("first", 1),
    last = receipt("last", 4);
  const toolRow = {
    ...receipt("tool", 2),
    content: [{ type: "toolCall", id: "read", name: "read", arguments: {} }],
  };
  const commentary = {
    ...last,
    openclawStreamFallback: { source: "segment", itemId: "commentary", runId },
  };
  const collision = receipt("different-durable-id", 5, { idempotencyKey: "last" });
  const imported = receipt("external", 6, {
    idempotencyKey: "last",
    importedFrom: "codex",
    cliSessionId: "cli",
    externalId: "external",
  });
  const history = [first, toolRow, last, commentary, collision, imported];
  const state = persist(projection(history), partial({ runId, idempotencyKey: "first" }));
  expect(state.messages).toEqual(history);
  expect(
    persist(state, partial({ runId, idempotencyKey: "new-occurrence" })).messages,
  ).toHaveLength(history.length + 1);
});
it("keeps a receipt-less fallback provisional through cache and unrelated persistence", () => {
  const fallback = {
    ...partial(),
    openclawStreamFallback: { source: "current", runId, afterSequence: 3 },
  };
  let state = projection(structuredClone([fallback]));
  const priorRun = receipt("prior", 5, { runId: "run-prior", runTerminal: true });
  const beforeFence = receipt("old-occurrence", 2, { runTerminal: true });
  const failedA = receipt("failed-A", 6),
    failedB = receipt("failed-B", 7);
  for (const message of [priorRun, beforeFence, failedA, failedB]) {
    state = persist(state, message);
    expect(state.messages).toContainEqual(fallback);
  }
  state = snapshot(state, [beforeFence, priorRun, failedA, failedB]);
  expect(state.messages).toContainEqual(fallback);
  const savedTerminal = receipt("selected-terminal", 8, { runTerminal: true });
  expectRows(persist(state, savedTerminal), beforeFence, priorRun, failedA, failedB, savedTerminal);
});
it("keeps durable replay idempotent despite contradictory same-run history", () => {
  const later = tool("later-tool", 218, "toolUse");
  let state = projection([saved, later]);
  for (let replay = 0; replay < 2; replay += 1) {
    state = persist(state, structuredClone(saved));
    expect(state.messages).toEqual([saved, later]);
  }
});
it.each(["history-first", "live-first", "persisted"])(
  "keeps contradictory history (%s)",
  (order) => {
    const later = tool("later-tool", 218, "toolUse");
    let state = announce(
      selected,
      order === "history-first" ? snapshot(projection(), [saved, later]) : projection(),
    );
    if (order === "persisted") {
      state = persist(persist(state, later), saved);
    } else if (order === "live-first") {
      state = snapshot(state, [saved, later]);
    }
    expect(state.messages).toHaveLength(3);
    for (const message of [selected, saved, later]) {
      expect(state.messages).toContain(message);
    }
  },
);
it.each(["history-first", "durable-second", "snapshot-second"])(
  "restores a %s inferred final across repeated contradictory snapshots",
  (order) => {
    let state = announce(
      selected,
      order === "history-first" ? snapshot(projection(), [saved]) : projection(),
    );
    if (order === "durable-second") {
      state = persist(state, saved);
    } else if (order === "snapshot-second") {
      state = snapshot(state, [saved]);
    }
    expect(state.messages).toEqual([saved]);
    state = snapshot(state, [saved]);
    expect(state.messages).toEqual([saved]);
    const later = tool("later-tool", 218, "toolUse");
    for (let refresh = 0; refresh < 2; refresh += 1) {
      state = snapshot(state, [saved, later]);
      expect(state.messages).toEqual([saved, later, selected]);
    }
  },
);
it.each(["durable-first", "live-first"])(
  "keeps different-content toolUse and live answers separate (%s)",
  (order) => {
    const different = reply("A different final answer");
    if (order === "durable-first") {
      expectRows(announce(different, snapshot(projection(), [saved])), saved, different);
    } else {
      const differentSaved = { ...saved, content: different.content };
      const state = project(project(projection(), selected, { runId }), differentSaved, {
        runId,
      });
      expect(state.messages).toHaveLength(2);
      expect(state.messages).toContain(selected);
      expect(state.messages).toContain(differentSaved);
    }
  },
);
it("adopts a durable answer when its live terminal also carries a status notice", () => {
  const prompt = savedUser("Check the workspace.", "fallback-user", 1, {
    idempotencyKey: `${runId}:user`,
  });
  const streamed = {
    ...selected,
    openclawStreamFallback: {
      itemId: "fallback-answer-item",
      replacementText: "Selected answer",
      runId,
      source: "segment",
    },
  };
  const final = {
    role: "assistant",
    content: [
      { type: "text", text: "Model Fallback: backup/model", openclawStatusNotice: true },
      ...selected.content,
    ],
  };
  const durable = savedReply("Selected answer", "fallback-answer", 2, {
    runId,
    runTerminal: true,
  });
  const state = announce(final, projection([prompt, streamed]));
  expect(state.messages).toEqual([prompt, streamed, final]);
  expect(
    reduce(state, { type: "messagePersisted", message: durable, envelope: { runId } }).messages,
  ).toEqual([prompt, streamed, durable]);
});
it("promotes an unmarked same-run CLI terminal with a terminal stop reason", () => {
  const persisted = {
    ...savedReply("Selected answer", "assistant-final", 4),
    api: "cli",
    idempotencyKey: `cli-assistant:${runId}`,
    stopReason: "stop",
  };
  expectRows(snapshot(announce(selected, projection(), true), [persisted]), persisted);
});
it("restores an inferred terminal when later history reveals a tool boundary", () => {
  const prompt = savedUser("Inspect the repository.", "user-prompt", 1, {
    idempotencyKey: `${runId}:user`,
  });
  const earlier = savedReply("Selected answer", "assistant-earlier", 2, { runId });
  const later = tool("assistant-tool-boundary", 3);
  const state = snapshot(announce(), [prompt, earlier]);
  expect(state.messages).toEqual([prompt, earlier]);
  expectRows(snapshot(state, [prompt, earlier, later]), prompt, earlier, later, selected);
});
it("does not restore a removed or filtered inferred terminal", () => {
  const prompt = savedUser("Finish the task.", "user", 1, { runId });
  const persisted = savedReply("Selected answer", "final", 2, { runId });
  const state = snapshot(announce(), [prompt, persisted]);
  expect(state.messages).toEqual([prompt, persisted]);
  const removed = snapshot(state, [prompt]);
  const filtered = reconcile(state, [prompt, persisted], state.scope, {
    shouldIncludeMessage: (message) => message === prompt,
  });
  for (const retired of [removed, filtered]) {
    expect(retired.messages).toEqual([prompt]);
    expect(snapshot(retired, [prompt]).messages).toEqual([prompt]);
  }
});
it("retains an unsequenced terminal when multiple same-run rows have terminal content", () => {
  const first = savedReply("Selected answer", "assistant-first", 2, { runId });
  const second = savedReply("Selected answer", "assistant-second", 3, { runId });
  expect(snapshot(announce(), [first, second]).messages).toEqual([first, second, selected]);
});
/** Run-scoped terminal state: final acceptance, late diagnostics, and retention. */
it.each([
  ["input text error", [{ type: "input_text", text: "provider rate limit" }], true],
  ["thinking only", [{ type: "thinking", thinking: "Internal reasoning" }], true],
  ["empty turn marker", text("[assistant turn failed before producing content]"), true],
  ["split provider error", text("⚠️ Error: provider", "rate limit"), true],
  [
    "split empty turn error",
    text("⚠️ Error: The agent run failed", "before producing a reply."),
    true,
  ],
  ["useful text", text("Useful partial reply."), false],
  ["image", [{ type: "image", source: "synthetic-image" }], false],
] as const)("resumes only diagnostic-only failed content: %s", (_name, content, resumes) => {
  const failed = terminal(projection(), {
    status: "error",
    seq: 10,
    errorMessage: "provider rate limit",
    message: { role: "assistant", content, stopReason: "error" },
  });
  const next = delta(failed, "run-1", reply(resumes ? "I" : "late stream"), 11);
  if (resumes) {
    expect(next.runs["run-1"]).toMatchObject({ status: "streaming" });
    expect(next.runs["run-1"]?.errorMessage).toBeUndefined();
    expect(next.runs["run-1"]?.stopReason).toBeUndefined();
  } else {
    expect(next).toBe(failed);
  }
});
it("upgrades an identified empty completed final exactly once without reopening the run", () => {
  const emptyMessage = savedReply("", "assistant-final", 7);
  const deliveredMessage = savedReply("eventual final", "assistant-final", 7);
  let state = terminal(projection(), { message: emptyMessage });
  expect(acceptedFinal(state.runs[runId], emptyMessage)).toBe(false);
  const mismatchedMessage = savedReply("wrong final", "different-assistant-final", 7);
  state = terminal(state, { message: mismatchedMessage });
  expect(state.runs["run-1"]?.message).toBe(emptyMessage);
  state = terminal(state, { message: deliveredMessage });
  expect(state.runs["run-1"]).toMatchObject({ status: "completed", message: deliveredMessage });
  const laterFinal = reply("later distinct final");
  const acceptedLaterFinal = terminal(state, { message: laterFinal });
  expect(acceptedLaterFinal.runs["run-1"]?.message).toBe(deliveredMessage);
  expect(acceptedFinal(acceptedLaterFinal.runs[runId], laterFinal)).toBe(true);
  expect(terminal(acceptedLaterFinal, { message: laterFinal })).toBe(acceptedLaterFinal);
});
it("recovers a sequence-identified empty final when persisted metadata adds an ID", () => {
  const emptyMessage = reply("", { seq: 7 });
  const deliveredMessage = savedReply("eventual final", "assistant-final", 7);
  let state = terminal(projection(), { message: emptyMessage });
  state = terminal(state, { message: deliveredMessage });
  expect(state.runs["run-1"]?.message).toBe(deliveredMessage);
});
it("remembers distinct recovered finals after an initial message-less error", () => {
  const first = savedReply("first recovered final", "recovered-a", 7);
  const second = savedReply("second recovered final", "recovered-b", 8);
  let state = terminal(projection(), {
    status: "error",
    errorKind: "provider_error",
    errorMessage: "original diagnostic",
  });
  state = terminal(state, { message: first });
  state = terminal(state, { message: second });
  expect(state.runs["run-1"]).toMatchObject({
    status: "error",
    message: first,
    errorMessage: "original diagnostic",
  });
  expect(acceptedFinal(state.runs[runId], second)).toBe(true);
  expect(terminal(state, { message: second })).toBe(state);
});
it("ignores whitespace diagnostics and accepts one meaningful late provider error", () => {
  const emptyError = terminal(projection(), {
    runId: "empty-error",
    status: "error",
    errorMessage: " \n\t ",
  });
  expect(emptyError.runs["empty-error"]?.errorMessage).toBeUndefined();
  const delivered = savedReply("delivered final", "delivered-assistant", 7);
  let state = terminal(projection(), { message: delivered });
  const completed = state;
  state = terminal(state, {
    status: "error",
    errorKind: "provider_error",
    errorMessage: "  \n\t ",
  });
  expect(state).toBe(completed);
  const actionableError = {
    status: "error",
    errorKind: "provider_error",
    errorMessage: "  provider rejected request  ",
  } as const;
  state = terminal(state, actionableError);
  expect(state.runs["run-1"]).toMatchObject({
    status: "completed",
    message: delivered,
    errorKind: "provider_error",
    errorMessage: "provider rejected request",
  });
  expect(terminal(state, actionableError)).toBe(state);
});
it("retains a newly completed live stream ahead of older terminal diagnostics", () => {
  let state = delta(projection(), "active-first", reply("stream"));
  for (let index = 0; index < 199; index += 1) {
    state = terminal(state, { runId: `older-${index}` });
  }
  state = terminal(state, { runId: "active-first" });
  state = terminal(state, { runId: "newest" });
  expect(Object.keys(state.runs)).toHaveLength(150);
  expect(state.runs["older-0"]).toBeUndefined();
  expect(state.runs["active-first"]?.status).toBe("completed");
  expect(state.runs.newest?.status).toBe("completed");
});
it("protects every concurrent active stream when terminal retention reaches its soft cap", () => {
  let state = projection();
  for (let index = 0; index < 205; index += 1) {
    state = delta(state, `active-${index}`);
  }
  expect(Object.keys(state.runs)).toHaveLength(205);
  expect(state.runs["active-0"]?.status).toBe("streaming");
  expect(state.runs["active-204"]?.status).toBe("streaming");
});
