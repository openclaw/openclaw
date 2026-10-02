import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  replaceTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { buildSessionContext, SessionManager } from "./session-manager.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
  }),
);

function assistant(text: string, timestamp = 2) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses" as const,
    provider: "openai",
    model: "gpt-5.5",
    usage: createZeroUsageFixture(),
    stopReason: "stop" as const,
    timestamp,
  };
}

function nestedTool(timestamp: number) {
  return createNestedToolActivity({
    runId: "prepared-run",
    scopeId: "prepared-scope",
    afterEntryId: null,
    startOrder: 0,
    toolCallId: "prepared-message",
    toolName: "message",
    input: { action: "send", message: "Delivered reply" },
    result: { content: [{ type: "text", text: "Sent" }] },
    isError: false,
    startedAt: timestamp,
    timestamp,
  });
}

async function setup(content = "base") {
  const dir = tempDirs.make("openclaw-session-manager-");
  const target = {
    agentId: "main",
    sessionId: "rebase",
    sessionKey: "agent:main:rebase",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  const persist = (eventId: string, message: unknown, now = 2, parentId?: string | null) =>
    appendTranscriptMessage(target, { eventId, message, now, parentId });
  await persist("base", makeUserMessage(content, 1), 1);
  return {
    dir,
    target,
    persist,
    manager: SessionManager.open(target, dir),
    events: () => loadTranscriptEvents(target),
  };
}

describe("SessionManager stale-parent rebase", () => {
  it("rebases a stale active append and replays its canonical parent", async () => {
    const { target, manager, persist, events } = await setup();
    const { role, content, timestamp } = assistant("late");
    await persist("out-of-band", { role, content, timestamp });
    const message = makeUserMessage("next", 3);
    const id = manager.appendMessage(message);
    expect(await events()).toMatchObject([
      { type: "session" },
      { id: "base", parentId: null },
      { id: "out-of-band", parentId: "base" },
      { id, parentId: "out-of-band" },
    ]);
    expect(manager.getEntry(id)?.parentId).toBe("out-of-band");
    expect(manager.getBranch().map((entry) => entry.id)).toEqual(["base", "out-of-band", id]);
    expect(
      await appendTranscriptMessage(target, {
        appendIntent: "active-branch",
        eventId: id,
        message,
        parentId: "base",
      }),
    ).toMatchObject({ appended: false, effectiveParentId: "out-of-band", messageId: id });
  });

  it("reloads a stale control append after an unchanged-parent prefix rewrite", async () => {
    const { target, manager, events } = await setup("old");
    const records = await events();
    expect(
      replaceTranscriptEventsSync(target, [
        records[0],
        {
          type: "message",
          id: "base",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: makeUserMessage("rewritten", 2),
        },
      ]),
    ).toBe(true);
    const id = await manager.appendModelChange("openai", "gpt-5.6");
    expect(manager.getBranch().map((entry) => entry.id)).toEqual(["base", id]);
    expect(manager.getEntry("base")).toMatchObject({
      type: "message",
      message: { role: "user", content: "rewritten" },
    });
  });

  it("continues a prepared assistant across a visible context-free command pair without replaying it", async () => {
    const { dir, target, manager, persist, events } = await setup();
    const metadata = { excludeFromContext: true, __openclaw: { contextFreeCommand: true } };
    await persist("status-user", { ...makeUserMessage("/status", 2), ...metadata });
    await persist("status-assistant", { ...assistant("Worker is running", 3), ...metadata }, 3);
    const continuation = assistant("stale reply", 4);
    const id = manager.appendMessage(continuation);
    expect(await events()).toMatchObject([
      { type: "session" },
      { id: "base", message: { role: "user", content: "base" } },
      { id: "status-user", parentId: "base", message: { role: "user", content: "/status" } },
      {
        id: "status-assistant",
        parentId: "status-user",
        message: { role: "assistant", content: [{ type: "text", text: "Worker is running" }] },
      },
      { id, parentId: "status-assistant", message: continuation },
    ]);
    expect(manager.buildSessionContext().messages).toEqual([
      makeUserMessage("base", 1),
      continuation,
    ]);
    expect(SessionManager.open(target, dir).buildSessionContext()).toEqual(
      manager.buildSessionContext(),
    );
  });

  it.each([
    { name: "excluded-only", kind: "assistant", metadata: { excludeFromContext: true } },
    {
      name: "marked-only",
      kind: "assistant",
      metadata: { __openclaw: { contextFreeCommand: true } },
    },
    {
      name: "nonboolean-marker",
      kind: "nested-tool",
      metadata: { excludeFromContext: true, __openclaw: { contextFreeCommand: "true" } },
    },
  ])(
    "rejects a stale prepared $kind after a newer user turn ($name)",
    async ({ kind, metadata }) => {
      const { manager, persist, events } = await setup();
      await persist("new-user", { ...makeUserMessage("/status", 2), ...metadata });
      const beforeBranch = manager.getBranch();
      const beforeEvents = await events();
      expect(() =>
        manager.appendMessage(kind === "assistant" ? assistant("stale reply", 3) : nestedTool(3)),
      ).toThrow("SQLite transcript changed while preparing rewrite");
      expect(manager.getBranch()).toEqual(beforeBranch);
      expect(await events()).toEqual(beforeEvents);
    },
  );

  it("rejects a stale custom message after a same-turn assistant append", async () => {
    const { manager, persist, events } = await setup();
    await persist("delivered-reply", assistant("stale reply"));
    const beforeBranch = manager.getBranch();
    const beforeEvents = await events();
    expect(() =>
      manager.appendMessage({
        role: "custom",
        customType: "extension-input",
        content: "Additional instructions",
        display: true,
        timestamp: 3,
      }),
    ).toThrow("SQLite transcript changed while preparing rewrite");
    expect(manager.getBranch()).toEqual(beforeBranch);
    expect(await events()).toEqual(beforeEvents);
  });

  it("fences a prepared assistant retry to the snapshot that passed validation", async () => {
    const { target, manager, persist, events } = await setup();
    await persist("intermediate-assistant", assistant("late"));
    const beforeBranch = manager.getBranch().map((entry) => entry.id);
    const { db } = openOpenClawAgentDatabase({
      agentId: target.agentId,
      path: resolveSessionTranscriptDatabasePath(target),
    });
    const exec = db.exec.bind(db);
    let injected = false;
    const spy = vi.spyOn(db, "exec").mockImplementation((statement) => {
      if (statement === "BEGIN IMMEDIATE" && !injected) {
        injected = true;
        expect(
          appendTranscriptMessageSync(target, {
            appendIntent: "active-branch",
            eventId: "new-user",
            message: makeUserMessage("new", 3),
            now: 3,
          }).ok,
        ).toBe(true);
      }
      return exec(statement);
    });
    try {
      expect(() => manager.appendMessage(assistant("stale reply", 4))).toThrow(
        "SQLite transcript changed while preparing rewrite",
      );
    } finally {
      spy.mockRestore();
    }
    expect(manager.getBranch().map((entry) => entry.id)).toEqual(beforeBranch);
    expect(await events()).toMatchObject([
      { type: "session" },
      { id: "base" },
      { id: "intermediate-assistant" },
      { id: "new-user" },
    ]);
  });

  it("rejects a prepared nested tool after a newer user outside the restored active ancestry", async () => {
    const { dir, target, manager: source, events } = await setup();
    const parentId = source.appendMessage(assistant("ready"));
    const stale = SessionManager.open(target, dir);
    source.branch("base");
    source.appendMessage(makeUserMessage("side user", 3));
    source.branch(parentId);
    const beforeBranch = stale.getBranch();
    const beforeEvents = await events();
    expect(() => stale.appendMessage(nestedTool(4))).toThrow(
      "SQLite transcript changed while preparing rewrite",
    );
    expect(stale.getBranch()).toEqual(beforeBranch);
    expect(await events()).toEqual(beforeEvents);
  });

  it("preserves a stale manager branch when the concurrent tail is unrelated", async () => {
    const { dir, target, persist, events } = await setup("first");
    await persist("first-tail", assistant("first"));
    const manager = SessionManager.open(target, dir);
    await persist("second-root", makeUserMessage("second", 3), 3, null);
    const id = manager.appendMessage(makeUserMessage("branch", 4));
    expect(manager.getEntry(id)?.parentId).toBe("first-tail");
    expect(manager.getBranch().map((entry) => entry.id)).toEqual(["base", "first-tail", id]);
    expect(buildSessionContext(manager.getEntries(), "first-tail").messages).toMatchObject([
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "first" }] },
    ]);
    expect(await events()).toContainEqual(expect.objectContaining({ id, parentId: "first-tail" }));
  });

  it("retries a stale side append against its unchanged explicit parent", async () => {
    const { dir, target, manager, persist, events } = await setup();
    manager.appendLeafControl({ targetId: "base", appendParentId: "base", appendMode: "side" });
    const reopened = SessionManager.open(target, dir);
    expect(reopened.getLeafId()).toBe("base");
    expect(reopened.getAppendParentId()).toBe("base");
    expect(reopened.getAppendMode()).toBe("side");
    await persist("concurrent-tail", assistant("concurrent"), 2, "base");
    const id = manager.appendMessage(makeUserMessage("side", 3));
    expect(await events()).toContainEqual(expect.objectContaining({ id, parentId: "base" }));
    expect(manager.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "concurrent-tail" }),
        expect.objectContaining({ id }),
      ]),
    );
    expect(() => manager.prepareTranscriptRewrite()).not.toThrow();
  });

  it("retries a stale deliberate branch against an unchanged explicit parent", async () => {
    const { manager, persist, events } = await setup();
    manager.branch("base");
    await persist("concurrent-tail", assistant("concurrent"), 2, "base");
    const id = manager.appendMessage(makeUserMessage("branch", 3));
    expect(await events()).toContainEqual(expect.objectContaining({ id, parentId: "base" }));
    expect(manager.getChildren("base").map((entry) => entry.id)).toEqual(["concurrent-tail", id]);
  });
});
