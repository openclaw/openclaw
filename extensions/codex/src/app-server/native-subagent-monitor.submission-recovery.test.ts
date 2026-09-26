import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAgentHarnessTaskRuntime } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
} from "./client-runtime.js";
import { CodexNativeSubagentCompletionDelivery } from "./native-subagent-completion-delivery.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import { defaultNativeSubagentMonitorRuntime } from "./native-subagent-monitor-runtime.js";
import {
  childTurnCompletedNotification,
  createClient,
  notifyChildStarted,
  registerCodexNativeSubagentMonitor,
  successfulSendInputOutput,
  threadRead,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import type {
  CodexNativeSubagentSubmission,
  CodexNativeSubagentSubmissionStore,
} from "./native-subagent-submission.js";
import { matchesCodexNativeSubagentSubmissionBinding } from "./session-binding-record.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createCodexAppServerBindingStore,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";

describe("CodexNativeSubagentMonitor", () => {
  it.each([
    "admitted",
    "accepted-before-child-event",
    "delivered-with-receipt",
    "unowned",
    "replacement",
  ] as const)("recovers owned submissions after cold monitor recreation (%s)", async (scenario) => {
    await withStateDirEnv("codex-restart-gap-", async ({ stateDir }) => {
      const identity = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "parent-session",
        sessionKey: "agent:main:restart-gap",
      };
      const lifecycleRevision = "restart-gap-lifecycle";
      const storePath = path.join(stateDir, "sessions.json");
      const config = { session: { store: storePath } };
      const sessionTarget = { ...identity, storePath };
      await upsertSessionEntry({
        agentId: identity.agentId,
        sessionKey: identity.sessionKey,
        storePath,
        entry: { sessionId: identity.sessionId, lifecycleRevision, updatedAt: 1 },
      });
      const hostAttempt = {
        sessionId: identity.sessionId,
        sessionKey: identity.sessionKey,
        agentId: identity.agentId,
        sessionTarget,
        config,
      };
      const openBindingStore = () =>
        createCodexAppServerBindingStore(
          createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
            namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
            maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
            overflowPolicy: "reject-new",
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          }),
        );
      const binding = {
        threadId: "parent-thread",
        cwd: stateDir,
        appServerRuntimeFingerprint: "restart-gap-runtime",
      };
      const firstBindingStore = openBindingStore();
      await firstBindingStore.mutate(identity, { kind: "set", binding });
      const nativeHistory = createCodexNativeSubagentHistoryOwner({
        parentThreadId: binding.threadId,
        sessionId: identity.sessionId,
        lifecycleRevision,
        binding,
      });
      if (!nativeHistory) {
        throw new Error("The seeded binding must produce a history owner.");
      }
      const makeSubmissionStore = (
        store: ReturnType<typeof openBindingStore>,
        owner: typeof nativeHistory,
        onRecord?: (receipt: CodexNativeSubagentSubmission, pending: Promise<boolean>) => void,
      ): CodexNativeSubagentSubmissionStore => ({
        assertCurrent: () => {
          const current = store.read(identity);
          if (!current || !matchesCodexNativeSubagentSubmissionBinding(current, owner)) {
            throw new Error("The native subagent submission binding changed.");
          }
        },
        read: () => store.readNativeSubagentSubmissions(identity, owner),
        record: (receipt, guard) => {
          const pending = store.mutate(
            identity,
            { kind: "record-native-subagent-submission", owner, receipt },
            guard,
          );
          onRecord?.(receipt, pending);
          return pending;
        },
        consume: (receipt, guard) =>
          store.mutate(
            identity,
            { kind: "consume-native-subagent-submission", owner, receipt },
            guard,
          ),
      });
      const firstHost = await createAdmittedHostCapabilityTestFixture({
        ...hostAttempt,
        runId: "restart-gap-first-parent",
      });
      const firstScope = firstHost.agentHarnessTaskRuntimeScope;
      if (!firstScope) {
        throw new Error("task runtime scope missing");
      }
      const taskRuntime = createAgentHarnessTaskRuntime({
        runtime: "subagent",
        taskKind: "codex-native",
        scope: firstScope,
        runIdPrefix: "codex-thread:",
      });
      const first = createClient();
      first.setThreadRead("child-thread", threadRead({ turnId: "turn-a", result: "result A" }));
      ensureCodexAppServerClientRuntime(first as never, { agentDir: stateDir });
      let firstRecord: Promise<boolean> | undefined;
      let capturedReceipt: CodexNativeSubagentSubmission | undefined;
      const firstDelivery = vi.fn(async () => ({ delivered: true, path: "direct" as const }));
      const firstSubmissionStore = makeSubmissionStore(
        firstBindingStore,
        nativeHistory,
        (receipt, pending) => {
          capturedReceipt = receipt;
          firstRecord = pending;
        },
      );
      let releaseHeldConsume!: () => void;
      const consumeReleased = new Promise<void>((resolve) => {
        releaseHeldConsume = resolve;
      });
      const heldConsume = vi.fn<CodexNativeSubagentSubmissionStore["consume"]>(
        async (_receipt, guard) => {
          guard();
          await consumeReleased;
          throw new Error("Simulated receipt consume lost before commit.");
        },
      );
      if (scenario === "delivered-with-receipt") {
        firstSubmissionStore.consume = heldConsume;
      }
      const firstParent = await registerCodexNativeSubagentMonitor({
        client: first as never,
        parentThreadId: binding.threadId,
        requesterSessionKey: identity.sessionKey,
        taskRuntimeScope: firstScope,
        historyOwner: nativeHistory,
        submissionStore: firstSubmissionStore,
        agentId: identity.agentId,
        runtime: {
          ...defaultNativeSubagentMonitorRuntime,
          deliverAgentHarnessTaskCompletion: firstDelivery,
        },
      });
      const attempts = new Set<Promise<void>>();
      // oxlint-disable-next-line typescript/unbound-method -- Invoked below with .call(this, ...) to preserve the observed instance.
      const originalDelivery = CodexNativeSubagentCompletionDelivery.prototype.deliverPending;
      const observeAttempt = vi
        .spyOn(CodexNativeSubagentCompletionDelivery.prototype, "deliverPending")
        .mockImplementation(function (
          this: CodexNativeSubagentCompletionDelivery,
          state,
          child,
          trigger,
        ) {
          const attempt = originalDelivery.call(this, state, child, trigger);
          attempts.add(attempt);
          return attempt;
        });
      const settleCompletionAttempts = async () => {
        // Notification dispatch and delivery callbacks precede worker persistence.
        while (attempts.size > 0) {
          const pending = [...attempts];
          attempts.clear();
          await Promise.all(pending);
        }
      };
      let closingFirst: Promise<void> | undefined;
      const closeFirstParent = () =>
        (closingFirst ??= (async () => {
          first.close();
          releaseHeldConsume();
          try {
            await firstParent.unregister();
            await settleCompletionAttempts();
          } finally {
            firstHost.closeHost();
            firstHost.closeAdmission();
          }
        })());
      let closeDatabase: (() => void) | undefined;
      try {
        firstParent.bindTurn("parent-turn-a");
        await notifyChildStarted(first);
        await first.notify(turnStartedNotification("turn-a"));
        await first.notify(
          childTurnCompletedNotification({
            turnId: "turn-a",
            status: "completed",
            items: [{ id: "a-result", type: "agentMessage", text: "result A" }],
          }),
        );
        await first.notify({
          method: "item/completed",
          params: {
            threadId: binding.threadId,
            turnId: "parent-turn-a",
            item: {
              type: "collabAgentToolCall",
              tool: "wait",
              status: "completed",
              senderThreadId: binding.threadId,
              receiverThreadIds: ["child-thread"],
              agentsStates: { "child-thread": { status: "completed", message: "result A" } },
            },
          },
        });
        const initialRunId = "codex-thread:child-thread";
        const followupRunId = "codex-thread:child-thread:turn:turn-b";
        const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
          readOnly: true,
        });
        closeDatabase = () => database.close();
        const readRows = () =>
          database.prepare("SELECT * FROM task_runs ORDER BY created_at, task_id").all();
        await settleCompletionAttempts();
        const initial = readRows().find((row) => row.run_id === initialRunId);
        expect(initial).toMatchObject({
          status: "succeeded",
          delivery_status: "delivered",
          terminal_summary: "result A",
        });
        if (scenario !== "unowned") {
          firstParent.bindTurn("parent-turn-b");
          await first.notify({
            method: "item/completed",
            params: {
              threadId: binding.threadId,
              turnId: "parent-turn-b",
              item: {
                id: "send-b",
                type: "collabAgentToolCall",
                tool: "sendInput",
                status: "completed",
                senderThreadId: binding.threadId,
                receiverThreadIds: ["child-thread"],
                agentsStates: { "child-thread": { status: "running" } },
              },
            },
          });
          await first.notify(
            successfulSendInputOutput({
              parentThreadId: binding.threadId,
              turnId: "parent-turn-b",
              callId: "send-b",
              submissionId: "turn-b",
            }),
          );
          await vi.waitFor(() => expect(firstRecord).toBeDefined());
          await expect(firstRecord).resolves.toBe(true);
          const expectedReceipt = {
            parentTurnId: "parent-turn-b",
            callId: "send-b",
            childThreadId: "child-thread",
            submissionId: "turn-b",
            predecessorRunId: initialRunId,
            predecessorNativeTurnId: "turn-a",
          };
          expect(capturedReceipt).toEqual(expectedReceipt);
          expect(firstBindingStore.readNativeSubagentSubmissions(identity, nativeHistory)).toEqual([
            expectedReceipt,
          ]);
          if (scenario === "admitted" || scenario === "delivered-with-receipt") {
            await first.notify(turnStartedNotification("turn-b"));
            expect(taskRuntime.listTaskRecords()).toHaveLength(2);
            if (scenario === "delivered-with-receipt") {
              await vi.waitFor(() => expect(heldConsume).toHaveBeenCalledOnce());
              expect(heldConsume.mock.calls[0]?.[0]).toEqual(expectedReceipt);
              await first.notify(
                childTurnCompletedNotification({
                  turnId: "turn-b",
                  status: "completed",
                  items: [{ id: "b-result", type: "agentMessage", text: "result B" }],
                }),
              );
              await first.notify({
                method: "item/completed",
                params: {
                  threadId: binding.threadId,
                  turnId: "parent-turn-b",
                  item: {
                    type: "collabAgentToolCall",
                    tool: "wait",
                    status: "completed",
                    senderThreadId: binding.threadId,
                    receiverThreadIds: ["child-thread"],
                    agentsStates: { "child-thread": { status: "completed", message: "result B" } },
                  },
                },
              });
              await settleCompletionAttempts();
              expect(readRows().find((row) => row.run_id === followupRunId)).toMatchObject({
                status: "succeeded",
                delivery_status: "delivered",
                terminal_summary: "result B",
              });
              expect(
                firstBindingStore.readNativeSubagentSubmissions(identity, nativeHistory),
              ).toEqual([expectedReceipt]);
            }
          } else {
            expect(taskRuntime.listTaskRecords()).toHaveLength(1);
          }
        }
        const beforeRestart = readRows();
        const receiptsBeforeRestart = firstBindingStore.readNativeSubagentSubmissions(
          identity,
          nativeHistory,
        );
        expect(beforeRestart).toHaveLength(
          scenario === "admitted" || scenario === "delivered-with-receipt" ? 2 : 1,
        );
        expect(beforeRestart.find((row) => row.run_id === initialRunId)).toEqual(initial);
        expect(receiptsBeforeRestart).toHaveLength(
          scenario === "accepted-before-child-event" ||
            scenario === "replacement" ||
            scenario === "delivered-with-receipt"
            ? 1
            : 0,
        );
        await closeFirstParent();
        if (scenario === "delivered-with-receipt") {
          expect(readRows()).toEqual(beforeRestart);
          expect(firstBindingStore.readNativeSubagentSubmissions(identity, nativeHistory)).toEqual([
            capturedReceipt,
          ]);
        }
        resetPluginStateStoreForTests();

        const reopenedBindingStore = openBindingStore();
        if (
          scenario === "accepted-before-child-event" ||
          scenario === "replacement" ||
          scenario === "delivered-with-receipt"
        ) {
          expect(
            reopenedBindingStore.readNativeSubagentSubmissions(identity, nativeHistory),
          ).toEqual([capturedReceipt]);
        }
        if (scenario === "replacement") {
          await expect(
            reopenedBindingStore.mutate(identity, {
              kind: "replace-thread",
              expectedThreadId: binding.threadId,
              binding: { ...binding, threadId: "replacement-parent" },
            }),
          ).resolves.toBe(true);
          expect(
            reopenedBindingStore.readNativeSubagentSubmissions(identity, nativeHistory),
          ).toEqual([]);
        }
        const resumedBinding = reopenedBindingStore.read(identity);
        if (!resumedBinding) {
          throw new Error("The physical parent binding must survive recreation.");
        }
        const resumedHistory = createCodexNativeSubagentHistoryOwner({
          parentThreadId: resumedBinding.threadId,
          sessionId: identity.sessionId,
          lifecycleRevision,
          binding: resumedBinding,
        });
        if (!resumedHistory) {
          throw new Error("The resumed binding must produce a history owner.");
        }
        const resumedHost = await createAdmittedHostCapabilityTestFixture({
          ...hostAttempt,
          runId: "restart-gap-resumed-parent",
        });
        const resumedScope = resumedHost.agentHarnessTaskRuntimeScope;
        if (!resumedScope) {
          throw new Error("resumed task runtime scope missing");
        }
        const second = createClient();
        const history = threadRead({
          turnId: "turn-b",
          result: "result B",
          previousResult: "result A",
        });
        history.thread.turns![0]!.id = "turn-a";
        second.setThreadRead("child-thread", history);
        ensureCodexAppServerClientRuntime(second as never, { agentDir: stateDir });
        await expect(
          claimCodexAppServerLiveThread(second as never, resumedBinding.threadId),
        ).resolves.toBeDefined();
        const delivery = vi.fn(async () => ({ delivered: true, path: "direct" as const }));
        const resumedParent = await registerCodexNativeSubagentMonitor({
          client: second as never,
          parentThreadId: resumedBinding.threadId,
          requesterSessionKey: identity.sessionKey,
          taskRuntimeScope: resumedScope,
          historyOwner: resumedHistory,
          submissionStore: makeSubmissionStore(reopenedBindingStore, resumedHistory),
          agentId: identity.agentId,
          runtime: {
            ...defaultNativeSubagentMonitorRuntime,
            deliverAgentHarnessTaskCompletion: delivery,
          },
        });
        try {
          resumedParent.bindTurn("resumed-parent-turn");
          await resumedParent.unregister();
          if (scenario === "admitted" || scenario === "accepted-before-child-event") {
            await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());
          } else if (scenario === "delivered-with-receipt") {
            await vi.waitFor(() =>
              expect(
                reopenedBindingStore.readNativeSubagentSubmissions(identity, resumedHistory),
              ).toEqual([]),
            );
          }
          await settleCompletionAttempts();
          const afterRestart = readRows();
          expect(afterRestart.find((row) => row.run_id === initialRunId)).toEqual(initial);
          if (scenario === "delivered-with-receipt") {
            expect(afterRestart).toEqual(beforeRestart);
            expect(delivery).not.toHaveBeenCalled();
          } else if (scenario === "unowned" || scenario === "replacement") {
            expect(afterRestart).toHaveLength(1);
            expect(delivery).not.toHaveBeenCalled();
            expect(second.request).not.toHaveBeenCalled();
          } else {
            expect(afterRestart).toHaveLength(2);
            expect(afterRestart.find((row) => row.run_id === followupRunId)).toMatchObject({
              status: "succeeded",
              delivery_status: "delivered",
              terminal_summary: "result B",
            });
            expect(delivery).toHaveBeenCalledOnce();
            expect(
              reopenedBindingStore.readNativeSubagentSubmissions(identity, resumedHistory),
            ).toEqual([]);
          }
        } finally {
          second.close();
          try {
            await resumedParent.unregister();
            await settleCompletionAttempts();
          } finally {
            resumedHost.closeHost();
            resumedHost.closeAdmission();
          }
        }
      } finally {
        try {
          await closeFirstParent();
          await settleCompletionAttempts();
        } finally {
          closeDatabase?.();
          observeAttempt.mockRestore();
          resetPluginStateStoreForTests();
        }
      }
    });
  });
});
