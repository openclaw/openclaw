import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  readSessionTranscriptVisibleMessageDeltaCore,
  readSessionTranscriptWatermark,
  readTranscriptRawDelta,
  SessionTranscriptProjectionUnavailableError,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSessionTranscriptDatabasePath } from "../../config/sessions/session-accessor.transcript-target.js";
import {
  SYNC_REBUILD_MAX_BYTES,
  SYNC_REBUILD_MAX_ROWS,
} from "../../config/sessions/session-transcript-index.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { SessionManager } from "./session-manager.js";

const { uuidQueue } = vi.hoisted(() => ({ uuidQueue: [] as string[] }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () =>
      (uuidQueue.shift() ??
        actual.randomUUID()) as `${string}-${string}-${string}-${string}-${string}`,
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
      closeOpenClawAgentDatabasesForTest(dir);
    }
    cleanup();
  }),
);

async function createSessionScope(sessionId: string, filename = "sessions.json") {
  const dir = tempDirs.make("openclaw-session-manager-");
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(dir, filename),
  };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  return { dir, scope };
}

function buildAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "messages" as const,
    provider: "anthropic" as const,
    model: "sonnet-4.6" as const,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

afterEach(() => {
  uuidQueue.length = 0;
});

it("keeps generated entry ids unique outside a bounded transcript tail", async () => {
  const { dir, scope } = await createSessionScope("bounded-id-session");
  await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "deadbeef",
    message: { role: "user", content: "omitted" },
  });
  await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "tail",
    parentId: "deadbeef",
    message: { role: "user", content: "retained" },
  });

  const manager = await SessionManager.openBoundedAsync(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 1,
  });
  expect(manager.getEntry("deadbeef")).toBeUndefined();

  const messageId = "deadbeef-0000-4000-8000-000000000000";
  const thinkingId = "deadbeef-0000-4000-8000-000000000001";
  uuidQueue.push(messageId);
  const appended = await manager.appendMessageWithTranscriptAnchorAsync(
    makeUserMessage("persisted", 2),
  );

  expect(appended).toMatchObject({ entryId: messageId, anchor: { effectiveParentId: "tail" } });
  uuidQueue.push(thinkingId);
  expect(await manager.appendThinkingLevelChange("high")).toBe(thinkingId);
  await expect(loadTranscriptEvents(scope)).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: messageId, parentId: "tail" }),
      expect.objectContaining({ id: thinkingId, parentId: messageId }),
    ]),
  );
});

it("retries a stale bounded append without parsing transcript rows outside the bounded context", async () => {
  const { dir, scope } = await createSessionScope("bounded-stale-append");
  await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "excluded",
    message: { role: "user", content: "excluded" },
  });
  await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "retained",
    parentId: "excluded",
    message: { role: "user", content: "retained" },
  });
  const manager = await SessionManager.openBoundedAsync(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 1,
  });
  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  database.db
    .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 1")
    .run("{excluded-row-is-not-json", scope.sessionId);
  await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "out-of-band",
    parentId: "retained",
    message: { role: "assistant", content: "late" },
  });

  const appendedId = await manager.appendModelChange("openai", "gpt-5.6");

  expect(
    database.db
      .prepare(
        "SELECT parent_id FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
      )
      .get(scope.sessionId, appendedId),
  ).toEqual({ parent_id: "out-of-band" });
  expect(
    database.db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 1")
      .get(scope.sessionId),
  ).toEqual({ event_json: "{excluded-row-is-not-json" });
});

it("accepts a prepared assistant whose parent is the admitted user", async () => {
  const dir = tempDirs.make("openclaw-session-manager-admitted-assistant-");
  const scope = {
    agentId: "main",
    sessionId: "admitted-assistant",
    sessionKey: "agent:main:admitted-assistant",
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = await SessionManager.openAsync(scope, dir);
  const admitted = await manager.appendMessageWithTranscriptAnchorAsync({
    role: "user",
    content: "current",
    timestamp: 1,
  });
  if (!admitted.anchor) {
    throw new Error("missing admission anchor");
  }

  const reply = buildAssistantMessage("reply");
  const replyId = expectDefined(
    await runWithSessionTranscriptReadFence(
      { ...admitted.anchor, logicalTurnId: "current", role: "user" },
      () => manager.appendMessageAsync(reply),
    ),
    "reply append must persist",
  );

  expect(manager.getBranch().map((entry) => entry.id)).toEqual([admitted.entryId, replyId]);
  await closeOpenClawAgentDatabasesAsync(dir);
  closeOpenClawAgentDatabasesForTest(dir);
  const reopened = await SessionManager.openAsync(scope, dir);
  expect(reopened.getBranch().map((entry) => entry.id)).toEqual([admitted.entryId, replyId]);
  expect(reopened.getEntry(replyId)).toMatchObject({
    type: "message",
    parentId: admitted.entryId,
    message: reply,
  });
  expect(reopened.buildSessionContext().messages).toMatchObject([
    { role: "user", content: "current", timestamp: 1 },
    reply,
  ]);
});

it("rebases a fenced append without reading the obsolete payloads", async () => {
  const { dir, scope } = await createSessionScope("fenced-assistant-rebase");
  const seed = await SessionManager.openAsync(scope, dir);
  const earlierUserId = expectDefined(
    await seed.appendMessageAsync(makeUserMessage("earlier retained payload", 0)),
    "Expected appended message",
  );
  const admission = await seed.appendMessageWithTranscriptAnchorAsync({
    role: "user",
    content: "current",
    timestamp: 1,
  });
  if (!admission.anchor) {
    throw new Error("missing admission anchor");
  }

  await runWithSessionTranscriptReadFence(
    { ...admission.anchor, logicalTurnId: "current", role: "user" },
    async () => {
      const fenced = await SessionManager.openAsync(scope, dir);
      expect(
        appendTranscriptMessageSync(scope, {
          eventId: "concurrent-assistant",
          message: buildAssistantMessage("concurrent"),
          now: 2,
        }).ok,
      ).toBe(true);
      const retained = fenced.getEntry(earlierUserId);
      if (retained?.type !== "message" || retained.message.role !== "user") {
        throw new Error("missing retained user");
      }
      const content = retained.message.content;
      const readObsoletePayload = vi.fn(() => content);
      Object.defineProperty(retained.message, "content", {
        enumerable: true,
        get: readObsoletePayload,
      });
      const reply = buildAssistantMessage("reply");
      const replyId = expectDefined(
        await fenced.appendMessageAsync(reply),
        "Expected appended message",
      );
      // Reload already carries canonical rows; walking the old payloads copies discarded history.
      expect(readObsoletePayload).not.toHaveBeenCalled();
      expect(fenced.getBranch().map((entry) => entry.id)).toEqual([
        earlierUserId,
        admission.entryId,
        "concurrent-assistant",
        replyId,
      ]);
      expect(fenced.buildSessionContext().messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ text: "reply" }],
      });
    },
  );
});

it("excludes interleaved display payloads without inventing events or losing fenced append ancestry", async () => {
  const { dir, scope } = await createSessionScope("display");
  const manager = await SessionManager.openAsync(scope, dir);
  const userId = expectDefined(
    await manager.appendMessageAsync({
      role: "user",
      content: "retained",
      timestamp: 1,
    }),
    "Expected appended message",
  );
  const display = async () =>
    expectDefined(
      await manager.appendMessageAsync({
        role: "custom",
        customType: "display-test",
        content: "x".repeat(20_000),
        display: true,
        excludeFromContext: true,
        timestamp: 1,
      }),
      "Expected appended message",
    );
  await display();
  await manager.appendMessageAsync({ role: "user", content: "also retained", timestamp: 1 });
  await manager.appendCompactionAsync("summary", userId, 100);
  const tailId = await display();
  const limits = { maxEvents: 3, maxBytes: 4096 };
  const read = () => readSessionTranscriptBoundedActiveContextCore(scope, limits);
  const context = read();
  expect(context.events).toHaveLength(4); // Header plus the three real context events.
  expect(context.serializedBytes).toBe(
    context.events.reduce<number>(
      (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)) + 1,
      0,
    ),
  );
  expect(context.serializedBytes).toBeLessThan(limits.maxBytes);
  expect(context.activeLeafEntryId).toBe(tailId);
  const bounded = await SessionManager.openBoundedAsync(scope, limits);
  expect(bounded.getAppendParentId()).toBe(tailId);
  expect(bounded.buildSessionContext()).toEqual(manager.buildSessionContext());
  const appended = await bounded.appendMessageWithTranscriptAnchorAsync(
    makeUserMessage("current", 2),
  );
  expect(appended.anchor?.effectiveParentId).toBe(tailId);
  if (!appended.anchor) {
    throw new Error("missing admission anchor");
  }
  await runWithSessionTranscriptReadFence(
    { ...appended.anchor, logicalTurnId: "display-turn", role: "user" },
    async () => {
      expect(read().events).toEqual(context.events);
      const fenced = await SessionManager.openBoundedAsync(scope, limits);
      expect(fenced.getAppendParentId()).toBe(tailId);
      expect(fenced.buildSessionContext()).toEqual(manager.buildSessionContext());
      expect((await SessionManager.openAsync(scope, dir)).buildSessionContext()).toEqual(
        manager.buildSessionContext(),
      );
      const retargeted = SessionManager.inMemory(dir);
      await retargeted.setSessionTargetAsync(scope);
      expect(retargeted.buildSessionContext()).toEqual(manager.buildSessionContext());
    },
  );
  expect((await SessionManager.openAsync(scope, dir)).getBranch().at(-1)?.id).toBe(
    appended.entryId,
  );
});

it.each(["async"])("keeps appended display payloads out of a bounded view (%s)", async (mode) => {
  const { dir, scope } = await createSessionScope(`display-append-${mode}`);
  const manager = await SessionManager.openBoundedAsync(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 10,
  });
  const user = await manager.appendMessageWithTranscriptAnchorAsync(makeUserMessage("keep", 1));
  const side = await manager.appendMessageWithTranscriptAnchorAsync(makeUserMessage("side", 2));
  await manager.appendLeafControlAsync({
    targetId: user.entryId,
    appendParentId: side.entryId,
    appendMode: "side",
  });
  const displayIds: string[] = [];
  for (let index = 0; index < 3; index++) {
    const message = {
      role: "custom" as const,
      customType: "display-test",
      content: `display-${index}:` + "x".repeat(20_000),
      display: true,
      excludeFromContext: true as const,
      timestamp: index + 2,
    };
    const appended = await manager.appendMessageWithTranscriptAnchorAsync(message);
    displayIds.push(appended.entryId);
    expect(manager.getEntry(appended.entryId)).toBeUndefined();
    expect(manager.getAppendParentId()).toBe(appended.entryId);
    expect(manager.getBranch().map((entry) => entry.id)).toEqual([user.entryId]);
  }
  const answer = await manager.appendMessageWithTranscriptAnchorAsync(
    buildAssistantMessage("reply"),
  );
  expect(manager.getBranch().map((entry) => entry.id)).toEqual([user.entryId, answer.entryId]);
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  const reopened = await SessionManager.openBoundedAsync(scope, {
    maxBytes: 4096,
    maxEvents: 10,
  });
  expect(manager.getBranch()).toEqual(reopened.getBranch());
  const events = await loadTranscriptEvents(scope);
  expect(events.filter((entry) => displayIds.includes((entry as { id: string }).id))).toHaveLength(
    3,
  );
  expect(
    [...displayIds, answer.entryId].map((id) =>
      events.find((entry) => (entry as { id: string }).id === id),
    ),
  ).toEqual([side.entryId, ...displayIds].map((parentId) => expect.objectContaining({ parentId })));
});

it("rejects a fenced assistant when a later hidden user has advanced the turn", async () => {
  const { dir, scope } = await createSessionScope("fenced-assistant");
  const manager = await SessionManager.openAsync(scope, dir);
  await manager.appendMessageAsync({ role: "user", content: "previous", timestamp: 1 });
  const admission = await manager.appendMessageWithTranscriptAnchorAsync({
    role: "user",
    content: "admitted",
    timestamp: 2,
  });
  await manager.appendMessageAsync({ role: "user", content: "newer", timestamp: 3 });
  if (!admission.anchor) {
    throw new Error("missing current-turn anchor");
  }

  await runWithSessionTranscriptReadFence(
    { ...admission.anchor, logicalTurnId: "fenced-assistant", role: "user" },
    async () => {
      const fenced = await SessionManager.openBoundedAsync(scope, {
        cwd: dir,
        maxBytes: 4096,
        maxEvents: 8,
      });
      await expect(fenced.appendMessageAsync(buildAssistantMessage("stale reply"))).rejects.toThrow(
        "SQLite transcript changed while preparing rewrite",
      );
    },
  );
});

it("rejects a fenced tool result when a later hidden user has advanced the turn", async () => {
  const { dir, scope } = await createSessionScope("fenced-tool-result");
  const manager = await SessionManager.openAsync(scope, dir);
  await manager.appendMessageAsync({ role: "user", content: "previous", timestamp: 1 });
  const admission = await manager.appendMessageWithTranscriptAnchorAsync({
    role: "user",
    content: "admitted",
    timestamp: 2,
  });
  await manager.appendMessageAsync({ role: "user", content: "newer", timestamp: 3 });
  if (!admission.anchor) {
    throw new Error("missing current-turn anchor");
  }

  await runWithSessionTranscriptReadFence(
    { ...admission.anchor, logicalTurnId: "fenced-tool-result", role: "user" },
    async () => {
      const fenced = await SessionManager.openBoundedAsync(scope, {
        cwd: dir,
        maxBytes: 4096,
        maxEvents: 8,
      });
      await expect(
        fenced.appendMessageAsync({
          role: "toolResult",
          toolCallId: "stale-tool-call",
          toolName: "test_tool",
          content: [{ type: "text", text: "stale result" }],
          isError: false,
          timestamp: 4,
        }),
      ).rejects.toThrow("SQLite transcript changed while preparing rewrite");
    },
  );
});

it("rejects suffix cleanup when the admission fence hides later transcript rows", async () => {
  const { dir, scope } = await createSessionScope("fenced-cleanup");
  const manager = await SessionManager.openAsync(scope, dir);
  await manager.appendMessageAsync({ role: "user", content: "retained", timestamp: 1 });
  const removableId = expectDefined(
    await manager.appendMessageAsync(buildAssistantMessage("temporary")),
    "Expected appended message",
  );
  const admission = await manager.appendMessageWithTranscriptAnchorAsync({
    role: "user",
    content: "current turn",
    timestamp: 2,
  });
  await manager.appendMessageAsync(buildAssistantMessage("hidden response"));
  const raw = await loadTranscriptEvents(scope);
  if (!admission.anchor) {
    throw new Error("missing current-turn anchor");
  }

  await runWithSessionTranscriptReadFence(
    { ...admission.anchor, logicalTurnId: "fenced-cleanup", role: "user" },
    async () => {
      const fenced = await SessionManager.openAsync(scope, dir);
      const entries = fenced.getEntries();
      await expect(
        fenced.removeTrailingEntriesAsync((entry) => entry.id === removableId),
      ).rejects.toThrow(/admission hides rows needed for suffix mutation/);
      expect(fenced.getEntries()).toEqual(entries);
    },
  );
  await expect(loadTranscriptEvents(scope)).resolves.toEqual(raw);
});

it("retains the forward cut after consecutive excluded first-kept entries", async () => {
  const count = 2;
  const { dir, scope } = await createSessionScope("excluded-cut", "openclaw-agent.sqlite");
  const manager = await SessionManager.openAsync(scope, dir);
  await manager.appendMessageAsync({ role: "user", content: "summarized away", timestamp: 1 });
  const excluded = await Promise.all(
    Array.from({ length: count }, async () =>
      expectDefined(
        await manager.appendMessageAsync({
          role: "custom",
          customType: "display-test",
          content: "display only",
          display: true,
          excludeFromContext: true,
          timestamp: 2,
        }),
        "Expected appended message",
      ),
    ),
  );
  const firstKept = excluded.at(0);
  if (!firstKept) {
    throw new Error("missing first-kept fixture");
  }
  await manager.appendMessageAsync({ role: "user", content: "retained", timestamp: 3 });
  await manager.appendCompactionAsync("summary", firstKept, 100);
  const expected = manager.buildSessionContext();
  expect(expected.messages).toMatchObject([
    { role: "compactionSummary", summary: "summary" },
    { role: "user", content: "retained" },
  ]);
  const bounded = await SessionManager.openBoundedAsync(scope, { maxEvents: 4, maxBytes: 4096 });
  expect(bounded.buildSessionContext()).toEqual(expected);
  await bounded.appendMessageAsync({ role: "user", content: "after reopen", timestamp: 4 });
  expect((await SessionManager.openAsync(scope, dir)).buildSessionContext().messages).toMatchObject(
    [...expected.messages, { role: "user", content: "after reopen" }],
  );
});

it("preserves the durable leaf when bounded cleanup removes the whole selected window", async () => {
  const { dir, scope } = await createSessionScope("whole-window-session");
  const seed = await SessionManager.openAsync(scope, dir);
  const durableId = expectDefined(
    await seed.appendMessageAsync({
      role: "user",
      content: "durable",
      timestamp: 1,
    }),
    "Expected appended message",
  );
  const removableId = expectDefined(
    await seed.appendMessageAsync(buildAssistantMessage("temporary")),
    "Expected appended message",
  );
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: path.join(dir, "openclaw-agent.sqlite"),
  });

  const bounded = await SessionManager.openBoundedAsync(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 1,
  });
  expect(await bounded.removeTrailingEntriesAsync((entry) => entry.id === removableId)).toBe(1);
  const reopened = await SessionManager.openAsync(scope, dir);
  expect(reopened.getAppendParentId()).toBe(durableId);
  expect(reopened.buildSessionContext().messages).toMatchObject([{ content: "durable" }]);
  await reopened.appendMessageAsync({ role: "user", content: "after cleanup", timestamp: 2 });
  expect((await SessionManager.openAsync(scope, dir)).buildSessionContext().messages).toMatchObject(
    [{ content: "durable" }, { content: "after cleanup" }],
  );
});

it("bounds runtime hydration while preserving older durable transcript rows on rewrites", async () => {
  const dir = tempDirs.make("openclaw-session-manager-bounded-");
  const storePath = path.join(dir, "sessions.json");
  const scope = {
    agentId: "main",
    sessionId: "bounded-runtime-session",
    sessionKey: "agent:main:bounded-runtime-session",
    storePath,
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  for (const content of ["oldest", "middle", "latest"]) {
    await appendTranscriptMessage(scope, { cwd: dir, message: { role: "user", content } });
  }

  const manager = await SessionManager.openBoundedAsync(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 2,
  });

  expect(manager.buildSessionContext().messages).toMatchObject([
    { content: "middle" },
    { content: "latest" },
  ]);
  expect(manager.getEntries()).toHaveLength(2);
  expect(
    await manager.removeTrailingEntriesAsync(
      (entry) =>
        entry.type === "message" &&
        "content" in entry.message &&
        entry.message.content === "latest",
    ),
  ).toBe(1);
  await expect(loadTranscriptEvents(scope)).resolves.toMatchObject([
    { type: "session" },
    { message: { content: "oldest" } },
    { message: { content: "middle" } },
  ]);
});

it("rejects bounded cleanup across opaque hydration-boundary rows", async () => {
  const { dir, scope } = await createSessionScope("bounded-opaque-boundary");
  const seed = await SessionManager.openAsync(scope, dir);
  await seed.appendMessageAsync({ role: "user", content: "retained", timestamp: 1 });
  await seed.appendMessageAsync({ role: "user", content: "remove", timestamp: 2 });
  await appendTranscriptEvent(scope, {
    type: "future-metadata",
    id: "opaque-boundary",
    parentId: null,
  });
  await seed.reloadPersistedTranscriptAsync();
  await seed.appendMessageAsync({ role: "user", content: "remove", timestamp: 3 });
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  const manager = await SessionManager.openBoundedAsync(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 1,
  });
  openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  })
    .db.prepare("UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 3")
    .run(scope.sessionId);

  await expect(
    manager.removeTrailingEntriesAsync(
      (entry) =>
        entry.type === "message" &&
        "content" in entry.message &&
        entry.message.content === "remove",
    ),
  ).rejects.toThrow("Bounded transcript cleanup cannot cross the hydrated removal window");
});

it("ignores inactive matching rows before the bounded active cleanup window", async () => {
  const { dir, scope } = await createSessionScope("bounded-inactive-boundary");
  const root = await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "root",
    message: { role: "user", content: "retained" },
  });
  await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "inactive-remove",
    message: { role: "assistant", content: "remove" },
    parentId: root.messageId,
  });
  const branchManager = await SessionManager.openAsync(scope, dir);
  await branchManager.branchAsync(root.messageId);
  const activeId = expectDefined(
    await branchManager.appendMessageAsync(buildAssistantMessage("remove")),
    "Expected appended message",
  );
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });

  const manager = await SessionManager.openBoundedAsync(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 1,
  });
  expect(await manager.removeTrailingEntriesAsync((entry) => entry.id === activeId)).toBe(1);
  expect((await SessionManager.openAsync(scope, dir)).buildSessionContext().messages).toMatchObject(
    [{ content: "retained" }],
  );
});

it("keeps the original hydration boundary after a partial bounded trim", async () => {
  const { dir, scope } = await createSessionScope("bounded-partial-trim");
  for (let index = 0; index < 12; index += 1) {
    await appendTranscriptMessage(scope, {
      eventId: `event-${index}`,
      message: { role: index % 2 === 0 ? "user" : "assistant", content: `message-${index}` },
      now: index + 1,
    });
  }
  const manager = await SessionManager.openAsync(scope, dir, {
    maxBytes: 1024 * 1024,
    maxEvents: 8,
  });
  expect(await manager.removeTrailingEntriesAsync((entry) => entry.id === "event-11")).toBe(1);
  expect(await manager.removeTrailingEntriesAsync((entry) => entry.id !== "event-3")).toBe(7);
  expect(
    (await loadTranscriptEvents(scope))
      .map((entry) => (entry as { id?: string }).id)
      .filter((id) => id?.startsWith("event-")),
  ).toEqual(["event-0", "event-1", "event-2", "event-3"]);
});

it("keeps an all-preserved bounded window as a no-op", async () => {
  const { dir, scope } = await createSessionScope("bounded-preserved-noop");
  expect(
    replaceTranscriptEventsSync(scope, [
      {
        type: "session",
        version: 3,
        id: scope.sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: dir,
      },
      ...Array.from({ length: 4 }, (_value, index) => ({
        type: "custom" as const,
        id: `preserved-${index}`,
        parentId: index === 0 ? null : `preserved-${index - 1}`,
        timestamp: new Date(index + 1).toISOString(),
        customType: "preserved-metadata",
        data: { index },
      })),
    ]),
  ).toBe(true);
  const manager = await SessionManager.openBoundedAsync(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 2,
  });

  expect(
    await manager.removeTrailingEntriesAsync(() => true, {
      preserveTrailing: (entry) => entry.type === "custom",
    }),
  ).toBe(0);
  expect((await loadTranscriptEvents(scope)).map((entry) => (entry as { id?: string }).id)).toEqual(
    [scope.sessionId, "preserved-0", "preserved-1", "preserved-2", "preserved-3"],
  );
});

it.each([
  { corruptSeq: 1, name: "older raw prefix" },
  { corruptSeq: 2, name: "newly exposed bounded row" },
])("removes a bounded tail without parsing a $name", async ({ corruptSeq }) => {
  const dir = tempDirs.make("openclaw-session-manager-unparsed-prefix-");
  const scope = {
    agentId: "main",
    sessionId: `unparsed-prefix-session-${corruptSeq}`,
    sessionKey: `agent:main:unparsed-prefix-session-${corruptSeq}`,
    storePath: path.join(dir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const seed = await SessionManager.openAsync(scope, dir);
  await seed.appendMessageAsync({ role: "user", content: "older", timestamp: 1 });
  await seed.appendMessageAsync({ role: "user", content: "middle", timestamp: 2 });
  await seed.appendMessageAsync({ role: "user", content: "retained", timestamp: 3 });
  const removableId = expectDefined(
    await seed.appendMessageAsync(buildAssistantMessage("temporary")),
    "Expected appended message",
  );
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: path.join(dir, "openclaw-agent.sqlite"),
  });
  const manager = await SessionManager.openBoundedAsync(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 2,
  });

  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  database.db
    .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = ?")
    .run("{excluded-row-is-not-json", scope.sessionId, corruptSeq);

  expect(await manager.removeTrailingEntriesAsync((entry) => entry.id === removableId)).toBe(1);
  expect(manager.buildSessionContext().messages).toMatchObject([{ content: "retained" }]);
  expect(
    database.db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = ?")
      .get(scope.sessionId, corruptSeq),
  ).toEqual({ event_json: "{excluded-row-is-not-json" });
});

it("invalidates raw and visible cursors while keeping the projection available", async () => {
  const { dir, scope } = await createSessionScope("cursor-rewrite-session");
  const manager = await SessionManager.openAsync(scope, dir);
  await manager.appendMessageAsync({ role: "user", content: "retained", timestamp: 1 });
  const removableId = expectDefined(
    await manager.appendMessageAsync(buildAssistantMessage("temporary")),
    "Expected appended message",
  );
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: path.join(dir, "openclaw-agent.sqlite"),
  });
  const raw = readTranscriptRawDelta(scope);
  const visible = readSessionTranscriptVisibleMessageDeltaCore(scope);
  if (raw.kind !== "page" || visible.kind !== "page") {
    throw new Error("missing cursor fixture");
  }

  expect(await manager.removeTrailingEntriesAsync((entry) => entry.id === removableId)).toBe(1);
  await manager.appendMessageAsync(buildAssistantMessage("replacement"));

  expect(readTranscriptRawDelta(scope, { cursor: raw.cursor })).toMatchObject({
    kind: "reset",
    reason: "generation_mismatch",
  });
  expect(
    readSessionTranscriptVisibleMessageDeltaCore(scope, { cursor: visible.cursor }),
  ).toMatchObject({ kind: "reset", reason: "generation_mismatch" });
  await SessionManager.openBoundedAsync(scope, { cwd: dir, maxBytes: 4096, maxEvents: 4 });
});

it("keeps a long transcript projection available when removing a trailing entry", async () => {
  const { dir, scope } = await createSessionScope("long-suffix-session");
  const events = [
    {
      type: "session",
      version: 3,
      id: scope.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: dir,
    },
    ...Array.from({ length: SYNC_REBUILD_MAX_ROWS }, (_value, index) => ({
      type: "message",
      id: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
      timestamp: new Date(index + 1).toISOString(),
      message: { role: index % 2 === 0 ? "user" : "assistant", content: `message ${index}` },
    })),
  ];
  expect(replaceTranscriptEventsSync(scope, events)).toBe(true);
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: path.join(dir, "openclaw-agent.sqlite"),
  });
  const generationBefore = readSessionTranscriptWatermark(scope)?.generation;

  const manager = await SessionManager.openBoundedAsync(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 4,
  });
  expect(
    await manager.removeTrailingEntriesAsync(
      (entry) => entry.id === `message-${SYNC_REBUILD_MAX_ROWS - 1}`,
    ),
  ).toBe(1);

  expect(readSessionTranscriptWatermark(scope)?.generation).not.toBe(generationBefore);
  await SessionManager.openBoundedAsync(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 4,
  });
});

it.each([
  { oversized: "retained prefix", temporaryContent: "temporary" },
  { oversized: "removed suffix", temporaryContent: "x".repeat(SYNC_REBUILD_MAX_BYTES + 1) },
])("removes a trailing entry with an oversized $oversized", async ({ temporaryContent }) => {
  const { dir, scope } = await createSessionScope("large-byte-suffix-session");
  const manager = await SessionManager.openAsync(scope, dir);
  await manager.appendMessageAsync({
    role: "user",
    content: temporaryContent === "temporary" ? "x".repeat(SYNC_REBUILD_MAX_BYTES + 1) : "retained",
    timestamp: 1,
  });
  const removableId = expectDefined(
    await manager.appendMessageAsync({
      role: "user",
      content: temporaryContent,
      timestamp: 2,
    }),
    "Expected appended message",
  );
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: path.join(dir, "openclaw-agent.sqlite"),
  });

  expect(await manager.removeTrailingEntriesAsync((entry) => entry.id === removableId)).toBe(1);
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: path.join(dir, "openclaw-agent.sqlite"),
  });
  await SessionManager.openBoundedAsync(scope, { cwd: dir, maxBytes: 4096, maxEvents: 4 });
});

it("preserves inactive siblings when the bounded active branch fits its limits", async () => {
  const { dir, scope } = await createSessionScope("bounded-branch-session");
  const root = await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "root",
    message: { role: "user", content: "root" },
  });
  const inactive = await appendTranscriptMessage(scope, {
    cwd: dir,
    eventId: "inactive",
    message: { role: "assistant", content: "inactive" },
    parentId: root.messageId,
  });
  const branchManager = await SessionManager.openAsync(scope, dir);
  await branchManager.branchAsync(root.messageId);
  const activeId = expectDefined(
    await branchManager.appendMessageAsync({
      role: "user",
      content: "active",
      timestamp: 3,
    }),
    "Expected appended message",
  );

  const openBounded = async () =>
    await SessionManager.openBoundedAsync(scope, {
      cwd: dir,
      maxBytes: 4096,
      maxEvents: 3,
    });
  await expect(openBounded()).rejects.toThrow(SessionTranscriptProjectionUnavailableError);
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: path.join(dir, "openclaw-agent.sqlite"),
  });
  const manager = await openBounded();
  const generationBefore = readSessionTranscriptWatermark(scope).generation;

  expect(manager.buildSessionContext().messages).toMatchObject([
    { content: "root" },
    { content: "active" },
  ]);
  expect(await manager.removeTrailingEntriesAsync((entry) => entry.id === activeId)).toBe(1);
  expect(readSessionTranscriptWatermark(scope).generation).not.toBe(generationBefore);
  await openBounded();
  await expect(loadTranscriptEvents(scope)).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: inactive.messageId,
        message: { role: "assistant", content: "inactive" },
      }),
    ]),
  );
});

it("preserves explicit reset retention of excluded user input in a bounded reopen", async () => {
  const { dir, scope } = await createSessionScope("reset-excluded");
  const manager = await SessionManager.openAsync(scope, dir);
  await manager.appendMessageAsync({ role: "user", content: "discarded", timestamp: 1 });
  const retained = expectDefined(
    await manager.appendMessageAsync({
      role: "user",
      content: "explicitly retained",
      timestamp: 2,
      display: false,
      excludeFromContext: true,
    } as Parameters<SessionManager["appendMessageAsync"]>[0]),
    "Expected appended message",
  );
  await manager.appendResetBoundaryAsync("new", retained);
  const current = await manager.appendMessageWithTranscriptAnchorAsync(makeUserMessage("fresh", 3));
  const raw = await loadTranscriptEvents(scope);
  expect(manager.buildSessionContext().messages).toMatchObject([
    { content: "explicitly retained" },
    { content: "fresh" },
  ]);
  expect(
    (
      await SessionManager.openBoundedAsync(scope, { maxEvents: 8, maxBytes: 4096 })
    ).buildSessionContext(),
  ).toEqual(manager.buildSessionContext());
  expect(await loadTranscriptEvents(scope)).toEqual(raw);
  await manager.appendResetBoundaryAsync("new");
  expect(
    (
      await SessionManager.openBoundedAsync(scope, { maxEvents: 8, maxBytes: 4096 })
    ).buildSessionContext().messages,
  ).toEqual([]);
  if (!current.anchor) {
    throw new Error("Missing current-turn anchor");
  }
  await runWithSessionTranscriptReadFence(
    { ...current.anchor, logicalTurnId: "current", role: "user" },
    async () => {
      expect(
        (
          await SessionManager.openBoundedAsync(scope, { maxEvents: 8, maxBytes: 4096 })
        ).buildSessionContext().messages,
      ).toMatchObject([{ content: "explicitly retained" }]);
    },
  );
});
