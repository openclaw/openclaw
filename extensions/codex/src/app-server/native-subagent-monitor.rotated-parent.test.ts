import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentHarnessTaskRecord } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
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
  createRecordedRuntime,
  createTaskScope,
  nativeHistoryOwner,
  notifyChildStarted,
  registerCodexNativeSubagentMonitor,
  successfulSendInputOutput,
  turnStartedNotification,
  threadRead,
} from "./native-subagent-monitor.test-support.js";
import { matchesCodexNativeSubagentSubmissionBinding } from "./session-binding-record.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createCodexAppServerBindingStore,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";

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
] as const)(
  "preserves saved assignments when a rotated parent resumes a receiver (%s)",
  async (scenario) => {
    await withStateDirEnv("codex-rotated-receiver-", async ({ stateDir }) => {
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
          createPluginStateSyncKeyedStoreForTests<StoredCodexAppServerBinding>("codex", {
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
      const runtime = {
        ...defaultNativeSubagentMonitorRuntime,
        deliverAgentHarnessTaskCompletion: deliver,
      };
      const initialParent = registerCodexNativeSubagentMonitor({
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
      let currentParent: ReturnType<typeof registerCodexNativeSubagentMonitor> | undefined;
      let current = first;
      let database: DatabaseSync | undefined;
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
      try {
        initialParent.bindTurn("parent-a");
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
        if (scenario !== "interrupted" && !holdInitialDelivery) {
          await collab("parent-thread", "wait", "wait-a", "A result");
        }
        await initialParent.unregister();
        if (holdInitialDelivery) {
          await initialDeliveryEntered;
        }
        database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
          readOnly: true,
        });
        const rows = () =>
          database!.prepare("SELECT * FROM task_runs ORDER BY created_at, task_id").all();
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
          // Let the completion owner's queued subscription transition settle before sampling it.
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
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
            consume: (receipt, guard) =>
              bindingStore.mutate(
                identity,
                { kind: "consume-native-subagent-submission", owner, receipt },
                guard,
              ),
          },
          runtime,
        };
        currentParent = registerCodexNativeSubagentMonitor(rotatedRegistration);
        currentParent.bindTurn("parent-b");
        if (scenario === "finishes-after-registration") {
          await finishInitialDelivery();
        }
        await collab(
          "rotated-parent",
          "resumeAgent",
          "resume-c",
          scenario === "interrupted" ? undefined : "A result",
        );
        await collab("rotated-parent", "sendInput", "send-b");
        await current.notify(
          successfulSendInputOutput({
            parentThreadId: "rotated-parent",
            turnId: "parent-b",
            callId: "send-b",
            submissionId: "turn-b",
          }),
        );
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
          await currentParent.unregister();
          firstHost.closeHost();
          firstHost.closeAdmission();
          secondHost.closeHost();
          secondHost.closeAdmission();
          expect(rows()).toEqual(initialRows);
          database.close();
          database = undefined;
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
          currentParent = registerCodexNativeSubagentMonitor({
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
          await vi.waitFor(() => {
            expect(rows().find((row) => row.run_id === initialRunId)).toEqual(initialRows[0]);
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
          });
          expect(rows().find((row) => row.run_id === initialRunId)).toEqual(initialRows[0]);
          const followup = rows().find((row) => row.run_id === followupRunId)!;
          expect(JSON.parse(String(followup.detail_json))).toMatchObject({
            nativeTurnId: "turn-b",
            nativeHistory: initialOwner,
          });
          expect(bindingStore.readNativeSubagentSubmissions(identity, owner)).toEqual([]);
          return;
        }
        if (retireBeforeAdmission) {
          await receiptWriteEntered;
          if (scenario === "retired-before-admission") {
            await receiptWrite;
          }
          expect(rows()).toEqual(initialRows);
          expect(isCodexAppServerLiveThreadClaimed(current.client, "child-thread")).toBe(true);
          codexNativeSubagentMonitorRuntime.retireParent(current.client, "rotated-parent");
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          if (scenario === "retired-during-receipt-write") {
            expect(isCodexAppServerLiveThreadClaimed(current.client, "child-thread")).toBe(true);
            expect(unsubscribe).not.toHaveBeenCalled();
            releaseReceiptWrite();
            await expect(receiptWrite).rejects.toThrow("parent generation is no longer current");
          }
          await currentParent.unregister();
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
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
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
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
        await current.notify(
          childTurnCompletedNotification({
            turnId: "turn-b",
            status: "completed",
            items: [{ id: "b-result", type: "agentMessage", text: "B result" }],
          }),
        );
        await collab("rotated-parent", "wait", "wait-b", "B result");
        await currentParent.unregister();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
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
      } finally {
        releasePredecessorRecovery();
        releaseReceiptWrite();
        releaseInitialDelivery();
        await receiptWrite?.catch(() => undefined);
        await initialDelivery;
        if (coldRestart) {
          codexNativeSubagentMonitorRuntime.retireParent(current.client, "rotated-parent");
        }
        first.close();
        current.close();
        await initialParent.unregister();
        await currentParent?.unregister();
        database?.close();
        secondHost?.closeHost();
        secondHost?.closeAdmission();
        resumedHost?.closeHost();
        resumedHost?.closeAdmission();
        firstHost.closeHost();
        firstHost.closeAdmission();
        resetPluginStateStoreForTests();
      }
    });
  },
);

it.each([
  "before-successor",
  "during-successor",
  "foreign-observer",
  "changed-observer-session",
  "changed-observer-lifecycle",
  "changed-observer-connection",
  "changed-delivery-owner",
  "replaced-task",
  "unrelated-result",
  "old-parent-push",
])("settles retained predecessor receipts through a rotated parent (%s)", async (scenario) => {
  const client = createClient();
  const request = client.request.getMockImplementation()!;
  client.request.mockImplementation(async (method, params) =>
    method === "thread/unsubscribe" ? {} : request(method, params),
  );
  client.setThreadRead("child-thread", threadRead({ turnId: "turn-a", result: "A result" }));
  const records = new Map<string, AgentHarnessTaskRecord>();
  const runtime = createRecordedRuntime(records);
  const createTask = runtime.createRunningTaskRun.getMockImplementation()!;
  // Persisted task metadata must not alias a live registration's owner object.
  runtime.createRunningTaskRun.mockImplementation((params) => createTask(structuredClone(params)));
  runtime.deliverAgentHarnessTaskCompletion.mockResolvedValue({
    delivered: false,
    path: "direct",
    recoveryPending: true,
  });
  ensureCodexAppServerClientRuntime(client.client, { agentDir: "/tmp/agent" });
  const initialHistory = nativeHistoryOwner();
  const observerHistory = nativeHistoryOwner("rotated-parent");
  const registration = {
    client: client.client,
    requesterSessionKey: "agent:main:discord:channel:C123",
    taskRuntimeScope: createTaskScope(),
    runtime,
  };
  const initial = codexNativeSubagentMonitorRuntime.register({
    ...registration,
    parentThreadId: "parent-thread",
    historyOwner: initialHistory,
  });
  let observer: ReturnType<typeof codexNativeSubagentMonitorRuntime.register> | undefined;
  let foreign: ReturnType<typeof codexNativeSubagentMonitorRuntime.register> | undefined;
  const firstRunId = "codex-thread:child-thread";
  const secondRunId = "codex-thread:child-thread:turn:turn-b";
  const collab = (parentThreadId: string, tool: string, result?: string) =>
    client.notify({
      method: "item/completed",
      params: {
        threadId: parentThreadId,
        turnId: "observer-turn",
        item: {
          id: `${tool}-${parentThreadId}`,
          type: "collabAgentToolCall",
          tool,
          status: "completed",
          senderThreadId: parentThreadId,
          receiverThreadIds: ["child-thread"],
          agentsStates: {
            "child-thread": result
              ? { status: "completed", message: result }
              : { status: "running" },
          },
        },
      },
    });
  try {
    initial.bindTurn("initial-turn");
    await notifyChildStarted(client);
    await client.notify(turnStartedNotification("turn-a"));
    await client.notify(
      childTurnCompletedNotification({
        turnId: "turn-a",
        status: "completed",
        items: [{ type: "agentMessage", id: "a-final", text: "A result" }],
      }),
    );
    await initial.unregister();
    await vi.waitFor(() =>
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledOnce(),
    );
    expect(records.get(firstRunId)).toMatchObject({
      status: "succeeded",
      deliveryStatus: "pending",
      terminalSummary: "A result",
    });
    observer = codexNativeSubagentMonitorRuntime.register({
      ...registration,
      parentThreadId: "rotated-parent",
      historyOwner: observerHistory,
    });
    observer.bindTurn("observer-turn");
    await collab("rotated-parent", "resumeAgent", "A result");
    const initialRecord = structuredClone(records.get(firstRunId)!);
    if (scenario === "before-successor") {
      await collab("rotated-parent", "wait", "A result");
      expect(records.get(firstRunId)?.deliveryStatus).toBe("delivered");
    }
    await collab("rotated-parent", "sendInput");
    await client.notify(
      successfulSendInputOutput({
        parentThreadId: "rotated-parent",
        turnId: "observer-turn",
        callId: "sendInput-rotated-parent",
        submissionId: "turn-b",
      }),
    );
    await client.notify(turnStartedNotification("turn-b"));
    let secondRecord = structuredClone(records.get(secondRunId)!);
    expect(secondRecord).toMatchObject({ status: "running", runId: secondRunId });
    let receiptParent = "rotated-parent";
    if (scenario === "old-parent-push") {
      await client.notify(
        childTurnCompletedNotification({
          turnId: "turn-b",
          status: "completed",
          items: [{ type: "agentMessage", id: "b-final", text: "B result" }],
        }),
      );
      secondRecord = structuredClone(records.get(secondRunId)!);
      expect(secondRecord).toMatchObject({ status: "succeeded", deliveryStatus: "pending" });
      foreign = codexNativeSubagentMonitorRuntime.register({
        ...registration,
        parentThreadId: "parent-thread",
        historyOwner: initialHistory,
      });
      foreign.bindTurn("parent-turn");
      await client.notify({
        method: "rawResponseItem/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: '<subagent_notification>{"agent_path":"child-thread","status":{"completed":"B result"}}</subagent_notification>',
              },
            ],
            internal_chat_message_metadata_passthrough: {
              content_item_kinds: ["multi_agent.subagent_notification"],
            },
          },
        },
      });
    } else if (scenario === "foreign-observer") {
      receiptParent = "foreign-parent";
      foreign = codexNativeSubagentMonitorRuntime.register({
        ...registration,
        parentThreadId: receiptParent,
        requesterSessionKey: "agent:other:main",
        taskRuntimeScope: createTaskScope("agent:other:main"),
        historyOwner: nativeHistoryOwner(receiptParent),
      });
      foreign.bindTurn("observer-turn");
    } else if (scenario === "changed-observer-session") {
      observerHistory.sessionId = "other-physical-session";
    } else if (scenario === "changed-observer-lifecycle") {
      observerHistory.lifecycleRevision = "other-lifecycle";
    } else if (scenario === "changed-observer-connection") {
      observerHistory.connectionFingerprint = "b".repeat(64);
    } else if (scenario === "changed-delivery-owner") {
      initialHistory.sessionId = "replacement-delivery-session";
    } else if (scenario === "replaced-task") {
      records.set(firstRunId, { ...initialRecord, taskId: "replacement-task" });
    }
    if (scenario !== "before-successor" && scenario !== "old-parent-push") {
      await collab(
        receiptParent,
        "wait",
        scenario === "unrelated-result" ? "Other result" : "A result",
      );
    }
    const accepted = scenario === "before-successor" || scenario === "during-successor";
    expect(records.get(firstRunId)?.deliveryStatus).toBe(accepted ? "delivered" : "pending");
    expect(records.get(firstRunId)).toMatchObject({
      runId: firstRunId,
      status: "succeeded",
      terminalSummary: "A result",
      detail: initialRecord.detail,
    });
    expect(records.get(secondRunId)).toEqual(secondRecord);
    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledOnce();
  } finally {
    codexNativeSubagentMonitorRuntime.retireParent(client.client, "parent-thread");
    codexNativeSubagentMonitorRuntime.retireParent(client.client, "rotated-parent");
    await foreign?.unregister();
    await observer?.unregister();
    await initial.unregister();
    client.close();
  }
});
