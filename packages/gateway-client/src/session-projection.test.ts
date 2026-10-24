import { describe, expect, it } from "vitest";
import { readSessionMessageIdentity as readBrowserSessionMessageIdentity } from "./browser.js";
import { readSessionMessageIdentity as readNodeSessionMessageIdentity } from "./index.js";
import {
  isLocallyOptimisticSessionMessage,
  normalizeSessionProjectionRunId,
  projectLiveSessionMessage as project,
  readSessionMessageIdentity,
  readSessionMessageSequence,
  reconcileSessionProjectionSnapshot as reconcile,
  reduceSessionProjection as reduce,
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
} from "./session-projection.test-support.js";

describe("readSessionMessageIdentity", () => {
  it("reads the same canonical contract from both supported package barrels", () => {
    const message = savedUser("hello", "persisted", 7);
    expect(readBrowserSessionMessageIdentity(message)).toEqual(readSessionMessageIdentity(message));
    expect(readNodeSessionMessageIdentity(message)).toEqual(readSessionMessageIdentity(message));
  });

  it("normalizes an empty user-suffixed run ID", () => {
    expect(normalizeSessionProjectionRunId(":user")).toBe(null);
  });

  it("keeps assistant dedupe identity separate from producer-owned run identity", () => {
    expect(
      readSessionMessageIdentity({
        role: "assistant",
        content: "Commentary",
        idempotencyKey: "codex-app-server:thread-1:turn-1:commentary:item-1",
        __openclaw: { mirrorOrigin: "codex-app-server", runId: "run-1" },
      }),
    ).toMatchObject({
      idempotencyKey: "codex-app-server:thread-1:turn-1:commentary:item-1",
      runId: "run-1",
    });
    expect(
      readSessionMessageIdentity({
        role: "assistant",
        content: "Imported history",
        idempotencyKey: "codex-app-server:thread-1:history:turn-1:assistant",
        __openclaw: { mirrorOrigin: "codex-app-server" },
      }),
    ).toHaveProperty("runId", null);
  });
});

describe("readSessionMessageSequence", () => {
  it("preserves the durable sequence of role-less history and status markers", () => {
    expect(readSessionMessageSequence({ __openclaw: { seq: 7 } })).toBe(7);
  });
});

describe("session transcript projection", () => {
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
    const local = {
      ...reply("Repeated progress.", { id: undefined, seq: undefined, importedFrom: undefined }),
      openclawStreamFallback: { itemId: "item-1", runId: undefined, source: "segment" },
    };
    const durable = {
      ...savedReply("Repeated progress.", "persisted", 3, {
        runId: "run-1",
        mirrorOrigin: "codex-app-server",
      }),
      openclawStreamFallback: { itemId: "item-1", source: "segment" },
    };
    const final = savedReply("Finished.", "final", 4, { runId: "run-1" });
    let state = projection([local, final]);

    state = project(state, durable);

    expect(state.messages).toEqual([local, durable, final]);
    state = reduce(state, { type: "transportGap" });
    state = reduce(state, { type: "reconnected" });
    state = project(state, durable);
    expect(state.messages).toEqual([local, durable, final]);
  });

  it("keeps authoritative commentary when its provisional item replays with different text", () => {
    const durable = {
      ...savedReply("Authoritative progress.", "persisted", 3, { runId: "run-1" }),
      openclawStreamFallback: { itemId: "item-1", source: "segment" },
    };
    const local = {
      ...reply("Partial progress."),
      openclawStreamFallback: { itemId: "item-1", runId: "run-1", source: "segment" },
    };
    const state = project(projection(), durable);

    expect(project(state, local).messages).toEqual([durable]);
    expect(reconcile(state, [durable], primaryScope).messages).toEqual([durable]);
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
    expect(state.messages).toEqual([prefix, steer, tail]);

    state = project(state, savedTail);
    expect(state.messages).toEqual([prefix, steer, savedTail]);
  });

  it("does not adopt an ambiguous synthetic final across distinct same-run assistants", () => {
    const synthetic = reply("delta-only final", { idempotencyKey: "final-run" });
    const first = savedReply("first final", "assistant-first", 7, { idempotencyKey: "final-run" });
    const second = savedReply("second final", "assistant-second", 8, {
      idempotencyKey: "final-run",
    });
    const state = project(projection(), synthetic);

    expect(reconcile(state, [first, second], primaryScope).messages).toEqual([
      first,
      second,
      synthetic,
    ]);
    expect(project(projection([first, second]), synthetic).messages).toEqual([
      first,
      second,
      synthetic,
    ]);
    const ambiguous = reconcile(state, [first, second], primaryScope);
    expect(project(ambiguous, structuredClone(first)).messages).toEqual([first, second, synthetic]);
  });

  it("promotes a native sequence-only live row to its durable snapshot identity", () => {
    const live = user("live projection", { seq: 7 });
    const persisted = savedUser("persisted projection", "canonical-user-7", 7);
    const state = project(projection(), live);

    expect(reconcile(state, [persisted], primaryScope).messages).toEqual([persisted]);
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
    expect(state.messages).toEqual([native, imported, otherSession, partial]);
    expect(state.entries.map((entry) => entry.identity?.externalSource)).toEqual([
      null,
      JSON.stringify(["claude-cli", "cli-session", "provider-local"]),
      JSON.stringify(["claude-cli", "other", "provider-local"]),
      null,
    ]);
  });

  it("adopts snapshot projections of partial imports by canonical session sequence", () => {
    const live = savedUser("live imported projection", "provider-local", 7, {
      importedFrom: "claude-cli",
    });
    const snapshot = savedUser("snapshot imported projection", "provider-local", 7, {
      importedFrom: "claude-cli",
    });
    const state = project(projection(), live);

    expect(reconcile(state, [snapshot], primaryScope).messages).toEqual([snapshot]);
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

    expect(state.messages).toEqual([partial, complete]);
  });

  it("explicitly promotes only the admitted sequenced handoff", () => {
    const peer = user("continue", { idempotencyKey: "initial-run:user", seq: 1 });
    const handoff = user("continue", { idempotencyKey: "initial-run:user", seq: 2 });
    const followingAssistant = reply("already working", { seq: 3 });
    let state = projection([peer, handoff, followingAssistant]);

    state = sendPending(state, "initial-run", handoff);

    expect(state.entries).toMatchObject([
      { message: peer, pending: false },
      { message: handoff, pending: true, pendingRunId: "initial-run" },
      { message: followingAssistant, pending: false },
    ]);
    expect(reduce(state, { type: "sendFailed", runId: "initial-run" }).messages).toEqual([
      peer,
      followingAssistant,
    ]);

    const wrongSequence = savedUser("continue", "wrong-sequence-user", 4, {
      idempotencyKey: "initial-run:user",
    });
    state = persist(state, wrongSequence);
    expect(state.messages).toEqual([peer, handoff, followingAssistant, wrongSequence]);
    expect(state.entries[1]).toMatchObject({ pending: true, pendingRunId: "initial-run" });

    const authoritative = savedUser("continue", "initial-user", 2, {
      idempotencyKey: "initial-run:user",
    });
    state = persist(state, authoritative);

    expect(state.messages).toEqual([peer, authoritative, followingAssistant, wrongSequence]);
    expect(state.entries[1]).toMatchObject({
      identity: { id: "initial-user" },
      pending: false,
    });
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

    expect(reconciled.messages).toEqual([persisted, response]);
    expect(reconciled.entries[0]?.identity?.runId).toBe("queued-execution");
    expect(sendPending(reconciled, "queued-send", pending).messages).toEqual([persisted, response]);
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
    expect(state.scope.lifecycleRevision).toBe(2);
    expect(state.messages).toEqual([]);
    const current = savedUser("after reset", "current", 1);
    state = project(state, current, undefined, currentScope);
    expect(state.scope).toEqual(currentScope);
    expect(state.messages).toEqual([current]);
  });

  it("classifies only metadata-free or send-key-only local turns as optimistic", () => {
    const pending = keyedUser("local", "local-run:user");
    const assistant = reply("streaming locally");
    const sequenced = user("durable sequence", { seq: 2 });
    const persisted = savedUser("durable", "persisted-user", 3, {
      idempotencyKey: "local-run:user",
    });

    expect(isLocallyOptimisticSessionMessage(pending)).toBe(true);
    expect(isLocallyOptimisticSessionMessage(assistant)).toBe(true);
    expect(isLocallyOptimisticSessionMessage(sequenced)).toBe(false);
    expect(isLocallyOptimisticSessionMessage(persisted)).toBe(false);
    expect(isLocallyOptimisticSessionMessage({ role: "system", content: "marker" })).toBe(false);
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

    expect(state.messages).toEqual([visible]);
  });

  it("rekeys provisional pending turns without adopting a same-text peer", () => {
    const pending = keyedUser("same prompt", "provisional-run:user");
    const peer = savedUser("same prompt", "peer-user", 1, {
      idempotencyKey: "peer-run:user",
      runId: "provisional-run",
    });
    let state = project(projection([pending]), peer);
    state = acknowledge(state, "provisional-run", "accepted-run");

    expect(state.messages).toEqual([pending, peer]);
    expect(state.entries[0]).toMatchObject({ pending: true, pendingRunId: "accepted-run" });
    const accepted = savedUser("same prompt", "accepted-user", 2, {
      idempotencyKey: "accepted-run:user",
      runId: "queued-execution",
    });
    expect(project(state, accepted).messages).toEqual([peer, accepted]);

    const persistedBeforeAck = project(projection([pending]), accepted);
    const adopted = acknowledge(persistedBeforeAck, "provisional-run", "accepted-run");
    expect(adopted.messages).toEqual([accepted]);
    expect(acknowledge(adopted, "provisional-run", "accepted-run")).toBe(adopted);
  });

  it("removes only a failed pending turn while preserving same-text authoritative peers", () => {
    const pending = keyedUser("same prompt", "failed-run:user");
    const assistant = reply("optimistic stream");
    const independentAssistant = reply("independent stream", { idempotencyKey: "other-run" });
    const unkeyedUser = user("intervening unkeyed user");
    const unownedAssistant = reply("unowned stream");
    const peer = savedUser("same prompt", "peer-user", 1, { idempotencyKey: "peer-run:user" });
    const initial = projection([
      pending,
      assistant,
      independentAssistant,
      unkeyedUser,
      unownedAssistant,
      peer,
    ]);
    expect(initial.entries.map((entry) => entry.pendingRunId)).toEqual([
      "failed-run",
      "failed-run",
      "other-run",
      null,
      null,
      null,
    ]);
    const failed = reduce(initial, { type: "sendFailed", runId: "failed-run" });

    expect(failed.messages).toEqual([independentAssistant, unkeyedUser, unownedAssistant, peer]);
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

    expect(project(state, prompt).messages).toEqual([prompt, assistant]);
  });
});
