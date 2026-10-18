import path from "node:path";
import { serialize } from "node:v8";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import type { Model } from "../../llm/types.js";
import type { ReplyBackendMessageInjectionV2 } from "../../sessions/session-controller.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  captureCurrentReplyMessageInjectionTarget,
} from "../../sessions/session-controller.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../embedded-agent-runner/run/attempt-queue-message.js";
import { appendAttemptCacheTtlIfNeeded } from "../embedded-agent-runner/run/attempt-thread-helpers.js";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "../embedded-agent-runner/run/attempt-transcript-lifecycle-prepare.js";
import { createEmbeddedRunHandle } from "../embedded-agent-runner/runs.test-support.js";
import { createToolResultPromptProjectionState } from "../embedded-agent-runner/session-prompt-state.js";
import type { AgentEvent } from "../runtime/index.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import type { AgentSessionEvent } from "./agent-session-types.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
import { SessionManager } from "./session-manager.js";
import { getSteeringMessageIdentity } from "./steering-message-identity.js";

registerAgentSessionLoopTestLifecycle();

const assistantText = (value: string) =>
  createAssistant(testModel, [{ type: "text", text: value }]);
const call = (ids: string[], name = "read", args: Record<string, unknown> = {}) =>
  createAssistant(
    testModel,
    ids.map((id) => ({ type: "toolCall", id, name, arguments: args })),
    "toolUse",
  );
async function createTranscriptTarget(state: OpenClawTestState, sessionId: string) {
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
  };
  const entry = { sessionId, updatedAt: 1 };
  await upsertSessionEntryCore(target, entry);
  return { target, entry };
}

it("propagates transcript conflicts without synthesizing an assistant provider error", async () => {
  const { session, sessionManager } = await createTestSession();
  const conflict = new SqliteTranscriptMutationConflictError("conflicting-session");
  const append = sessionManager.appendMessageAsync.bind(sessionManager);
  let refused = false;
  vi.spyOn(sessionManager, "appendMessageAsync").mockImplementation(async (message, options) => {
    if (message.role === "assistant" && !refused) {
      refused = true;
      throw conflict;
    }
    return append(message, options);
  });
  streamMocks.streamSimple.mockImplementation((model: Model) =>
    createAssistantResultStream(createAssistant(model, [{ type: "text", text: "Done." }])),
  );
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  await expect(session.prompt("Do the work")).rejects.toBe(conflict);

  expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
  expect(session.agent.state.isStreaming).toBe(false);
  expect(
    events.some(
      (event) =>
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "error",
    ),
  ).toBe(false);
  expect(events.some((event) => event.type === "auto_retry_start")).toBe(false);
});

it("commits streamed and custom messages off the host thread and adopts the committed branch", async () => {
  await withOpenClawTestState({ label: "session-stream-worker" }, async (state) => {
    const { target } = await createTranscriptTarget(state, "stream-worker");
    const manager = SessionManager.open(target, state.workspaceDir);
    manager.appendMessage(makeUserMessage("current turn", 1));
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
    const transcriptSql =
      /\b(?:transcript_events|transcript_payloads|session_windows|session_nodes)\b|BEGIN\s+IMMEDIATE/i;
    const expectNoHostTranscriptSql = () =>
      expect(sql.queries.filter((query) => transcriptSql.test(query))).toEqual([]);
    const assertWorkerCommit = async (
      message: Extract<AgentEvent, { type: "message_end" }>["message"],
    ) => {
      sql.queries.length = 0;
      await handleEvent({ type: "message_end", message });
      expectNoHostTranscriptSql();
    };
    try {
      await assertWorkerCommit(call(["read-1"], "read", { code: payload }));
      expect(guard.getPendingIds()).toEqual(["read-1"]);
      await assertWorkerCommit(makeTextToolResult("read-1", "read", payload, false, 2));
      expect(guard.getPendingIds()).toEqual([]);
      // The wire needs canonical JSON and one parsed message, plus a small control envelope.
      expect(commandBytes).toHaveLength(2);
      expect(Math.max(...commandBytes)).toBeLessThan(2 * Buffer.byteLength(payload) + 4096);

      const concurrent = SessionManager.open(target);
      const descendantId = concurrent.appendMessage(assistantText("concurrent reply"));
      await assertWorkerCommit(assistantText("final reply"));
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

      SessionManager.open(target).appendMessage(makeUserMessage("new turn", 3));
      const before = loadTranscriptEventsSync(target);
      await expect(
        handleEvent({ type: "message_end", message: assistantText("stale reply") }),
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
    const { target } = await createTranscriptTarget(state, "delayed-receipt");
    const manager = SessionManager.open(target, state.workspaceDir);
    const userId = manager.appendMessage(makeUserMessage("current turn", 1));
    const notifications: string[] = [];
    const guard = installSessionToolResultGuard(manager, {
      onMessagePersisted: (message) => {
        notifications.push(message.role);
      },
    });
    const toolResult = (id: string) => makeTextToolResult(id, "read", "completed", false, 2);
    const appendDelayed = async (
      message: ReturnType<typeof assistantText>,
      newerWrite: () => void,
    ) => {
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
    const delayedId = await appendDelayed(assistantText("worker reply"), () => {
      newerId = manager.appendMessage(assistantText("newer native reply"));
    });
    expect(manager.getLeafId()).toBe(newerId);
    expect(manager.getBranch().map((entry) => entry.id)).toEqual([userId, delayedId, newerId]);
    expect(manager.getPersistedEntries()).toEqual(loadTranscriptEventsSync(target));

    await appendDelayed(call(["finished", "reused", "cleared"]), () => {
      manager.appendMessage(toolResult("finished"));
      manager.appendMessage(assistantText("native boundary clears old calls"));
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
    const tailId = await manager.appendMessageAsync(assistantText("normal append after receipt"));
    expect(manager.getLeafId()).toBe(tailId);
    expect(manager.getPersistedEntries()).toEqual(loadTranscriptEventsSync(target));
    expect(new Set(manager.getEntries().map((entry) => entry.id)).size).toBe(
      manager.getEntries().length,
    );
    expect(notifications).toHaveLength(
      manager.getEntries().filter((entry) => entry.type === "message").length - 1,
    );

    await appendDelayed(call(["omitted"]), () => {
      manager.appendMessage(assistantText("newer selected view"));
      manager.branch(userId);
    });
    expect(manager.getLeafId()).toBe(userId);
    expect(guard.getPendingIds()).toEqual([]);
    const beforeOmittedFlush = loadTranscriptEventsSync(target);
    guard.flushPendingToolResults();
    expect(loadTranscriptEventsSync(target)).toEqual(beforeOmittedFlush);
  });
});

it("keeps the active turn and all steers after an earlier steer receipt rewrites its transcript", async () => {
  await withOpenClawTestState({ label: "steer-transcript-conflict" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const { target, entry } = await createTranscriptTarget(state, "steer-conflict");
    const manager = guardSessionManager(
      await SessionManager.openAsync(target, state.workspaceDir),
      {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
      },
    );
    const transcript = await prepareEmbeddedAttemptTranscriptLifecycle({
      attempt: {
        runId: "active-run",
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionFile: target.sessionKey,
        sessionTarget: target,
        sessionManager: manager,
      },
      externalAbortController: {
        arm() {},
        async throwIfFiredAfterPrepCleanup() {},
      },
    });
    const toolStarted = createDeferredCore();
    const releaseTool = createDeferredCore();
    let requests = 0;
    const words = ["W0XYZ", "W1XYZ", "W2XYZ", "W3XYZ", "W4XYZ"];
    const inputs = words.map((word, index) => ({
      text: `Also include the word ${word}.`,
      idempotencyKey: `steer-${index}`,
    }));
    streamMocks.streamSimple.mockImplementation((model, context) => {
      requests += 1;
      const text = context.messages
        .filter((message) => message.role === "user")
        .flatMap((message) =>
          typeof message.content === "string"
            ? [message.content]
            : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
        )
        .join("\n");
      return createAssistantResultStream(
        createAssistant(
          model,
          requests === 1
            ? [{ type: "toolCall", id: "held-tool", name: "hold", arguments: {} }]
            : [{ type: "text", text: words.filter((word) => text.includes(word)).join(" ") }],
          requests === 1 ? "toolUse" : "stop",
        ),
      );
    });
    const { session } = await createTestSession({
      sessionManager: manager,
      withSessionWriteSettlement: transcript.withOwnedTranscriptWrite,
      customTools: [
        {
          name: "hold",
          label: "Hold",
          description: "Hold the current tool until steering is queued",
          parameters: Type.Object({}),
          execute: async () => {
            toolStarted.resolve();
            await releaseTool.promise;
            return { content: [{ type: "text", text: "Tool complete" }], details: {} };
          },
        },
      ],
    });
    session.agent.steeringMode = "all";
    const operation = createTestReplyOperation(target);
    const injection: ReplyBackendMessageInjectionV2 = {
      version: 2,
      isAvailable: () => true,
      queueMessage: (text, options, assertCurrent) =>
        steerActiveSessionWithOptionalDeliveryWait(
          session,
          text,
          options,
          target.sessionKey,
          () => {
            assertCurrent();
            return true;
          },
        ),
    };
    operation.attachBackend({
      ...createEmbeddedRunHandle({
        runId: "active-run",
        supportsTranscriptCommitWait: true,
        toolAuthorityFingerprint: "steer-fixture-authority",
      }),
      kind: "embedded",
      cancel() {},
      messageInjectionV2: injection,
    });
    operation.setPhase("running");
    const active = session.prompt("Run the held tool, then list every word I ask you to include.");
    void active.catch(() => {});
    const attempts: Awaited<ReturnType<typeof beginReplyMessageInjectionTarget>>[] = [];
    const unsubscribe = session.agent.subscribe(async (event) => {
      if (
        event.type === "message_start" &&
        getSteeringMessageIdentity(event.message) === "steer-1"
      ) {
        // Let the real receipt rewrite finish before the next user append reads its watermark.
        await attempts[0]?.outcome;
      }
    });
    try {
      await awaitGateBeforeSettlement(
        toolStarted.promise,
        active,
        "Active turn never ran its tool",
      );
      const recorders = inputs.map((input) => ({
        input,
        recorder: createUserTurnTranscriptRecorder({
          input: { ...input },
          target: { ...target, sessionEntry: entry },
        }),
      }));
      const staged = await Promise.all(
        recorders.map(({ recorder, input }) =>
          recorder.stageApproved!({ runId: input.idempotencyKey, assertCurrent() {} }),
        ),
      );
      expect(staged).toEqual(words.map(() => true));
      const injectionTarget = captureCurrentReplyMessageInjectionTarget(target.sessionKey)!;
      const queued = recorders.map(({ recorder, input }) =>
        beginReplyMessageInjectionTarget(injectionTarget, input.text, {
          steeringMode: "all",
          isInboundUserMessage: true,
          toolAuthorityFingerprint: "steer-fixture-authority",
          waitForTranscriptCommit: true,
          queueIdentity: input.idempotencyKey,
          userTurnTranscriptRecorder: recorder,
        }),
      );
      attempts.push(...(await Promise.all(queued)));
      expect(await Promise.all(attempts.map((attempt) => attempt.acceptance))).toEqual(
        words.map(() => true),
      );
      releaseTool.resolve();
      await expect(active).resolves.toBeUndefined();
      expect(await Promise.all(attempts.map((attempt) => attempt.outcome))).toEqual(
        words.map(() => ({ status: "accepted" })),
      );
      expect(requests).toBe(2);
      expect(session.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "W0XYZ W1XYZ W2XYZ W3XYZ W4XYZ" }],
      });
      const reopened = await SessionManager.openAsync(target);
      const users = reopened
        .getBranch()
        .flatMap((event) =>
          event.type === "message" && event.message.role === "user" ? [event.message] : [],
        );
      expect(users.slice(1)).toMatchObject(
        inputs.map(({ text, idempotencyKey }) => ({
          role: "user",
          content: text,
          idempotencyKey,
          __openclaw: { steerTargetRunId: "active-run" },
        })),
      );
      expect(recorders.every(({ recorder }) => recorder.isPendingInputConsumed?.())).toBe(true);
    } finally {
      releaseTool.resolve();
      await Promise.allSettled([active, ...attempts.map((attempt) => attempt.outcome)]);
      unsubscribe();
      operation.complete();
      session.dispose();
      await transcript.transcriptLifecycle.dispose();
    }
  });
});
