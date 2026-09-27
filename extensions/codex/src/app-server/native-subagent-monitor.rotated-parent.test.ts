import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  isCodexAppServerLiveThreadClaimed,
} from "./client-runtime.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import { defaultNativeSubagentMonitorRuntime } from "./native-subagent-monitor-runtime.js";
import type { NativeSubagentMonitorRuntime } from "./native-subagent-monitor-types.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  childTurnCompletedNotification,
  createClient,
  notifyChildStarted,
  registerCodexNativeSubagentMonitor,
  successfulSendInputOutput,
  turnStartedNotification,
  threadRead,
  observeCompletionAttempts,
} from "./native-subagent-monitor.test-support.js";
import { matchesCodexNativeSubagentSubmissionBinding } from "./session-binding-record.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createCodexAppServerBindingStore,
} from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";

it.each([
  "completed",
  "interrupted",
  "foreign-lifecycle",
  "foreign-connection",
  "missing-history",
  "finishes-after-registration",
  "terminal-still-delivering",
  "active-followup-still-delivering",
  "retired-before-admission",
  "retired-during-receipt-write",
  "cold-restart-still-delivering",
  "cold-restart-after-predecessor-recovery",
  "output-during-receiver-read",
  "turn-packets-during-first-read",
  "retired-during-first-read",
  "closed-during-first-read",
] as const)(
  "preserves saved assignments when a rotated parent resumes a receiver (%s)",
  async (scenario) => {
    await withStateDirEnv("codex-rotated-receiver-", async ({ stateDir }) => {
      const completions = observeCompletionAttempts();
      const identity = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "parent-session",
        sessionKey: "agent:main:rotated-receiver",
      };
      const storePath = path.join(stateDir, "sessions.json");
      const config = { session: { store: storePath } };
      const sessionTarget = { ...identity, storePath };
      await upsertSessionEntry({
        agentId: identity.agentId,
        sessionKey: identity.sessionKey,
        storePath,
        entry: { sessionId: identity.sessionId, lifecycleRevision: "same-lifecycle", updatedAt: 1 },
      });
      const openBindingStore = () =>
        createCodexAppServerBindingStore(
          createCodexSqliteTestBindingStateStore({
            namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
            maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
            overflowPolicy: "reject-new",
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          }),
        );
      let bindingStore = openBindingStore();
      const initialBinding = {
        threadId: "parent-thread",
        cwd: stateDir,
        appServerRuntimeFingerprint: "same-native-connection",
      };
      await bindingStore.mutate(identity, { kind: "set", binding: initialBinding });
      const initialOwner = createCodexNativeSubagentHistoryOwner({
        parentThreadId: initialBinding.threadId,
        sessionId: identity.sessionId,
        lifecycleRevision: "same-lifecycle",
        binding: initialBinding,
      });
      if (!initialOwner) {
        throw new Error("Initial native owner missing.");
      }
      const hostParams = { ...identity, sessionTarget, config };
      const firstHost = await createAdmittedHostCapabilityTestFixture({
        ...hostParams,
        runId: "first-parent-run",
      });
      const firstScope = firstHost.agentHarnessTaskRuntimeScope;
      if (!firstScope) {
        throw new Error("Initial task scope missing.");
      }
      const first = createClient();
      const dispatchRequest = first.request.getMockImplementation()!;
      const unsubscribe = vi.fn();
      first.request.mockImplementation((method, params, options) => {
        if (method === "thread/unsubscribe") {
          unsubscribe(params);
          return {};
        }
        return dispatchRequest(method, params, options);
      });
      ensureCodexAppServerClientRuntime(first.client, { agentDir: stateDir });
      first.setThreadRead("child-thread", threadRead({ turnId: "turn-a", result: "A result" }));
      const retireBeforeAdmission =
        scenario === "retired-before-admission" || scenario === "retired-during-receipt-write";
      const coldRestart =
        scenario === "cold-restart-still-delivering" ||
        scenario === "cold-restart-after-predecessor-recovery";
      const holdInitialDelivery =
        scenario === "finishes-after-registration" ||
        scenario === "output-during-receiver-read" ||
        scenario === "terminal-still-delivering" ||
        scenario === "active-followup-still-delivering" ||
        coldRestart ||
        retireBeforeAdmission;
      let releasePredecessorRecovery = () => {};
      let releaseReceiptWrite!: () => void;
      const receiptWriteGate = new Promise<void>((resolve) => {
        releaseReceiptWrite = resolve;
      });
      let signalReceiptWrite!: () => void;
      const receiptWriteEntered = new Promise<void>((resolve) => {
        signalReceiptWrite = resolve;
      });
      let receiptWrite: Promise<boolean> | undefined;
      const receiptConsumption = createDeferred<{ pending: Promise<boolean> }>();
      let releaseInitialDelivery!: () => void;
      const initialDeliveryGate = new Promise<void>((resolve) => {
        releaseInitialDelivery = resolve;
      });
      let signalInitialDelivery!: () => void;
      const initialDeliveryEntered = new Promise<void>((resolve) => {
        signalInitialDelivery = resolve;
      });
      let initialDelivery:
        | ReturnType<NativeSubagentMonitorRuntime["deliverAgentHarnessTaskCompletion"]>
        | undefined;
      const deliver = vi.fn<NativeSubagentMonitorRuntime["deliverAgentHarnessTaskCompletion"]>(
        (params) => {
          const delivery = (async (): ReturnType<
            NativeSubagentMonitorRuntime["deliverAgentHarnessTaskCompletion"]
          > => {
            if (holdInitialDelivery && params.result === "A result") {
              signalInitialDelivery();
              await initialDeliveryGate;
              if (coldRestart) {
                // End the old delivery owner without settling its durable pending result.
                return { delivered: false, path: "direct" as const, recoveryBlocked: true };
              }
            }
            return { delivered: true, path: "direct" as const };
          })();
          if (params.result === "A result") {
            initialDelivery ??= delivery;
          }
          return delivery;
        },
      );
      const firstRead =
        scenario === "turn-packets-during-first-read" ||
        scenario === "retired-during-first-read" ||
        scenario === "closed-during-first-read";
      const closesDuringFirstRead =
        scenario === "retired-during-first-read" || scenario === "closed-during-first-read";
      const gatesRead = firstRead || scenario === "output-during-receiver-read";
      const readEntered = createDeferred<void>();
      const releaseRead = createDeferred<void>();
      let holdNextRead = false;
      let readHeld = false;
      const runtime: NativeSubagentMonitorRuntime = {
        ...defaultNativeSubagentMonitorRuntime,
        deliverAgentHarnessTaskCompletion: deliver,
        ...(gatesRead
          ? {
              createAgentHarnessTaskRuntime: (
                params: Parameters<
                  NativeSubagentMonitorRuntime["createAgentHarnessTaskRuntime"]
                >[0],
              ) => {
                const tasks =
                  defaultNativeSubagentMonitorRuntime.createAgentHarnessTaskRuntime(params);
                return {
                  ...tasks,
                  prepareTaskRecordsRead: async () => {
                    // An already-running registration read must not consume the next phase's gate.
                    const hold = holdNextRead;
                    holdNextRead = false;
                    const read = await tasks.prepareTaskRecordsRead!();
                    if (hold) {
                      readHeld = true;
                      readEntered.resolve();
                      await releaseRead.promise;
                    }
                    return read;
                  },
                };
              },
            }
          : {}),
      };
      const initialParent = await registerCodexNativeSubagentMonitor({
        client: first.client,
        parentThreadId: initialBinding.threadId,
        requesterSessionKey: identity.sessionKey,
        taskRuntimeScope: firstScope,
        historyOwner: scenario === "missing-history" ? undefined : initialOwner,
        runtime,
      });
      let secondHost:
        | Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>
        | undefined;
      let resumedHost: typeof secondHost;
      let currentParent: Awaited<ReturnType<typeof registerCodexNativeSubagentMonitor>> | undefined;
      let retirement: Promise<void> | undefined;
      let submissionNotification: Promise<void> | undefined;
      let current = first;
      let database: DatabaseSync | undefined;
      let testFailure: { error: unknown } | undefined;
      const cleanupFailures: unknown[] = [];
      const readPhaseNotifications: Promise<unknown>[] = [];
      const rows = () =>
        database!.prepare("SELECT * FROM task_runs ORDER BY created_at, task_id").all();
      const initialRunId = "codex-thread:child-thread";
      const followupRunId = "codex-thread:child-thread:turn:turn-b";
      const collab = async (parentThreadId: string, tool: string, id: string, result?: string) => {
        for (const phase of ["started", "completed"] as const) {
          await current.notify({
            method: `item/${phase}`,
            params: {
              threadId: parentThreadId,
              turnId: parentThreadId === "parent-thread" ? "parent-a" : "parent-b",
              item: {
                id,
                type: "collabAgentToolCall",
                tool,
                status: phase === "started" ? "inProgress" : "completed",
                senderThreadId: parentThreadId,
                receiverThreadIds: ["child-thread"],
                agentsStates:
                  phase === "started"
                    ? {}
                    : {
                        "child-thread": result
                          ? { status: "completed", message: result }
                          : { status: "running" },
                      },
              },
            },
          });
        }
      };
      const runScenario = async () => {
        initialParent.bindTurn("parent-a");
        if (firstRead) {
          database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
            readOnly: true,
          });
          holdNextRead = true;
          const discovery = notifyChildStarted(first);
          readPhaseNotifications.push(discovery);
          await Promise.race([readEntered.promise, discovery]);
          expect(readHeld).toBe(true);
          expect(rows()).toEqual([]);
          expect(isCodexAppServerLiveThreadClaimed(first.client, "child-thread")).toBe(false);
          const completion = closesDuringFirstRead ? undefined : completions.next(initialRunId);
          if (scenario === "retired-during-first-read") {
            retirement = codexNativeSubagentMonitorRuntime.retireParent(
              first.client,
              "parent-thread",
            );
          } else if (scenario === "closed-during-first-read") {
            readPhaseNotifications.push(
              first.notify({ method: "thread/closed", params: { threadId: "child-thread" } }),
            );
          }
          readPhaseNotifications.push(
            first.notify(turnStartedNotification("turn-a")),
            first.notify(
              childTurnCompletedNotification({
                turnId: "turn-a",
                status: "completed",
                items: [{ id: "a-result", type: "agentMessage", text: "A result" }],
              }),
            ),
          );
          releaseRead.resolve();
          await Promise.all(readPhaseNotifications);
          await retirement;
          await completion;
          if (scenario !== "retired-during-first-read") {
            await initialParent.unregister();
          }
          await completions.settle();
          if (closesDuringFirstRead) {
            expect(rows()).toEqual([]);
            expect(deliver).not.toHaveBeenCalled();
            expect(isCodexAppServerLiveThreadClaimed(first.client, "child-thread")).toBe(false);
          } else {
            expect(rows()).toEqual([
              expect.objectContaining({
                run_id: initialRunId,
                status: "succeeded",
                delivery_status: "delivered",
                terminal_summary: "A result",
              }),
            ]);
            expect(deliver).toHaveBeenCalledOnce();
          }
          return;
        }
        const initialCompletion =
          scenario === "interrupted" ? undefined : completions.next(initialRunId);
        await notifyChildStarted(first);
        await first.notify(turnStartedNotification("turn-a"));
        await first.notify(
          childTurnCompletedNotification({
            turnId: "turn-a",
            status: scenario === "interrupted" ? "interrupted" : "completed",
            items:
              scenario === "interrupted"
                ? []
                : [{ id: "a-result", type: "agentMessage", text: "A result" }],
          }),
        );
        await initialCompletion;
        await completions.settle(initialRunId);
        if (scenario !== "interrupted" && !holdInitialDelivery) {
          await collab("parent-thread", "wait", "wait-a", "A result");
        }
        await initialParent.unregister();
        if (holdInitialDelivery) {
          await initialDeliveryEntered;
        } else {
          await completions.settle();
        }
        database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
          readOnly: true,
        });
        let initialRows = rows();
        expect(initialRows).toHaveLength(1);
        const initialTaskId = initialRows[0]!.task_id;
        expect(initialRows[0]).toMatchObject({
          run_id: initialRunId,
          status: scenario === "interrupted" ? "running" : "succeeded",
        });
        const finishInitialDelivery = async () => {
          const previous = initialRows[0]!;
          expect(previous).toMatchObject({
            status: "succeeded",
            delivery_status: "pending",
            terminal_summary: "A result",
          });
          releaseInitialDelivery();
          await initialDelivery;
          await completions.settle(initialRunId);
          const settled = rows().find((row) => row.task_id === previous.task_id)!;
          expect(settled).toMatchObject({
            task_id: previous.task_id,
            run_id: initialRunId,
            status: "succeeded",
            delivery_status: "delivered",
            terminal_summary: "A result",
            detail_json: previous.detail_json,
          });
          initialRows = [settled];
        };
        if (scenario === "interrupted" || scenario === "foreign-connection") {
          first.close();
          current = createClient();
          ensureCodexAppServerClientRuntime(current.client, { agentDir: stateDir });
        }
        const nextBinding = {
          ...initialBinding,
          threadId: "rotated-parent",
          ...(scenario === "foreign-connection"
            ? { appServerRuntimeFingerprint: "different-native-connection" }
            : {}),
        };
        const lifecycleRevision =
          scenario === "foreign-lifecycle" ? "different-lifecycle" : "same-lifecycle";
        await upsertSessionEntry({
          agentId: identity.agentId,
          sessionKey: identity.sessionKey,
          storePath,
          entry: { sessionId: identity.sessionId, lifecycleRevision, updatedAt: 2 },
        });
        await bindingStore.mutate(identity, { kind: "set", binding: nextBinding });
        const owner = createCodexNativeSubagentHistoryOwner({
          parentThreadId: nextBinding.threadId,
          sessionId: identity.sessionId,
          lifecycleRevision,
          binding: nextBinding,
        });
        if (!owner) {
          throw new Error("Rotated native owner missing.");
        }
        secondHost = await createAdmittedHostCapabilityTestFixture({
          ...hostParams,
          runId: "second-parent-run",
        });
        const scope = secondHost.agentHarnessTaskRuntimeScope;
        if (!scope) {
          throw new Error("Rotated task scope missing.");
        }
        current.setThreadRead(
          "child-thread",
          threadRead({
            turnId: "turn-a",
            status: scenario === "interrupted" ? "interrupted" : "completed",
            result: scenario === "interrupted" ? undefined : "A result",
          }),
        );
        const rotatedRegistration: Parameters<typeof registerCodexNativeSubagentMonitor>[0] = {
          client: current.client,
          parentThreadId: nextBinding.threadId,
          requesterSessionKey: identity.sessionKey,
          taskRuntimeScope: scope,
          historyOwner: owner,
          submissionStore: {
            assertCurrent: () => {
              const binding = bindingStore.read(identity);
              if (!binding || !matchesCodexNativeSubagentSubmissionBinding(binding, owner)) {
                throw new Error("Rotated binding changed.");
              }
            },
            read: () => bindingStore.readNativeSubagentSubmissions(identity, owner),
            record: (receipt, guard) => {
              receiptWrite = (async () => {
                signalReceiptWrite();
                if (scenario === "retired-during-receipt-write") {
                  await receiptWriteGate;
                }
                return bindingStore.mutate(
                  identity,
                  { kind: "record-native-subagent-submission", owner, receipt },
                  guard,
                );
              })();
              return receiptWrite;
            },
            consume: (receipt, guard) => {
              const pending = bindingStore.mutate(
                identity,
                { kind: "consume-native-subagent-submission", owner, receipt },
                guard,
              );
              receiptConsumption.resolve({ pending });
              return pending;
            },
          },
          runtime,
        };
        currentParent = await registerCodexNativeSubagentMonitor(rotatedRegistration);
        currentParent.bindTurn("parent-b");
        if (
          scenario === "finishes-after-registration" ||
          scenario === "output-during-receiver-read"
        ) {
          await finishInitialDelivery();
        }
        if (scenario === "output-during-receiver-read") {
          holdNextRead = true;
          const call = current.notify({
            method: "item/completed",
            params: {
              threadId: "rotated-parent",
              turnId: "parent-b",
              item: {
                id: "send-b",
                type: "collabAgentToolCall",
                tool: "sendInput",
                status: "completed",
                senderThreadId: "rotated-parent",
                receiverThreadIds: ["child-thread"],
                agentsStates: { "child-thread": { status: "running" } },
              },
            },
          });
          readPhaseNotifications.push(call);
          await Promise.race([readEntered.promise, call]);
          expect(readHeld).toBe(true);
        } else {
          await collab(
            "rotated-parent",
            "resumeAgent",
            "resume-c",
            scenario === "interrupted" ? undefined : "A result",
          );
          await collab("rotated-parent", "sendInput", "send-b");
        }
        submissionNotification = current.notify(
          successfulSendInputOutput({
            parentThreadId: "rotated-parent",
            turnId: "parent-b",
            callId: "send-b",
            submissionId: "turn-b",
          }),
        );
        if (scenario === "output-during-receiver-read") {
          expect(rows()).toEqual(initialRows);
          releaseRead.resolve();
          await Promise.all(readPhaseNotifications);
        }
        if (scenario !== "retired-during-receipt-write") {
          await submissionNotification;
        }
        if (coldRestart) {
          await receiptWriteEntered;
          await expect(receiptWrite).resolves.toBe(true);
          const savedReceipts = bindingStore.readNativeSubagentSubmissions(identity, owner);
          expect(savedReceipts).toEqual([
            {
              parentTurnId: "parent-b",
              callId: "send-b",
              childThreadId: "child-thread",
              submissionId: "turn-b",
              predecessorRunId: initialRunId,
              predecessorNativeTurnId: "turn-a",
            },
          ]);
          expect(rows()).toEqual(initialRows);
          first.close();
          releaseInitialDelivery();
          await initialDelivery;
          await completions.settle();
          await currentParent.unregister();
          firstHost.closeHost();
          firstHost.closeAdmission();
          secondHost.closeHost();
          secondHost.closeAdmission();
          expect(rows()).toEqual(initialRows);
          database.close();
          database = undefined;
          await closeOpenClawStateDatabaseAsync();
          resetPluginStateStoreForTests();
          bindingStore = openBindingStore();
          expect(bindingStore.readNativeSubagentSubmissions(identity, owner)).toEqual(
            savedReceipts,
          );
          resumedHost = await createAdmittedHostCapabilityTestFixture({
            ...hostParams,
            runId: "cold-resumed-parent-run",
          });
          const resumedScope = resumedHost.agentHarnessTaskRuntimeScope;
          if (!resumedScope) {
            throw new Error("Cold resumed task scope missing.");
          }
          current = createClient();
          const resumedRequest = current.request.getMockImplementation()!;
          current.request.mockImplementation((method, params, options) =>
            method === "thread/unsubscribe" ? {} : resumedRequest(method, params, options),
          );
          ensureCodexAppServerClientRuntime(current.client, { agentDir: stateDir });
          await expect(
            claimCodexAppServerLiveThread(current.client, nextBinding.threadId),
          ).resolves.toBeDefined();
          const history = threadRead({
            turnId: "turn-b",
            result: "B result",
            previousResult: "A result",
          });
          history.thread.turns![0]!.id = "turn-a";
          history.thread.turns![0]!.completedAt = Number(initialRows[0]!.ended_at) / 1000;
          const predecessorRecovered = new Promise<void>((resolve) => {
            releasePredecessorRecovery = resolve;
          });
          let historyReads = 0;
          current.setThreadReadFactory("child-thread", async () => {
            const readIndex = historyReads++;
            if (scenario === "cold-restart-after-predecessor-recovery" && readIndex > 0) {
              await predecessorRecovered;
            }
            return history;
          });
          database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
            readOnly: true,
          });
          const resumedDelivery = vi.fn<
            NativeSubagentMonitorRuntime["deliverAgentHarnessTaskCompletion"]
          >(async (params) => {
            if (params.result === "A result") {
              releasePredecessorRecovery();
              return { delivered: false, path: "direct", recoveryPending: true };
            }
            return { delivered: true, path: "direct" };
          });
          const resumedCompletion = completions.next(followupRunId);
          currentParent = await registerCodexNativeSubagentMonitor({
            ...rotatedRegistration,
            client: current.client,
            taskRuntimeScope: resumedScope,
            runtime: {
              ...defaultNativeSubagentMonitorRuntime,
              deliverAgentHarnessTaskCompletion: resumedDelivery,
            },
          });
          currentParent.bindTurn("cold-parent-turn");
          await currentParent.unregister();
          const { pending } = await receiptConsumption.promise;
          await expect(pending).resolves.toBe(true);
          await resumedCompletion;
          await completions.settle();
          expect({
            successor: rows().find((row) => row.run_id === followupRunId),
            pendingReceipts: bindingStore.readNativeSubagentSubmissions(identity, owner),
          }).toMatchObject({
            successor: {
              status: "succeeded",
              delivery_status: "delivered",
              terminal_summary: "B result",
            },
            pendingReceipts: [],
          });
          expect(rows().find((row) => row.run_id === initialRunId)).toEqual(initialRows[0]);
          const followup = rows().find((row) => row.run_id === followupRunId)!;
          expect(JSON.parse(String(followup.detail_json))).toMatchObject({
            nativeTurnId: "turn-b",
            nativeHistory: initialOwner,
          });
          return;
        }
        if (retireBeforeAdmission) {
          await receiptWriteEntered;
          if (scenario === "retired-before-admission") {
            await receiptWrite;
          }
          expect(rows()).toEqual(initialRows);
          expect(isCodexAppServerLiveThreadClaimed(current.client, "child-thread")).toBe(true);
          retirement = codexNativeSubagentMonitorRuntime.retireParent(
            current.client,
            "rotated-parent",
          );
          if (scenario === "retired-during-receipt-write") {
            expect(isCodexAppServerLiveThreadClaimed(current.client, "child-thread")).toBe(true);
            expect(unsubscribe).not.toHaveBeenCalled();
            releaseReceiptWrite();
            await expect(receiptWrite).rejects.toThrow("parent generation is no longer current");
            await submissionNotification;
          }
          await currentParent.unregister();
          await retirement;
          expect(isCodexAppServerLiveThreadClaimed(current.client, "child-thread")).toBe(false);
          expect(unsubscribe).toHaveBeenCalledExactlyOnceWith({ threadId: "child-thread" });
          const retired = rows();
          expect(retired).toHaveLength(1);
          expect(retired[0]!.last_event_at).toBeGreaterThan(Number(initialRows[0]!.last_event_at));
          expect(retired[0]).toEqual({
            ...initialRows[0],
            delivery_status: "failed",
            error: "Subagent parent session ended.",
            last_event_at: retired[0]!.last_event_at,
          });
          releaseInitialDelivery();
          await initialDelivery;
          await completions.settle();
          expect(rows()).toEqual(retired);
          expect(unsubscribe).toHaveBeenCalledOnce();
          return;
        }
        let claimedAfterInitialDelivery: boolean | undefined;
        if (scenario === "terminal-still-delivering") {
          expect(rows().find((row) => row.task_id === initialRows[0]!.task_id)).toEqual(
            initialRows[0],
          );
          expect(isCodexAppServerLiveThreadClaimed(current.client, "child-thread")).toBe(true);
          await finishInitialDelivery();
          claimedAfterInitialDelivery = isCodexAppServerLiveThreadClaimed(
            current.client,
            "child-thread",
          );
        }
        await current.notify(turnStartedNotification("turn-b"));
        if (scenario === "active-followup-still-delivering") {
          await finishInitialDelivery();
          claimedAfterInitialDelivery = isCodexAppServerLiveThreadClaimed(
            current.client,
            "child-thread",
          );
          expect(unsubscribe).not.toHaveBeenCalled();
        }
        const afterStart = rows();
        const completedHistory = threadRead({
          turnId: "turn-b",
          result: "B result",
          previousResult: "A result",
        });
        completedHistory.thread.turns![0]!.id = "turn-a";
        if (scenario === "interrupted") {
          completedHistory.thread.turns![0]!.status = "interrupted";
        }
        current.setThreadRead("child-thread", completedHistory);
        const followupCompletion =
          scenario === "interrupted" || scenario === "completed" || holdInitialDelivery
            ? completions.next(scenario === "interrupted" ? initialRunId : followupRunId)
            : undefined;
        await current.notify(
          childTurnCompletedNotification({
            turnId: "turn-b",
            status: "completed",
            items: [{ id: "b-result", type: "agentMessage", text: "B result" }],
          }),
        );
        await followupCompletion;
        await collab("rotated-parent", "wait", "wait-b", "B result");
        await currentParent.unregister();
        await completions.settle();
        const after = rows();
        if (scenario === "interrupted") {
          expect(after).toHaveLength(1);
          expect(after[0]).toMatchObject({
            task_id: initialRows[0]!.task_id,
            run_id: initialRunId,
            status: "succeeded",
            terminal_summary: "B result",
          });
        } else {
          expect(afterStart.find((row) => row.task_id === initialTaskId)).toEqual(initialRows[0]);
          expect(after.find((row) => row.task_id === initialTaskId)).toEqual(initialRows[0]);
          if (scenario === "completed" || holdInitialDelivery) {
            expect(after).toHaveLength(2);
            expect(after.find((row) => row.run_id === followupRunId)).toMatchObject({
              status: "succeeded",
              terminal_summary: "B result",
            });
            const followup = after.find((row) => row.run_id === followupRunId)!;
            expect(JSON.parse(String(followup.detail_json))).toMatchObject({
              nativeTurnId: "turn-b",
              nativeHistory: initialOwner,
            });
            if (scenario === "output-during-receiver-read") {
              expect(followup.delivery_status).toBe("delivered");
              expect(bindingStore.readNativeSubagentSubmissions(identity, owner)).toEqual([]);
            }
            if (
              scenario === "terminal-still-delivering" ||
              scenario === "active-followup-still-delivering"
            ) {
              expect(claimedAfterInitialDelivery).toBe(true);
            }
            if (holdInitialDelivery) {
              expect(
                deliver.mock.calls.filter(([params]) => params.result === "A result"),
              ).toHaveLength(1);
            }
          } else {
            expect(after).toEqual(initialRows);
          }
        }
      };
      try {
        await runScenario();
      } catch (error) {
        testFailure = { error };
      } finally {
        releaseRead.resolve();
        releasePredecessorRecovery();
        releaseReceiptWrite();
        releaseInitialDelivery();
        const outcomes = await Promise.allSettled([
          ...readPhaseNotifications,
          receiptWrite?.catch((error: unknown) => {
            if (
              scenario !== "retired-during-receipt-write" ||
              !(error instanceof Error) ||
              !error.message.includes("parent generation is no longer current")
            ) {
              throw error;
            }
          }),
          submissionNotification,
          initialDelivery,
          retirement,
        ]);
        cleanupFailures.push(
          ...outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : [])),
        );
        const cleanups: Array<() => void | Promise<void>> = [
          () =>
            coldRestart
              ? codexNativeSubagentMonitorRuntime.retireParent(current.client, "rotated-parent")
              : undefined,
          () => first.close(),
          () => current.close(),
          () => initialParent.unregister(),
          () => currentParent?.unregister(),
          () => completions.settle(),
          () => database?.close(),
          () => secondHost?.closeHost(),
          () => secondHost?.closeAdmission(),
          () => resumedHost?.closeHost(),
          () => resumedHost?.closeAdmission(),
          () => firstHost.closeHost(),
          () => firstHost.closeAdmission(),
          () => closeOpenClawStateDatabaseAsync(),
          () => resetPluginStateStoreForTests(),
        ];
        for (const cleanup of cleanups) {
          try {
            await cleanup();
          } catch (error) {
            cleanupFailures.push(error);
          }
        }
      }
      if (cleanupFailures.length) {
        throw new AggregateError(
          [...(testFailure ? [testFailure.error] : []), ...cleanupFailures],
          "Native receiver preparation fixture did not settle cleanly.",
        );
      }
      if (testFailure) {
        throw testFailure.error;
      }
    });
  },
);
