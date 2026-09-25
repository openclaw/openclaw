import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { onAgentEventForRun, resetAgentEventsForTest } from "../infra/agent-events.js";
import { embeddedAgentLog } from "../plugin-sdk/agent-harness-runtime.js";
import {
  captureAgentHarnessCompletionCustody,
  captureAgentHarnessTaskAssignment,
  createAgentHarnessTaskEventSink,
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
  type AgentHarnessCompletionDelivery,
  type AgentHarnessTaskRecord,
} from "../plugin-sdk/agent-harness-task-runtime.js";
import { getGatewayContextLifetime } from "../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runOutsideGatewayRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createAgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import { getDetachedTaskLifecycleRuntime } from "../tasks/detached-task-runtime.js";
import { captureTaskDeliveryWork } from "../tasks/task-registry-delivery.test-support.js";
import { captureTaskRegistryReadFence } from "../tasks/task-registry-listener-state.js";
import { updateTask } from "../tasks/task-registry-mutation.js";
import { tasks, taskRegistryLog } from "../tasks/task-registry-state.js";
import { onTaskRegistryChange } from "../tasks/task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "../tasks/task-registry.store.sqlite.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.test-support.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "../tasks/task-runtime.test-helpers.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import { buildAnnounceIdempotencyKey } from "./announce-idempotency.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

type NativeHistoryOwner = { sessionId: string; lifecycleRevision?: string };
type NativeNotification = { method: string; params: unknown };
type NativeMonitorFixture = {
  createClient(): {
    notify(notification: NativeNotification): Promise<void>;
    setThreadReadFactory(threadId: string, read: () => Promise<unknown>): void;
  };
  CodexNativeSubagentMonitor: new (
    client: unknown,
    runtime: {
      captureAgentHarnessCompletionCustody: typeof captureAgentHarnessCompletionCustody;
      createAgentHarnessTaskEventSink: typeof createAgentHarnessTaskEventSink;
      createAgentHarnessTaskRuntime: typeof createAgentHarnessTaskRuntime;
      deliverAgentHarnessTaskCompletion: typeof deliverAgentHarnessTaskCompletion;
    },
    options: { recoveryPollDelaysMs: number[]; completionDeliveryRetryDelaysMs?: number[] },
  ) => {
    registerParent(params: {
      parentThreadId: string;
      requesterSessionKey: string;
      taskRuntimeScope: ReturnType<typeof createAgentHarnessTaskRuntimeScope>;
      agentId: string;
      historyOwner?: NativeHistoryOwner;
    }): Promise<{ bindTurn(turnId: string): void; unregister(): Promise<void> }>;
    retireParent(parentThreadId: string): void;
    dispose(): void;
  };
  directSpawnItem(version: "v2", parentThreadId: string, childThreadId: string): unknown;
  nativeCompletionNotification(params: { agentPath: string; result: string }): NativeNotification;
  turnStartedNotification(turnId: string): NativeNotification;
  childTurnCompletedNotification(params: {
    status: "completed" | "interrupted";
    items?: unknown[];
  }): NativeNotification;
  nativeHistoryOwner(): NativeHistoryOwner;
  threadRead(params: { result: string }): unknown;
};

async function loadCodexNativeSubagentMonitorTestFixture(): Promise<NativeMonitorFixture> {
  // Load the public test artifact through Vitest without importing the plugin's type graph.
  const artifact = await loadBundledPluginFacade<{
    loadCodexNativeSubagentMonitorTestFixture(): Promise<NativeMonitorFixture>;
  }>({ pluginId: "codex", artifactBasename: "test-api.js" });
  return await artifact.loadCodexNativeSubagentMonitorTestFixture();
}

afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  resetGatewayWorkAdmission();
});

describe("native task event custody", () => {
  it.each([
    "raw",
    "published",
    "foreground",
    "retry",
    "metadata",
    "revoked",
    "unsupported",
    "runtime-retired",
    "interrupted-replaced",
  ] as const)("keeps original assignment ownership through %s completion", async (ordering) => {
    const fixture = await loadCodexNativeSubagentMonitorTestFixture();
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      resetTaskRegistryForTests({ persist: false });
      using notifications = captureTaskDeliveryWork();
      const requesterSessionKey = "agent:main:main";
      const context = createContext();
      const resolver = () => context;
      context.resolveGatewayContext = resolver;
      context.dedupe.set(
        `agent:${buildAnnounceIdempotencyKey("codex-native:parent-thread:child-thread:succeeded")}`,
        {
          ts: Date.now(),
          ok: true,
          payload: {
            runId: "requester-result",
            status: "ok",
            result: { payloads: [{ text: "Child received" }] },
          },
        },
      );
      await replaceSessionEntry(
        {
          agentId: "main",
          sessionKey: requesterSessionKey,
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        },
        { sessionId: "parent-session", updatedAt: Date.now() },
      );
      const scope = createAgentHarnessTaskRuntimeScope({
        requesterSessionKey,
        gatewayContextResolver: resolver,
      });
      if (ordering === "unsupported") {
        // Copying the legacy default must not opt a custom owner into core settlement.
        setDetachedTaskLifecycleRuntime({ ...getDetachedTaskLifecycleRuntime() });
      }
      const client = fixture.createClient();
      const warning = vi.spyOn(embeddedAgentLog, "warn");
      const activity = vi.fn();
      const stopActivity = onAgentEventForRun("codex-thread:child-thread", activity);
      let publishedTask: AgentHarnessTaskRecord | undefined;
      const stopPublication = onTaskRegistryChange((event) => {
        if (
          ordering === "published" &&
          !publishedTask &&
          event?.kind === "upserted" &&
          event.task.runId === "codex-thread:child-thread"
        ) {
          publishedTask = event.task;
          updateTask(event.task.taskId, { createdAt: event.task.createdAt - 1 });
        }
      });
      const deliver = vi.fn(
        async (
          params: Parameters<typeof deliverAgentHarnessTaskCompletion>[0],
        ): Promise<AgentHarnessCompletionDelivery> =>
          ordering === "retry"
            ? { delivered: false, path: "none" }
            : await deliverAgentHarnessTaskCompletion(params),
      );
      const monitor = new fixture.CodexNativeSubagentMonitor(
        client as never,
        {
          captureAgentHarnessCompletionCustody,
          createAgentHarnessTaskEventSink,
          createAgentHarnessTaskRuntime,
          deliverAgentHarnessTaskCompletion: deliver,
        },
        { recoveryPollDelaysMs: [], completionDeliveryRetryDelaysMs: [1_000] },
      );
      const root = tryBeginGatewayRootWorkAdmission("test:assignment-parent")!;
      let retired = false;
      try {
        const pendingParent = root.run(
          async () =>
            await withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: requesterSessionKey,
                gatewayContextResolver: resolver,
                operationalRunInstance:
                  createTestAdmittedRunContext("assignment-parent").operationalRunInstance,
                receiptAuthority: () => !retired,
              },
              async () => {
                const registration = await monitor.registerParent({
                  parentThreadId: "parent-thread",
                  requesterSessionKey,
                  taskRuntimeScope: scope,
                  agentId: "main",
                });
                registration.bindTurn("parent-turn");
                await client.notify({
                  method: "item/completed",
                  params: {
                    threadId: "parent-thread",
                    turnId: "parent-turn",
                    item: fixture.directSpawnItem("v2", "parent-thread", "child-thread"),
                  },
                });
                return registration;
              },
            ),
        );
        if (ordering === "unsupported") {
          await expect(pendingParent).rejects.toThrow("Upgrade the custom task runtime adapter");
          await notifications.settle();
          expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.size).toBe(0);
          expect(deliver).not.toHaveBeenCalled();
          expect(activity).not.toHaveBeenCalled();
          root.release();
          expect(getActiveGatewayRootWorkCount()).toBe(0);
          return;
        }
        const parent = await pendingParent;
        await notifications.settle();
        stopPublication();
        const original =
          publishedTask ?? [...loadTaskRegistryStateFromSqliteReadOnly().tasks.values()][0]!;
        const complete = () =>
          runOutsideGatewayRootWorkAdmission(() =>
            client.notify(
              fixture.nativeCompletionNotification({
                agentPath: "/root/child-thread",
                result: "Original child result",
              }),
            ),
          );
        if (ordering === "interrupted-replaced") {
          await runOutsideGatewayRootWorkAdmission(async () => {
            await client.notify(fixture.turnStartedNotification("child-turn"));
            await client.notify(fixture.childTurnCompletedNotification({ status: "interrupted" }));
          });
          await captureTaskRegistryReadFence(captureOpenClawStateWorkerContext().admission);
          await notifications.settle();
          expect(activity).toHaveBeenCalledWith(expect.objectContaining({ stream: "execution" }));
          activity.mockClear();
        }
        if (ordering === "foreground") {
          await complete();
          expect(deliver).not.toHaveBeenCalled();
        } else {
          await parent.unregister();
        }
        retired = true;
        root.release();
        if (ordering === "interrupted-replaced") {
          expect(getActiveGatewayRootWorkCount()).toBe(0);
        }
        if (ordering === "retry") {
          vi.useFakeTimers();
          await complete();
          expect(deliver).toHaveBeenCalledOnce();
        }
        if (ordering === "revoked") {
          getGatewayContextLifetime(resolver).abort();
        } else if (ordering === "runtime-retired") {
          // The requester and Gateway remain live; only the admitted runtime owner retires.
          setDetachedTaskLifecycleRuntime({ ...getDetachedTaskLifecycleRuntime() });
          expect(getGatewayContextLifetime(resolver).signal.aborted).toBe(false);
        } else if (ordering !== "published") {
          updateTask(
            original.taskId,
            ordering === "metadata"
              ? { label: "Updated metadata" }
              : { createdAt: original.createdAt - 1 },
          );
        }
        const replacement = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(original.taskId)!;
        if (ordering !== "metadata" && ordering !== "revoked" && ordering !== "runtime-retired") {
          expect(replacement.createdAt).toBe(original.createdAt - 1);
        }
        const schedule =
          ordering === "runtime-retired" ? vi.spyOn(globalThis, "setTimeout") : undefined;
        if (ordering === "foreground") {
          await parent.unregister();
        } else if (ordering === "retry") {
          await vi.advanceTimersByTimeAsync(1_000);
        } else if (ordering === "interrupted-replaced") {
          await runOutsideGatewayRootWorkAdmission(() =>
            client.notify({
              method: "thread/status/changed",
              params: { threadId: "child-thread", status: { type: "idle" } },
            }),
          );
          expect(activity).not.toHaveBeenCalled();
        } else {
          await complete();
        }
        if (schedule) {
          expect(schedule.mock.calls.some(([, delay]) => delay === 1_000)).toBe(false);
          schedule.mockRestore();
        }
        vi.useRealTimers();
        await captureTaskRegistryReadFence(captureOpenClawStateWorkerContext().admission);
        await notifications.settle();
        const current = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(original.taskId);
        if (ordering === "metadata") {
          expect(deliver).toHaveBeenCalledOnce();
          await expect(deliver.mock.results[0]!.value).resolves.toMatchObject({
            delivered: true,
            path: "direct",
          });
          expect(current).toMatchObject({
            status: "succeeded",
            deliveryStatus: "delivered",
            label: "Updated metadata",
          });
        } else {
          expect(deliver).toHaveBeenCalledTimes(ordering === "retry" ? 1 : 0);
          expect(current).toEqual(replacement);
          if (ordering === "runtime-retired") {
            expect(warning).toHaveBeenCalledWith(expect.stringContaining("runtime owner changed"));
          }
        }
        await closeOpenClawStateDatabaseAsync();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        stopPublication();
        stopActivity();
        vi.useRealTimers();
        root.release();
        monitor.retireParent("parent-thread");
        monitor.dispose();
        if (ordering === "unsupported" || ordering === "runtime-retired") {
          resetDetachedTaskLifecycleRuntimeForTests();
        }
      }
    });
  });

  it.each([
    "completed",
    "unavailable",
    "replaced",
    "metadata",
    "earlier",
    "earlier-replaced",
  ] as const)(
    "keeps recovery custody through its first %s history attempt",
    async (historyOutcome) => {
      const fixture = await loadCodexNativeSubagentMonitorTestFixture();
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        resetTaskRegistryForTests({ persist: false });
        using deliveries = captureTaskDeliveryWork();
        const history = fixture.nativeHistoryOwner();
        const requesterSessionKey = "agent:main:main";
        const runId = "codex-thread:child-thread";
        const context = createContext();
        const resolver = () => context;
        context.resolveGatewayContext = resolver;
        context.dedupe.set(
          `agent:${buildAnnounceIdempotencyKey("codex-native:parent-thread:child-thread:succeeded")}`,
          {
            ts: Date.now(),
            ok: true,
            payload: {
              runId: "requester-recovery",
              status: "ok",
              result: { payloads: [{ text: "Recovered child result received" }] },
            },
          },
        );
        await replaceSessionEntry(
          {
            agentId: "main",
            sessionKey: requesterSessionKey,
            storePath: path.join(state.sessionsDir(), "sessions.json"),
          },
          {
            sessionId: history.sessionId,
            lifecycleRevision: history.lifecycleRevision,
            updatedAt: Date.now(),
          },
        );
        const scope = createAgentHarnessTaskRuntimeScope({
          requesterSessionKey,
          gatewayContextResolver: resolver,
        });
        const runtime = createAgentHarnessTaskRuntime({
          scope,
          runtime: "subagent",
          taskKind: "codex-native",
          runIdPrefix: "codex-thread:",
        });
        const task = runtime.createRunningTaskRun({
          runId,
          sourceId: runId,
          task: "Recover child result",
          requesterAgentId: "main",
          notifyPolicy: "silent",
          detail: { nativeHistory: { ...history } },
        });
        const earlierCompletion =
          historyOutcome === "earlier" || historyOutcome === "earlier-replaced";
        if (!earlierCompletion) {
          runtime.finalizeTaskRunByRunId({
            runId,
            status: "succeeded",
            endedAt: Date.now(),
            terminalSummary: "Child result",
          });
        }
        runtime.setDetachedTaskDeliveryStatusByRunId({ runId, deliveryStatus: "pending" });
        await deliveries.settle();
        let replacement: AgentHarnessTaskRecord | undefined;
        const stopPublication = onTaskRegistryChange((event) => {
          if (
            historyOutcome === "earlier-replaced" &&
            !replacement &&
            event?.kind === "upserted" &&
            event.task.taskId === task.taskId &&
            event.task.status === "succeeded"
          ) {
            // Replace during publication, before the original exact transition returns.
            replacement = { ...event.task, createdAt: event.task.createdAt - 1 };
            replacement =
              updateTask(task.taskId, { createdAt: replacement.createdAt }) ?? undefined;
          }
        });
        const client = fixture.createClient();
        const readStarted = createDeferredCore();
        const historyRead = createDeferredCore<ReturnType<typeof fixture.threadRead>>();
        const delivered = createDeferredCore<AgentHarnessCompletionDelivery>();
        client.setThreadReadFactory("child-thread", () => {
          readStarted.resolve();
          return historyRead.promise;
        });
        const deliver = vi.fn((params: Parameters<typeof deliverAgentHarnessTaskCompletion>[0]) => {
          const operation = deliverAgentHarnessTaskCompletion(params);
          void operation.then(delivered.resolve, delivered.reject);
          return operation;
        });
        if (historyOutcome === "unavailable") {
          vi.useFakeTimers();
        }
        const monitor = new fixture.CodexNativeSubagentMonitor(
          client as never,
          {
            captureAgentHarnessCompletionCustody,
            createAgentHarnessTaskEventSink,
            createAgentHarnessTaskRuntime,
            deliverAgentHarnessTaskCompletion: deliver,
          },
          { recoveryPollDelaysMs: [300_000] },
        );
        const root = tryBeginGatewayRootWorkAdmission("test:recovery-parent")!;
        let retired = false;
        try {
          const parent = await root.run(
            async () =>
              await withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey: requesterSessionKey,
                  gatewayContextResolver: resolver,
                  operationalRunInstance:
                    createTestAdmittedRunContext("recovery-parent").operationalRunInstance,
                  receiptAuthority: () => !retired,
                },
                () =>
                  monitor.registerParent({
                    parentThreadId: "parent-thread",
                    requesterSessionKey,
                    taskRuntimeScope: scope,
                    agentId: "main",
                    historyOwner: history,
                  }),
              ),
          );
          await readStarted.promise;
          if (historyOutcome === "replaced" || historyOutcome === "metadata") {
            updateTask(
              task.taskId,
              historyOutcome === "replaced"
                ? { createdAt: task.createdAt - 1 }
                : { label: "Updated metadata" },
            );
          }
          const beforeHistory = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
          await parent.unregister();
          retired = true;
          root.release();
          expect(getActiveGatewayRootWorkCount()).toBe(1);
          markGatewayRestartDraining();
          expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
          if (historyOutcome !== "unavailable") {
            historyRead.resolve(fixture.threadRead({ result: "Recovered child result" }));
            if (historyOutcome === "replaced" || historyOutcome === "earlier-replaced") {
              if (historyOutcome === "replaced") {
                expect(beforeHistory?.createdAt).toBe(task.createdAt - 1);
              }
              await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
              expect(deliver).not.toHaveBeenCalled();
              if (historyOutcome === "earlier-replaced") {
                expect(replacement).toBeDefined();
                expect(replacement!.createdAt).toBeLessThan(task.createdAt);
              }
              expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toEqual(
                historyOutcome === "replaced" ? beforeHistory : replacement,
              );
            } else {
              await expect(delivered.promise).resolves.toMatchObject({
                delivered: true,
                path: "direct",
              });
              await deliver.mock.results[0]!.value;
            }
            await deliveries.settle();
            expect(
              loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.deliveryStatus,
            ).toBe(
              historyOutcome === "replaced" || historyOutcome === "earlier-replaced"
                ? "pending"
                : "delivered",
            );
            if (historyOutcome === "earlier") {
              expect(
                loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.createdAt,
              ).toBeLessThan(task.createdAt);
            }
            await closeOpenClawStateDatabaseAsync();
          } else {
            historyRead.reject(new Error("History temporarily unavailable"));
            await vi.advanceTimersByTimeAsync(0);
            expect(deliver).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(1);
            expect(
              loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.deliveryStatus,
            ).toBe("pending");
          }
          expect(getActiveGatewayRootWorkCount()).toBe(0);
        } finally {
          stopPublication();
          root.release();
          monitor.retireParent("parent-thread");
          monitor.dispose();
          vi.useRealTimers();
        }
      });
    },
  );

  it.each(["pending", "foreground"] as const)(
    "persists detached native events and releases the root after %s completion handoff",
    async (deliveryMode) => {
      const fixture = await loadCodexNativeSubagentMonitorTestFixture();
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        resetTaskRegistryForTests({ persist: false });
        using deliveries = captureTaskDeliveryWork();
        const requesterSessionKey = "agent:main:main";
        const context = createContext();
        const resolver = () => context;
        context.resolveGatewayContext = resolver;
        context.dedupe.set(
          `agent:${buildAnnounceIdempotencyKey("codex-native:parent-thread:child-thread:succeeded")}`,
          {
            ts: Date.now(),
            ok: true,
            payload: {
              runId: "requester-completion",
              status: "ok",
              result: { payloads: [{ text: "Child result received" }] },
            },
          },
        );
        await replaceSessionEntry(
          {
            agentId: "main",
            sessionKey: requesterSessionKey,
            storePath: path.join(state.sessionsDir(), "sessions.json"),
          },
          { sessionId: "parent-session", updatedAt: Date.now() },
        );
        const scope = createAgentHarnessTaskRuntimeScope({
          requesterSessionKey,
          gatewayContextResolver: resolver,
        });
        const client = fixture.createClient();
        const deliver = vi.fn(
          async (
            params: Parameters<typeof deliverAgentHarnessTaskCompletion>[0],
          ): Promise<AgentHarnessCompletionDelivery> =>
            deliveryMode === "foreground"
              ? await deliverAgentHarnessTaskCompletion(params)
              : { delivered: false, path: "none" },
        );
        const monitor = new fixture.CodexNativeSubagentMonitor(
          client as never,
          {
            captureAgentHarnessCompletionCustody,
            createAgentHarnessTaskEventSink,
            createAgentHarnessTaskRuntime,
            deliverAgentHarnessTaskCompletion: deliver,
          },
          { recoveryPollDelaysMs: [], completionDeliveryRetryDelaysMs: [300_000] },
        );
        const warning = vi.spyOn(taskRegistryLog, "warn");
        const root = tryBeginGatewayRootWorkAdmission("test:native-parent")!;
        let parent: Awaited<ReturnType<typeof monitor.registerParent>> | undefined;
        let retired = false;
        try {
          await root.run(async () => {
            await withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: requesterSessionKey,
                operationalRunInstance:
                  createTestAdmittedRunContext("parent-run").operationalRunInstance,
                receiptAuthority: () => !retired,
                gatewayContextResolver: resolver,
              },
              async () => {
                parent = await monitor.registerParent({
                  parentThreadId: "parent-thread",
                  requesterSessionKey,
                  taskRuntimeScope: scope,
                  agentId: "main",
                });
                parent.bindTurn("parent-turn");
                await client.notify({
                  method: "item/completed",
                  params: {
                    threadId: "parent-thread",
                    turnId: "parent-turn",
                    item: fixture.directSpawnItem("v2", "parent-thread", "child-thread"),
                  },
                });
              },
            );
          });
          const finishChild = () =>
            runOutsideGatewayRootWorkAdmission(async () => {
              await client.notify(fixture.turnStartedNotification("child-turn"));
              await client.notify({
                method: "item/started",
                params: {
                  threadId: "child-thread",
                  turnId: "child-turn",
                  item: {
                    type: "commandExecution",
                    id: "child-tool",
                    command: "true",
                    cwd: "/workspace",
                    status: "inProgress",
                    commandActions: [],
                  },
                },
              });
              await client.notify({
                method: "item/completed",
                params: {
                  threadId: "child-thread",
                  turnId: "child-turn",
                  item: { type: "agentMessage", id: "child-final", text: "Child result" },
                },
              });
              await client.notify(
                fixture.childTurnCompletedNotification({
                  status: "completed",
                  items: [{ type: "agentMessage", id: "child-final", text: "Child result" }],
                }),
              );
            });
          if (deliveryMode === "foreground") {
            await finishChild();
            expect(deliver).not.toHaveBeenCalled();
          } else {
            await parent!.unregister();
          }
          retired = true;
          root.release();
          if (deliveryMode === "pending") {
            // No earlier event drain can lend its root to this detached notification.
            expect(getActiveGatewayRootWorkCount()).toBe(1);
          }
          markGatewayRestartDraining();
          expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
          if (deliveryMode === "foreground") {
            await parent!.unregister();
            expect(deliver).toHaveBeenCalledOnce();
            await expect(deliver.mock.results[0]!.value).resolves.toMatchObject({
              delivered: true,
              path: "direct",
            });
          } else {
            await finishChild();
          }
          await captureTaskRegistryReadFence(captureOpenClawStateWorkerContext().admission);
          await deliveries.settle();
          const [task] = [...loadTaskRegistryStateFromSqliteReadOnly().tasks.values()];
          expect(task).toMatchObject({
            taskKind: "codex-native",
            status: "succeeded",
            deliveryStatus: deliveryMode === "foreground" ? "delivered" : "pending",
            toolUseCount: 1,
            terminalSummary: "Child result",
          });
          expect(deliver).toHaveBeenCalledOnce();
          expect(warning).not.toHaveBeenCalled();
          // Closing the state resources joins the accepted drain's cleanup, not its retry timer.
          await closeOpenClawStateDatabaseAsync();
          expect(getActiveGatewayRootWorkCount()).toBe(0);
        } finally {
          root.release();
          monitor.retireParent("parent-thread");
          monitor.dispose();
        }
      });
    },
  );

  it.each(["createdAt", "taskKind", "childSessionKey"] as const)(
    "rejects an old event producer after same-id %s replacement",
    async (field) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        resetTaskRegistryForTests({ persist: false });
        const context = createContext();
        const resolver = () => context;
        context.resolveGatewayContext = resolver;
        const scope = createAgentHarnessTaskRuntimeScope({
          requesterSessionKey: "agent:main:main",
          gatewayContextResolver: resolver,
        });
        await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: scope.requesterSessionKey,
            operationalRunInstance:
              createTestAdmittedRunContext("parent-run").operationalRunInstance,
            receiptAuthority: () => true,
            gatewayContextResolver: resolver,
          },
          async () => {
            const custody = (await captureAgentHarnessCompletionCustody(scope))!;
            try {
              const runtime = createAgentHarnessTaskRuntime({
                scope,
                runtime: "subagent",
                taskKind: "native-child",
              });
              const task = runtime.createRunningTaskRun({
                runId: "native:child",
                task: "Original assignment",
                requesterAgentId: "main",
                notifyPolicy: "silent",
              });
              const emit = createAgentHarnessTaskEventSink({
                scope,
                completionCustody: custody,
                runId: task.runId!,
                expectedTask: captureAgentHarnessTaskAssignment(task),
              });
              updateTask(task.taskId, {
                [field]: field === "createdAt" ? task.createdAt - 1 : "replacement",
              });
              expect(tasks.get(task.taskId)?.[field]).not.toBe(task[field]);
              expect(() =>
                emit({ stream: "tool", data: { phase: "start", name: "exec" } }),
              ).toThrow("task assignment was replaced");
              expect(tasks.get(task.taskId)?.toolUseCount).toBeUndefined();
            } finally {
              custody.release();
            }
          },
        );
      });
    },
  );
});
