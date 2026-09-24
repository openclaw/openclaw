import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentEvent } from "../runtime/index.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();

it("commits streamed messages off the host thread before adopting guard state and rebases only within the turn", async () => {
  await withOpenClawTestState({ label: "session-stream-worker" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "stream-worker",
      sessionKey: "agent:main:stream-worker",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(target, state.workspaceDir);
    manager.appendMessage({ role: "user", content: "current turn", timestamp: 1 });
    const committed: string[] = [];
    const guard = installSessionToolResultGuard(manager, {
      onMessagePersisted(message) {
        expect(manager.getLeafEntry()).toMatchObject({ type: "message", message });
        committed.push(message.role);
      },
    });
    const { session } = await createTestSession({ sessionManager: manager });
    const handleEvent = Reflect.get(session, "handleAgentEvent") as (
      event: AgentEvent,
    ) => Promise<void>;
    const database = openOpenClawAgentDatabase({ agentId: "main", path: target.storePath });
    const hostExec = vi.spyOn(database.db, "exec");
    const assertWorkerCommit = async (
      message: Extract<AgentEvent, { type: "message_end" }>["message"],
    ) => {
      hostExec.mockClear();
      await handleEvent({ type: "message_end", message });
      expect(hostExec.mock.calls.filter(([sql]) => /^BEGIN\b/iu.test(sql))).toEqual([]);
    };
    try {
      await assertWorkerCommit(
        createAssistant(
          testModel,
          [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }],
          "toolUse",
        ),
      );
      expect(guard.getPendingIds()).toEqual(["read-1"]);
      await assertWorkerCommit({
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "read complete" }],
        timestamp: 2,
      });
      expect(guard.getPendingIds()).toEqual([]);

      const concurrent = SessionManager.open(target);
      const descendantId = concurrent.appendMessage(
        createAssistant(testModel, [{ type: "text", text: "concurrent reply" }]),
      );
      await assertWorkerCommit(createAssistant(testModel, [{ type: "text", text: "final reply" }]));
      expect(manager.getLeafEntry()?.parentId).toBe(descendantId);
      expect(manager.getBranch().some((entry) => entry.id === descendantId)).toBe(true);
      expect(loadTranscriptEventsSync(target)).toEqual(manager.getPersistedEntries());
      expect(committed).toEqual(["assistant", "toolResult", "assistant"]);

      SessionManager.open(target).appendMessage({
        role: "user",
        content: "new turn",
        timestamp: 3,
      });
      const before = loadTranscriptEventsSync(target);
      await expect(
        handleEvent({
          type: "message_end",
          message: createAssistant(testModel, [{ type: "text", text: "stale reply" }]),
        }),
      ).rejects.toThrow("SQLite transcript changed");
      expect(loadTranscriptEventsSync(target)).toEqual(before);
      expect(committed).toEqual(["assistant", "toolResult", "assistant"]);
    } finally {
      hostExec.mockRestore();
      session.dispose();
    }
  });
});

it("preserves a newer native view and tool-result state when a worker receipt arrives late", async () => {
  await withOpenClawTestState({ label: "session-delayed-receipt" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "delayed-receipt",
      sessionKey: "agent:main:delayed-receipt",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(target, state.workspaceDir);
    const userId = manager.appendMessage({ role: "user", content: "current turn", timestamp: 1 });
    const notifications: string[] = [];
    const guard = installSessionToolResultGuard(manager, {
      onMessagePersisted: (message) => {
        notifications.push(message.role);
      },
    });
    const text = (value: string) => createAssistant(testModel, [{ type: "text", text: value }]);
    const call = (ids: string[], name = "read") =>
      createAssistant(
        testModel,
        ids.map((id) => ({ type: "toolCall", id, name, arguments: {} })),
        "toolUse",
      );
    const toolResult = (id: string) => ({
      role: "toolResult" as const,
      toolCallId: id,
      toolName: "read",
      isError: false,
      content: [{ type: "text" as const, text: "completed" }],
      timestamp: 2,
    });
    const appendDelayed = async (message: ReturnType<typeof text>, newerWrite: () => void) => {
      const original = metadataRuntime.withSessionMetadataWorker;
      const delayed: typeof original = async (options, database, assertCurrent, operation) => {
        const receipt = await original(options, database, assertCurrent, operation);
        newerWrite();
        return receipt;
      };
      const spy = vi
        .spyOn(metadataRuntime, "withSessionMetadataWorker")
        .mockImplementation(delayed);
      try {
        return await manager.appendMessageAsync(message);
      } finally {
        spy.mockRestore();
      }
    };
    let newerId: string | undefined;
    const delayedId = await appendDelayed(text("worker reply"), () => {
      newerId = manager.appendMessage(text("newer native reply"));
    });
    expect(manager.getLeafId()).toBe(newerId);
    expect(manager.getBranch().map((entry) => entry.id)).toEqual([userId, delayedId, newerId]);
    expect(manager.getPersistedEntries()).toEqual(loadTranscriptEventsSync(target));

    await appendDelayed(call(["finished", "reused", "cleared"]), () => {
      manager.appendMessage(toolResult("finished"));
      manager.appendMessage(text("native boundary clears old calls"));
      manager.appendMessage(call(["reused"]));
      manager.appendMessage(toolResult("reused"));
      newerId = manager.appendMessage(call(["reused"], "write"));
    });
    expect(manager.getLeafId()).toBe(newerId);
    expect(guard.getPendingIds()).toEqual(["reused"]);
    const beforeFlush = manager.getEntries().length;
    guard.flushPendingToolResults();
    expect(manager.getEntries()).toHaveLength(beforeFlush + 1);
    expect(manager.getLeafEntry()).toMatchObject({
      message: {
        role: "toolResult",
        toolCallId: "reused",
        toolName: "write",
        isError: true,
      },
    });
    expect(guard.getPendingIds()).toEqual([]);
    const tailId = await manager.appendMessageAsync(text("normal append after receipt"));
    expect(manager.getLeafId()).toBe(tailId);
    expect(manager.getPersistedEntries()).toEqual(loadTranscriptEventsSync(target));
    expect(new Set(manager.getEntries().map((entry) => entry.id)).size).toBe(
      manager.getEntries().length,
    );
    expect(notifications).toHaveLength(
      manager.getEntries().filter((entry) => entry.type === "message").length - 1,
    );

    await appendDelayed(call(["omitted"]), () => {
      manager.appendMessage(text("newer selected view"));
      manager.branch(userId);
    });
    expect(manager.getLeafId()).toBe(userId);
    expect(guard.getPendingIds()).toEqual([]);
    const beforeOmittedFlush = loadTranscriptEventsSync(target);
    guard.flushPendingToolResults();
    expect(loadTranscriptEventsSync(target)).toEqual(beforeOmittedFlush);
  });
});
