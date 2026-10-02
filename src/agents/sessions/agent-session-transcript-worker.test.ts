import path from "node:path";
import { serialize } from "node:v8";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { appendAttemptCacheTtlIfNeeded } from "../embedded-agent-runner/run/attempt-thread-helpers.js";
import { createToolResultPromptProjectionState } from "../embedded-agent-runner/session-prompt-state.js";
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

it("commits streamed and custom messages off the host thread and adopts the committed branch", async () => {
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
    const sql = observeHostDataSql();
    const withWorker = metadataRuntime.withSessionMetadataWorker;
    const commandBytes: number[] = [];
    const workerSpy = vi
      .spyOn(metadataRuntime, "withSessionMetadataWorker")
      .mockImplementation((options, db, assertCurrent, operation) =>
        withWorker(options, db, assertCurrent, (worker) =>
          operation({
            execute: (command, commandOptions) => {
              if (command.type === "session.metadata.append") {
                commandBytes.push(serialize(command).byteLength);
              }
              return worker.execute(command, commandOptions);
            },
          }),
        ),
      );
    const payload = "const value = 42;\n".repeat(1280);
    const expectNoHostTranscriptSql = () => {
      expect(
        sql.queries.filter((query) =>
          /\b(?:transcript_events|transcript_payloads|session_windows|session_nodes)\b|BEGIN\s+IMMEDIATE/i.test(
            query,
          ),
        ),
      ).toEqual([]);
    };
    const assertWorkerCommit = async (
      message: Extract<AgentEvent, { type: "message_end" }>["message"],
    ) => {
      sql.queries.length = 0;
      await handleEvent({ type: "message_end", message });
      expectNoHostTranscriptSql();
    };
    try {
      await assertWorkerCommit(
        createAssistant(
          testModel,
          [{ type: "toolCall", id: "read-1", name: "read", arguments: { code: payload } }],
          "toolUse",
        ),
      );
      expect(guard.getPendingIds()).toEqual(["read-1"]);
      await assertWorkerCommit({
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: payload }],
        timestamp: 2,
      });
      expect(guard.getPendingIds()).toEqual([]);
      // The wire needs canonical JSON and one parsed message, plus a small control envelope.
      expect(commandBytes).toHaveLength(2);
      expect(Math.max(...commandBytes)).toBeLessThan(2 * Buffer.byteLength(payload) + 4096);

      const concurrent = SessionManager.open(target);
      const descendantId = concurrent.appendMessage(
        createAssistant(testModel, [{ type: "text", text: "concurrent reply" }]),
      );
      await assertWorkerCommit(createAssistant(testModel, [{ type: "text", text: "final reply" }]));
      expect(manager.getLeafEntry()?.parentId).toBe(descendantId);
      expect(manager.getBranch().some((entry) => entry.id === descendantId)).toBe(true);
      expect(loadTranscriptEventsSync(target)).toEqual(manager.getPersistedEntries());
      expect(committed).toEqual(["assistant", "toolResult", "assistant"]);

      sql.queries.length = 0;
      await appendAttemptCacheTtlIfNeeded({
        sessionManager: manager,
        timedOutDuringCompaction: false,
        compactionOccurredThisAttempt: false,
        config: { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } },
        provider: "anthropic",
        modelId: "test-model",
        isCacheTtlEligibleProvider: () => true,
        toolResultPromptProjectionState: createToolResultPromptProjectionState(),
      });
      expectNoHostTranscriptSql();
      expect(manager.getLeafEntry()).toMatchObject({
        type: "custom",
        customType: "openclaw.cache-ttl",
      });
      const priorLeaf = manager.getLeafId();
      const customMessage = {
        customType: "runtime-note",
        content: "Synthetic custom message persisted before publication.",
        display: true,
        details: { source: "test" },
      };
      const published: string[] = [];
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "custom") {
          expect(manager.getLeafEntry()).toMatchObject({
            type: "custom_message",
            parentId: priorLeaf,
            ...customMessage,
          });
          published.push(event.message.customType);
        }
      });
      try {
        sql.queries.length = 0;
        await session.sendCustomMessage(customMessage);
        expectNoHostTranscriptSql();
      } finally {
        unsubscribe();
      }
      expect(published).toEqual([customMessage.customType]);
      expect(session.agent.state.messages.at(-1)).toMatchObject({
        role: "custom",
        ...customMessage,
      });
      const directCustomId = manager.getLeafId();
      await assertWorkerCommit({
        role: "custom",
        ...customMessage,
        customType: "streamed-note",
        timestamp: 3,
      });
      expect(manager.getLeafEntry()).toMatchObject({
        type: "custom_message",
        parentId: directCustomId,
        customType: "streamed-note",
      });
      expect(loadTranscriptEventsSync(target)).toEqual(manager.getPersistedEntries());

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
      workerSpy.mockRestore();
      sql.restore();
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
