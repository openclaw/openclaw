import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  appendTranscriptEventSync,
  appendTranscriptMessageSync,
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { readAuthoritativeTranscriptEntryAnchor } from "../../config/sessions/session-accessor.sqlite-transcript-mirror.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { rewriteTranscriptEntriesInSessionManager } from "../embedded-agent-runner/transcript-rewrite.js";
import {
  makeAgentAssistantMessage,
  makeAgentToolResultMessage,
  makeAgentUserMessage,
} from "../test-helpers/agent-message-fixtures.js";
import { SessionManager } from "./session-manager.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

function createScope(state: OpenClawTestState) {
  return {
    agentId: "main",
    env: state.env,
    expectedLifecycleRevision: "original-lifecycle",
    expectedWriterRunId: "original-writer",
    sessionId: "keyed-tool-result",
    sessionKey: "agent:main:keyed-tool-result",
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
}

function setup(state: OpenClawTestState) {
  const scope = createScope(state);
  replaceSessionEntrySync(scope, {
    activeWriterRunId: scope.expectedWriterRunId,
    lifecycleRevision: scope.expectedLifecycleRevision,
    sessionId: scope.sessionId,
    updatedAt: 1,
  });
  const manager = SessionManager.open(scope, state.workspaceDir);
  const assistantId = manager.appendMessage(
    makeAgentAssistantMessage({
      content: [
        { type: "toolCall", id: "call-first", name: "wait", arguments: {} },
        { type: "toolCall", id: "call-second", name: "read", arguments: {} },
      ],
      stopReason: "toolUse",
    }),
  );
  const message = {
    role: "toolResult" as const,
    toolCallId: "call-first",
    toolName: "wait",
    content: [{ type: "text" as const, text: "waiting" }],
    idempotencyKey: "result:first",
    isError: false,
    timestamp: 1,
  };
  const first = manager.appendMessageWithTranscriptAnchor(message);
  return { scope, manager, assistantId, message, first };
}

function rawRows(scope: ReturnType<typeof setup>["scope"]) {
  return openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteTranscriptScope(scope)))
    .db.prepare("SELECT event_json, seq FROM transcript_events WHERE session_id = ? ORDER BY seq")
    .all(scope.sessionId);
}

function findBranchEntryByIdempotencyKey(params: {
  idempotencyKey: string;
  manager: SessionManager;
  scope: ReturnType<typeof setup>["scope"];
}) {
  return params.manager.getBranch().find(
    (entry) =>
      entry.type === "message" &&
      readAuthoritativeTranscriptEntryAnchor({
        ...params.scope,
        entryId: entry.id,
      })?.idempotencyKey === params.idempotencyKey,
  );
}

async function setupOpaqueLeafResults(state: OpenClawTestState) {
  const scope = createScope(state);
  replaceSessionEntrySync(scope, {
    activeWriterRunId: scope.expectedWriterRunId,
    lifecycleRevision: scope.expectedLifecycleRevision,
    sessionId: scope.sessionId,
    updatedAt: 1,
  });
  const manager = SessionManager.open(scope, state.workspaceDir);
  const assistantId = manager.appendMessage(
    makeAgentAssistantMessage({
      content: [
        { type: "toolCall", id: "call-first", name: "wait", arguments: {} },
        { type: "toolCall", id: "call-second", name: "read", arguments: {} },
      ],
      stopReason: "toolUse",
    }),
  );
  const firstMessage = {
    role: "toolResult" as const,
    toolCallId: "call-first",
    toolName: "wait",
    content: [{ type: "text" as const, text: "waiting" }],
    idempotencyKey: "result:opaque-first",
    isError: false,
    timestamp: 1,
  };
  const secondMessage = {
    ...firstMessage,
    toolCallId: "call-second",
    toolName: "read",
    content: [{ type: "text" as const, text: "read result" }],
    idempotencyKey: "result:leaf-second",
  };
  expect(
    appendTranscriptEventSync(scope, {
      type: "future-metadata",
      id: "opaque-parent",
      parentId: assistantId,
    }),
  ).toEqual({ ok: true, value: true });
  const first = appendTranscriptMessageSync(scope, {
    eventId: "first-result",
    message: firstMessage,
    parentId: "opaque-parent",
  });
  expect(first).toMatchObject({
    ok: true,
    value: { appended: true, messageId: "first-result" },
  });
  expect(
    appendTranscriptEventSync(scope, {
      type: "leaf",
      id: "leaf-control",
      parentId: "first-result",
      targetId: "first-result",
    }),
  ).toEqual({ ok: true, value: true });
  const second = appendTranscriptMessageSync(scope, {
    eventId: "second-result",
    message: secondMessage,
    parentId: "leaf-control",
  });
  expect(second).toMatchObject({
    ok: true,
    value: { appended: true, messageId: "second-result" },
  });
  await waitForSessionTranscriptIndexReconcile(scope);
  return { scope, firstMessage, secondMessage };
}

it.each(["warm", "cold", "bounded"] as const)(
  "adopts the canonical keyed tool result without changing bytes or cursors (%s)",
  async (mode) => {
    await withOpenClawTestState({ label: `tool-result-${mode}` }, async (state) => {
      const { scope, manager: original, message, first } = setup(state);
      const before = loadTranscriptEventsSync(scope);
      const beforeRows = rawRows(scope);
      if (mode === "cold") {
        closeOpenClawAgentDatabasesForTest();
      }
      const manager =
        mode === "warm"
          ? original
          : mode === "bounded"
            ? SessionManager.openBounded(scope, { maxBytes: 100_000, maxEvents: 1 })
            : SessionManager.open(scope, state.workspaceDir);

      expect(manager.appendMessageWithTranscriptAnchor({ ...message, timestamp: 99 })).toEqual({
        ...first,
        appended: false,
      });
      expect(manager.getLeafId()).toBe(first.entryId);
      expect(manager.getAppendParentId()).toBe(first.entryId);
      expect(first.anchor).toMatchObject({
        entryId: first.entryId,
        idempotencyKey: message.idempotencyKey,
      });
      expect(loadTranscriptEventsSync(scope)).toEqual(before);
      expect(rawRows(scope)).toEqual(beforeRows);
      expect(manager.getEntry(first.entryId)).toMatchObject({ message });
      expect(manager.getEntries()).toHaveLength(2);
    });
  },
);

it("keeps clean, dirty, and reconciled anchors equal across opaque and leaf ancestry", async () => {
  await withOpenClawTestState({ label: "tool-result-anchor-representation" }, async (state) => {
    const { scope } = await setupOpaqueLeafResults(state);
    const readAnchors = () => ({
      first: readAuthoritativeTranscriptEntryAnchor({ ...scope, entryId: "first-result" }),
      second: readAuthoritativeTranscriptEntryAnchor({ ...scope, entryId: "second-result" }),
    });
    const clean = readAnchors();
    expect(clean).toMatchObject({
      first: { effectiveParentId: "opaque-parent", idempotencyKey: "result:opaque-first" },
      second: { effectiveParentId: "leaf-control", idempotencyKey: "result:leaf-second" },
    });

    const database = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteTranscriptScope(scope)),
    );
    database.db
      .prepare(
        "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
      )
      .run(scope.sessionId);
    expect(readAnchors()).toEqual(clean);

    await waitForSessionTranscriptIndexReconcile(scope);
    expect(readAnchors()).toEqual(clean);
  });
});

it("replays through canonical opaque and leaf navigation without rewinding the active tail", async () => {
  await withOpenClawTestState({ label: "tool-result-canonical-navigation" }, async (state) => {
    const { scope, firstMessage } = await setupOpaqueLeafResults(state);
    const manager = SessionManager.open(scope, state.workspaceDir);
    const before = loadTranscriptEventsSync(scope);
    const beforeRows = rawRows(scope);
    const anchor = readAuthoritativeTranscriptEntryAnchor({ ...scope, entryId: "first-result" });

    expect(manager.appendMessageWithTranscriptAnchor(firstMessage)).toEqual({
      anchor,
      appended: false,
      entryId: "first-result",
      message: firstMessage,
    });
    expect(manager.getLeafId()).toBe("second-result");
    expect(manager.getAppendParentId()).toBe("second-result");
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
    expect(rawRows(scope)).toEqual(beforeRows);
  });
});

it("adopts a keyed tool result after suffix relocation without rewinding the active tail", async () => {
  await withOpenClawTestState({ label: "tool-result-relocated-suffix" }, async (state) => {
    const { scope, manager, message, first } = setup(state);
    const siblingMessage = {
      ...message,
      toolCallId: "call-second",
      toolName: "read",
      idempotencyKey: "result:second",
      content: [{ type: "text" as const, text: "read result" }],
    };
    const sibling = manager.appendMessage(siblingMessage);
    const replacement = {
      ...message,
      content: [{ type: "text" as const, text: "rewritten waiting" }],
    };

    expect(
      rewriteTranscriptEntriesInSessionManager({
        sessionManager: manager,
        replacements: [{ entryId: first.entryId, message: replacement }],
      }),
    ).toMatchObject({ changed: true, rewrittenEntries: 1 });

    const relocatedFirst = findBranchEntryByIdempotencyKey({
      idempotencyKey: message.idempotencyKey,
      manager,
      scope,
    });
    const relocatedSibling = findBranchEntryByIdempotencyKey({
      idempotencyKey: siblingMessage.idempotencyKey,
      manager,
      scope,
    });
    expect(relocatedFirst?.id).not.toBe(first.entryId);
    expect(relocatedSibling?.id).not.toBe(sibling);
    expect(relocatedSibling?.parentId).toBe(relocatedFirst?.id);
    const before = loadTranscriptEventsSync(scope);
    const beforeRows = rawRows(scope);

    expect(manager.appendMessageWithTranscriptAnchor(replacement)).toMatchObject({
      entryId: relocatedFirst?.id,
      appended: false,
    });
    expect(manager.getLeafId()).toBe(relocatedSibling?.id);
    expect(manager.getAppendParentId()).toBe(relocatedSibling?.id);
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
    expect(rawRows(scope)).toEqual(beforeRows);
  });
});

it("refreshes transcript state on replay before rewriting the active suffix", async () => {
  await withOpenClawTestState({ label: "tool-result-replay-rewrite" }, async (state) => {
    const { scope, manager: writer, message, first } = setup(state);
    const replaying = SessionManager.open(scope, state.workspaceDir);
    const siblingMessage = {
      ...makeAgentToolResultMessage({
        content: [{ type: "text", text: "read result" }],
        isError: false,
        toolCallId: "call-second",
        toolName: "read",
      }),
      idempotencyKey: "result:second",
    };
    const sibling = writer.appendMessage(siblingMessage);

    expect(replaying.appendMessageWithTranscriptAnchor(message)).toEqual({
      ...first,
      appended: false,
    });
    expect(replaying.getAppendParentId()).toBe(sibling);
    expect(
      rewriteTranscriptEntriesInSessionManager({
        sessionManager: replaying,
        replacements: [
          {
            entryId: first.entryId,
            message: {
              ...message,
              content: [{ type: "text", text: "rewritten after replay" }],
            },
          },
        ],
      }),
    ).toMatchObject({ changed: true, rewrittenEntries: 1 });
    expect(SessionManager.open(scope).getBranch()).toEqual(replaying.getBranch());
  });
});

it("rejects keyed replay after the retained transcript writer is revoked", async () => {
  await withOpenClawTestState({ label: "tool-result-retained-writer" }, async (state) => {
    const scope = createScope(state);
    const revoked = new Error("retained writer revoked");
    let active = true;

    const fixture = await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: scope,
        initialWriter: {
          writerRunId: scope.expectedWriterRunId,
          committedFence: {
            expectedLifecycleRevision: scope.expectedLifecycleRevision,
            expectedWriterRunId: scope.expectedWriterRunId,
          },
          assertActive: () => {
            if (!active) {
              throw revoked;
            }
          },
          recordCommitted: () => {},
        },
        withTranscriptWrite: async (write) => await write(),
      },
      async () => setup(state),
    );
    active = false;
    const before = loadTranscriptEventsSync(scope);

    expect(() => fixture.manager.appendMessageWithTranscriptAnchor(fixture.message)).toThrow(
      revoked,
    );
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
  });
});

it("replays an earlier parallel sibling without rewinding the active tail", async () => {
  await withOpenClawTestState({ label: "tool-result-sibling" }, async (state) => {
    const { scope, manager, message, first } = setup(state);
    const siblingMessage = {
      ...makeAgentToolResultMessage({
        content: [{ type: "text", text: "read result" }],
        isError: false,
        toolCallId: "call-second",
        toolName: "read",
      }),
      idempotencyKey: "result:second",
    };
    const sibling = manager.appendMessage(siblingMessage);
    const before = loadTranscriptEventsSync(scope);
    const beforeRows = rawRows(scope);

    expect(manager.appendMessageWithTranscriptAnchor(message)).toEqual({
      ...first,
      appended: false,
    });
    expect(manager.getLeafId()).toBe(sibling);
    expect(manager.getAppendParentId()).toBe(sibling);
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
    expect(rawRows(scope)).toEqual(beforeRows);
    expect(manager.getEntries()).toHaveLength(3);
  });
});

it.each([
  { content: [{ type: "text" as const, text: "changed" }] },
  { toolCallId: "call-changed" },
  { toolName: "changed" },
])("rejects keyed tool-result payload or identity drift: %j", async (change) => {
  await withOpenClawTestState({ label: "tool-result-conflict" }, async (state) => {
    const { scope, manager, message, first } = setup(state);
    const before = loadTranscriptEventsSync(scope);

    expect(() => manager.appendMessage({ ...message, ...change })).toThrow(
      "conflicts with the admitted message",
    );
    expect(manager.getAppendParentId()).toBe(first.entryId);
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
  });
});

it.each([
  "assistant",
  "user",
  "context-excluded-user",
  "reset",
  "inactive",
  "selected-branch",
] as const)(
  "rejects a keyed result outside its current assistant-result group (%s)",
  async (boundary) => {
    await withOpenClawTestState({ label: `tool-result-${boundary}` }, async (state) => {
      const { scope, manager, assistantId, message } = setup(state);
      if (boundary === "assistant") {
        manager.appendMessage(
          makeAgentAssistantMessage({
            content: [{ type: "toolCall", id: message.toolCallId, name: "wait", arguments: {} }],
            stopReason: "toolUse",
          }),
        );
      } else if (boundary === "user") {
        manager.appendMessage({ role: "user", content: "next", timestamp: 2 });
      } else if (boundary === "context-excluded-user") {
        const contextExcludedUser = {
          ...makeAgentUserMessage({
            content: "next hidden turn",
            timestamp: 2,
          }),
          excludeFromContext: true,
        };
        manager.appendMessage(contextExcludedUser);
      } else if (boundary === "reset") {
        manager.appendResetBoundary("reset");
      } else {
        manager.branch(assistantId);
        if (boundary === "inactive") {
          manager.appendMessage({ role: "user", content: "other branch", timestamp: 2 });
        }
      }
      const tail = manager.getAppendParentId();
      const before = loadTranscriptEventsSync(scope);

      expect(() => manager.appendMessage(message)).toThrow(
        boundary === "inactive"
          ? "Session transcript anchor was not returned"
          : boundary === "selected-branch"
            ? "cannot change the selected branch"
            : "outside the current group",
      );
      expect(manager.getAppendParentId()).toBe(tail);
      expect(loadTranscriptEventsSync(scope)).toEqual(before);
    });
  },
);

it.each(["writer", "lifecycle"] as const)(
  "rejects an identical keyed replay after the admitted %s changes",
  async (change) => {
    await withOpenClawTestState({ label: `tool-result-${change}` }, async (state) => {
      const { scope, manager, message, first } = setup(state);
      replaceSessionEntrySync(scope, {
        activeWriterRunId: change === "writer" ? "replacement-writer" : scope.expectedWriterRunId,
        lifecycleRevision:
          change === "lifecycle" ? "replacement-lifecycle" : scope.expectedLifecycleRevision,
        sessionId: scope.sessionId,
        updatedAt: 2,
      });
      const before = loadTranscriptEventsSync(scope);

      expect(() => manager.appendMessage(message)).toThrow(
        "session writer claim changed before transcript persistence",
      );
      expect(manager.getAppendParentId()).toBe(first.entryId);
      expect(loadTranscriptEventsSync(scope)).toEqual(before);
    });
  },
);

it("rejects a generation change between the SQLite replay receipt and adoption", async () => {
  await withOpenClawTestState({ label: "tool-result-generation" }, async (state) => {
    const { scope, manager, message, first } = setup(state);
    const before = loadTranscriptEventsSync(scope);
    const reload = manager.reloadPersistedTranscript.bind(manager);
    vi.spyOn(manager, "reloadPersistedTranscript").mockImplementationOnce(() => {
      expect(replaceTranscriptEventsSync(scope, before)).toBe(true);
      reload();
    });

    expect(() => manager.appendMessage(message)).toThrow("outside the current group");
    expect(manager.getAppendParentId()).toBe(first.entryId);
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
  });
});
