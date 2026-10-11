import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import { replaceTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSessionTranscriptDatabasePath } from "../../config/sessions/session-accessor.transcript-target.js";
import { SYNC_REBUILD_MAX_BYTES } from "../../config/sessions/session-transcript-index.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { SessionManager } from "./session-manager.js";

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
  const manager = SessionManager.openBounded(scope, {
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

it.each(["sync", "async"] as const)(
  "rebases a fenced %s append without reading the obsolete payloads",
  async (mode) => {
    const { dir, scope } = await createSessionScope("fenced-assistant-rebase");
    const seed = SessionManager.open(scope, dir);
    const earlierUserId = seed.appendMessage(makeUserMessage("earlier retained payload", 0));
    const admission = seed.appendMessageWithTranscriptAnchor({
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
        const fenced = SessionManager.open(scope, dir);
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
        const replyId =
          mode === "sync" ? fenced.appendMessage(reply) : await fenced.appendMessageAsync(reply);
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
  },
);

it("adopts a fenced assistant when another append commits before its reload", async () => {
  const { dir, scope } = await createSessionScope("post-commit-append");
  const seed = SessionManager.open(scope, dir);
  const admission = seed.appendMessageWithTranscriptAnchor({
    role: "user",
    content: "current",
    timestamp: 1,
  });
  if (!admission.anchor) {
    throw new Error("missing admission anchor");
  }

  runWithSessionTranscriptReadFence(
    { ...admission.anchor, logicalTurnId: "current", role: "user" },
    () => {
      const fenced = SessionManager.open(scope, dir);
      const corePrototype = Object.getPrototypeOf(
        Object.getPrototypeOf(Object.getPrototypeOf(fenced)),
      ) as { reloadPersistedTranscriptAfterAppend: () => void };
      const originalReload = corePrototype.reloadPersistedTranscriptAfterAppend;
      vi.spyOn(corePrototype, "reloadPersistedTranscriptAfterAppend").mockImplementation(function (
        this: SessionManager,
        ...args: unknown[]
      ) {
        expect(
          appendTranscriptMessageSync(scope, {
            appendIntent: "active-branch",
            eventId: "post-commit-user",
            message: { role: "user", content: "later", timestamp: 3 },
            now: 3,
          }).ok,
        ).toBe(true);
        return originalReload.apply(this, args as []);
      });

      const replyId = fenced.appendMessage(buildAssistantMessage("reply"));

      expect(fenced.getBranch().map((entry) => entry.id)).toEqual([admission.entryId, replyId]);
      expect(fenced.getBranch().some((entry) => entry.id === "post-commit-user")).toBe(false);
    },
  );
});

it("adopts suffix cleanup before earlier-queued post-commit observers run", async () => {
  const { dir, scope } = await createSessionScope("suffix-commit-order");
  const manager = SessionManager.open(scope, dir);
  const retainedId = manager.appendMessage({ role: "user", content: "keep", timestamp: 1 });
  const removedId = manager.appendMessage(buildAssistantMessage("remove"));
  let observedIds: string[] | undefined;

  runOpenClawAgentWriteTransaction((database) => {
    expect(
      deferOpenClawAgentPostCommitPublication(database, () => {
        observedIds = manager.getBranch().map((entry) => entry.id);
      }),
    ).toBe(true);
    expect(manager.removeTrailingEntries((entry) => entry.id === removedId)).toBe(1);
  }, scope);

  expect(observedIds).toEqual([retainedId]);
  expect(manager.getBranch().map((entry) => entry.id)).toEqual([retainedId]);
});

it("excludes interleaved display payloads without inventing events or losing fenced append ancestry", async () => {
  const { dir, scope } = await createSessionScope("display");
  const manager = SessionManager.open(scope, dir);
  const userId = manager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
  const display = () =>
    manager.appendMessage({
      role: "custom",
      customType: "display-test",
      content: "x".repeat(20_000),
      display: true,
      excludeFromContext: true,
      timestamp: 1,
    });
  display();
  manager.appendMessage({ role: "user", content: "also retained", timestamp: 1 });
  manager.appendCompaction("summary", userId, 100);
  const tailId = display();
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
  const bounded = SessionManager.openBounded(scope, limits);
  expect(bounded.getAppendParentId()).toBe(tailId);
  expect(bounded.buildSessionContext()).toEqual(manager.buildSessionContext());
  const appended = bounded.appendMessageWithTranscriptAnchor(makeUserMessage("current", 2));
  expect(appended.anchor?.effectiveParentId).toBe(tailId);
  if (!appended.anchor) {
    throw new Error("missing admission anchor");
  }
  runWithSessionTranscriptReadFence(
    { ...appended.anchor, logicalTurnId: "display-turn", role: "user" },
    () => {
      expect(read().events).toEqual(context.events);
      const fenced = SessionManager.openBounded(scope, limits);
      expect(fenced.getAppendParentId()).toBe(tailId);
      expect(fenced.buildSessionContext()).toEqual(manager.buildSessionContext());
      expect(SessionManager.open(scope, dir).buildSessionContext()).toEqual(
        manager.buildSessionContext(),
      );
      const retargeted = SessionManager.inMemory(dir);
      retargeted.setSessionTarget(scope);
      expect(retargeted.buildSessionContext()).toEqual(manager.buildSessionContext());
    },
  );
  expect(SessionManager.open(scope, dir).getBranch().at(-1)?.id).toBe(appended.entryId);
});

it.each(["sync"])("keeps appended display payloads out of a bounded view (%s)", async (mode) => {
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
    const appended =
      mode === "async"
        ? await manager.appendMessageWithTranscriptAnchorAsync(message)
        : manager.appendMessageWithTranscriptAnchor(message);
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
  const manager = SessionManager.open(scope, dir);
  manager.appendMessage({ role: "user", content: "previous", timestamp: 1 });
  const admission = manager.appendMessageWithTranscriptAnchor({
    role: "user",
    content: "admitted",
    timestamp: 2,
  });
  manager.appendMessage({ role: "user", content: "newer", timestamp: 3 });
  if (!admission.anchor) {
    throw new Error("missing current-turn anchor");
  }

  runWithSessionTranscriptReadFence(
    { ...admission.anchor, logicalTurnId: "fenced-assistant", role: "user" },
    () => {
      const fenced = SessionManager.openBounded(scope, { cwd: dir, maxBytes: 4096, maxEvents: 8 });
      expect(() => fenced.appendMessage(buildAssistantMessage("stale reply"))).toThrow(
        "SQLite transcript changed while preparing rewrite",
      );
    },
  );
});

it("rejects suffix cleanup when the admission fence hides later transcript rows", async () => {
  const { dir, scope } = await createSessionScope("fenced-cleanup");
  const manager = SessionManager.open(scope, dir);
  manager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
  const removableId = manager.appendMessage(buildAssistantMessage("temporary"));
  const admission = manager.appendMessageWithTranscriptAnchor({
    role: "user",
    content: "current turn",
    timestamp: 2,
  });
  manager.appendMessage(buildAssistantMessage("hidden response"));
  const raw = await loadTranscriptEvents(scope);
  if (!admission.anchor) {
    throw new Error("missing current-turn anchor");
  }

  runWithSessionTranscriptReadFence(
    { ...admission.anchor, logicalTurnId: "fenced-cleanup", role: "user" },
    () => {
      const fenced = SessionManager.open(scope, dir);
      const entries = fenced.getEntries();
      expect(() => fenced.removeTrailingEntries((entry) => entry.id === removableId)).toThrow(
        /admission hides rows needed for suffix mutation/,
      );
      expect(fenced.getEntries()).toEqual(entries);
    },
  );
  await expect(loadTranscriptEvents(scope)).resolves.toEqual(raw);
});

it("rejects bounded cleanup across opaque hydration-boundary rows", async () => {
  const { dir, scope } = await createSessionScope("bounded-opaque-boundary");
  const seed = SessionManager.open(scope, dir);
  seed.appendMessage({ role: "user", content: "retained", timestamp: 1 });
  seed.appendMessage({ role: "user", content: "remove", timestamp: 2 });
  await appendTranscriptEvent(scope, {
    type: "future-metadata",
    id: "opaque-boundary",
    parentId: null,
  });
  seed.reloadPersistedTranscript();
  seed.appendMessage({ role: "user", content: "remove", timestamp: 3 });
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  const manager = SessionManager.openBounded(scope, { cwd: dir, maxBytes: 4096, maxEvents: 1 });
  openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  })
    .db.prepare("UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 3")
    .run(scope.sessionId);

  expect(() =>
    manager.removeTrailingEntries(
      (entry) =>
        entry.type === "message" &&
        "content" in entry.message &&
        entry.message.content === "remove",
    ),
  ).toThrow("Bounded transcript cleanup cannot cross the hydrated removal window");
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
  const manager = SessionManager.open(scope, dir, { maxBytes: 1024 * 1024, maxEvents: 8 });
  expect(manager.removeTrailingEntries((entry) => entry.id === "event-11")).toBe(1);
  expect(manager.removeTrailingEntries((entry) => entry.id !== "event-3")).toBe(7);
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
  const manager = SessionManager.openBounded(scope, {
    cwd: dir,
    maxBytes: 4096,
    maxEvents: 2,
  });

  expect(
    manager.removeTrailingEntries(() => true, {
      preserveTrailing: (entry) => entry.type === "custom",
    }),
  ).toBe(0);
  expect((await loadTranscriptEvents(scope)).map((entry) => (entry as { id?: string }).id)).toEqual(
    [scope.sessionId, "preserved-0", "preserved-1", "preserved-2", "preserved-3"],
  );
});

it.each([
  { oversized: "retained prefix", temporaryContent: "temporary" },
  { oversized: "removed suffix", temporaryContent: "x".repeat(SYNC_REBUILD_MAX_BYTES + 1) },
])("removes a trailing entry with an oversized $oversized", async ({ temporaryContent }) => {
  const { dir, scope } = await createSessionScope("large-byte-suffix-session");
  const manager = SessionManager.open(scope, dir);
  manager.appendMessage({
    role: "user",
    content: temporaryContent === "temporary" ? "x".repeat(SYNC_REBUILD_MAX_BYTES + 1) : "retained",
    timestamp: 1,
  });
  const removableId = manager.appendMessage({
    role: "user",
    content: temporaryContent,
    timestamp: 2,
  });
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: path.join(dir, "openclaw-agent.sqlite"),
  });

  expect(manager.removeTrailingEntries((entry) => entry.id === removableId)).toBe(1);
  await waitForSessionTranscriptIndexReconcile({
    agentId: scope.agentId,
    path: path.join(dir, "openclaw-agent.sqlite"),
  });
  expect(() =>
    SessionManager.openBounded(scope, { cwd: dir, maxBytes: 4096, maxEvents: 4 }),
  ).not.toThrow();
});

it("preserves explicit reset retention of excluded user input in a bounded reopen", async () => {
  const { dir, scope } = await createSessionScope("reset-excluded");
  const manager = SessionManager.open(scope, dir);
  manager.appendMessage({ role: "user", content: "discarded", timestamp: 1 });
  const retained = manager.appendMessage({
    role: "user",
    content: "explicitly retained",
    timestamp: 2,
    display: false,
    excludeFromContext: true,
  } as Parameters<SessionManager["appendMessage"]>[0]);
  manager.appendResetBoundary("new", retained);
  const current = manager.appendMessageWithTranscriptAnchor(makeUserMessage("fresh", 3));
  const raw = await loadTranscriptEvents(scope);
  expect(manager.buildSessionContext().messages).toMatchObject([
    { content: "explicitly retained" },
    { content: "fresh" },
  ]);
  expect(
    SessionManager.openBounded(scope, { maxEvents: 8, maxBytes: 4096 }).buildSessionContext(),
  ).toEqual(manager.buildSessionContext());
  expect(await loadTranscriptEvents(scope)).toEqual(raw);
  manager.appendResetBoundary("new");
  expect(
    SessionManager.openBounded(scope, { maxEvents: 8, maxBytes: 4096 }).buildSessionContext()
      .messages,
  ).toEqual([]);
  if (!current.anchor) {
    throw new Error("Missing current-turn anchor");
  }
  runWithSessionTranscriptReadFence(
    { ...current.anchor, logicalTurnId: "current", role: "user" },
    () => {
      expect(
        SessionManager.openBounded(scope, { maxEvents: 8, maxBytes: 4096 }).buildSessionContext()
          .messages,
      ).toMatchObject([{ content: "explicitly retained" }]);
    },
  );
});
