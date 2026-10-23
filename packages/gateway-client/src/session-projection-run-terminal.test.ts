import { describe, expect, it } from "vitest";
import {
  hasSessionProjectionAcceptedFinal,
  projectLiveSessionMessage as project,
  reconcileSessionProjectionSnapshot as reconcile,
  reduceSessionProjection as reduce,
  type SessionProjectionState,
} from "./session-projection.js";
import {
  assistant as reply,
  projection,
  terminal,
  savedReply,
  delta,
  persist,
  savedUser,
} from "./session-projection.test-support.js";

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
const expectMessages = (state: SessionProjectionState, messages: unknown[]) =>
  expect(state.messages).toEqual(messages);
const text = (...parts: string[]) => parts.map((value) => ({ type: "text", text: value }));

describe("terminal receipts and snapshot reconciliation", () => {
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
      expectMessages(state, [durable]);
      expectMessages(persist(snapshot(state, [structuredClone(durable)]), durable), [durable]);
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
    expect(state.entries[0]).toMatchObject({
      live: true,
      pending: false,
      afterSequence: 3,
      identity: { runId },
    });
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
    expectMessages(persist(state, savedTerminal), [
      beforeFence,
      priorRun,
      failedA,
      failedB,
      savedTerminal,
    ]);
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
      expect(state.runs[runId]?.inferredSnapshotTerminal?.entry.message).toBe(selected);
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
        expectMessages(announce(different, snapshot(projection(), [saved])), [saved, different]);
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
    expectMessages(snapshot(announce(selected, projection(), true), [persisted]), [persisted]);
  });

  it("restores an inferred terminal when later history reveals a tool boundary", () => {
    const prompt = savedUser("Inspect the repository.", "user-prompt", 1, {
      idempotencyKey: `${runId}:user`,
    });
    const earlier = savedReply("Selected answer", "assistant-earlier", 2, { runId });
    const later = tool("assistant-tool-boundary", 3);
    const state = snapshot(announce(), [prompt, earlier]);
    expect(state.messages).toEqual([prompt, earlier]);
    expectMessages(snapshot(state, [prompt, earlier, later]), [prompt, earlier, later, selected]);
  });

  it("does not restore a removed or filtered inferred terminal", () => {
    const prompt = {
      role: "user",
      content: "Finish the task.",
      __openclaw: { id: "user", seq: 1, runId },
    };
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
});
/** Run-scoped terminal state: final acceptance, late diagnostics, and retention. */
describe("session run terminal bookkeeping", () => {
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
    [
      "image",
      [
        { type: "thinking", thinking: "Internal reasoning" },
        { type: "image", source: "synthetic-image" },
      ],
      false,
    ],
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
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], emptyMessage)).toBe(false);
    const mismatchedMessage = savedReply("wrong final", "different-assistant-final", 7);
    state = terminal(state, { message: mismatchedMessage });
    expect(state.runs["run-1"]?.message).toBe(emptyMessage);
    state = terminal(state, { message: deliveredMessage });

    expect(state.runs["run-1"]).toMatchObject({ status: "completed", message: deliveredMessage });
    const laterFinal = reply("later distinct final");
    const acceptedLaterFinal = terminal(state, { message: laterFinal });
    expect(acceptedLaterFinal.runs["run-1"]?.message).toBe(deliveredMessage);
    expect(hasSessionProjectionAcceptedFinal(acceptedLaterFinal.runs["run-1"], laterFinal)).toBe(
      true,
    );
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
    expect(state.runs["run-1"]?.acceptedFinalMessageIdentities).toHaveLength(2);
    expect(hasSessionProjectionAcceptedFinal(state.runs["run-1"], second)).toBe(true);
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
});
