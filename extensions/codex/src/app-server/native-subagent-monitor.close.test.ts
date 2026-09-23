import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { createAgentHarnessTaskRuntime } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  isCodexAppServerLiveThreadClaimed,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { createCodexNativeSubagentMonitorRuntime } from "./native-subagent-monitor-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  childTurnCompletedNotification,
  closeAgentNotification,
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  directSpawnItem,
  successfulSendInputOutput,
  nativeCompletionNotification,
  notifyChildStarted,
  parentSampled,
  registerParent,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import type { CodexServerNotification } from "./protocol.js";
import { createClientHarness } from "./test-support.js";

describe("Codex native close admission", () => {
  it("does not publish a claim invalidated before the factory await resumes", async () => {
    await withStateDirEnv("codex-close-claim-publication-", async ({ stateDir }) => {
      const sessionKey = "agent:main:close-claim-publication";
      const host = await createAdmittedHostCapabilityTestFixture({
        runId: "close-claim-publication",
        agentId: "main",
        sessionKey,
        config: {},
      });
      const scope = host.agentHarnessTaskRuntimeScope;
      if (!scope) {
        throw new Error("host did not mint a task runtime scope");
      }
      const harness = createClientHarness();
      ensureCodexAppServerClientRuntime(harness.client, { agentDir: stateDir });
      const invalidateDuringClaim = vi.fn(() => {
        harness.send({ method: "thread/closed", params: { threadId: "child-thread" } });
      });
      const prior = await claimCodexAppServerLiveThread(
        harness.client,
        "child-thread",
        invalidateDuringClaim,
      );
      if (!prior) {
        throw new Error("prior native ownership missing");
      }
      await retainCodexAppServerLiveThread(harness.client, "child-thread", prior.release);
      let captureForget: ((threadId: string) => Promise<(() => void) | undefined>) | undefined;
      class ObservedMonitor extends CodexNativeSubagentMonitor {
        constructor(...params: ConstructorParameters<typeof CodexNativeSubagentMonitor>) {
          super(...params);
          captureForget = params[2]?.captureChildThreadForget;
        }
      }
      const factory = createCodexNativeSubagentMonitorRuntime(ObservedMonitor);
      const parent = factory.register({
        client: harness.client,
        parentThreadId: "parent-thread",
        requesterSessionKey: sessionKey,
        taskRuntimeScope: scope,
        agentId: "main",
      });
      parent.bindTurn("parent-turn");
      try {
        harness.send({
          method: "item/completed",
          params: {
            threadId: "parent-thread",
            turnId: "parent-turn",
            item: { ...directSpawnItem("v1", "parent-thread", "child-thread"), id: "spawn-child" },
          },
        });
        if (!captureForget) {
          throw new Error("factory did not supply its captured-forget operation");
        }
        await expect(captureForget("child-thread")).resolves.toBeUndefined();
        expect(invalidateDuringClaim).toHaveBeenCalledOnce();
        expect(isCodexAppServerLiveThreadClaimed(harness.client, "child-thread")).toBe(false);
        expect(harness.writes).toEqual([]);
      } finally {
        factory.retireParent(harness.client, "parent-thread");
        await harness.client.closeAndWait();
        await parent.unregister();
        host.closeHost();
        host.closeAdmission();
      }
    });
  });

  it("settles a close completed before its extant parent owner binds the native turn", async () => {
    const client = createClient();
    client.setLoadedThreads([]);
    const runtime = createRuntime();
    const forget = vi.fn();
    const captureChildThreadForget = vi.fn(async () => forget);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      captureChildThreadForget,
    });
    const parent = registerParent(monitor);
    onTestFinished(() => monitor.dispose());
    await notifyChildStarted(client);

    await client.notify(closeAgentNotification({ method: "item/started" }));
    await client.notify(closeAgentNotification({ method: "item/completed" }));
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
    parent.bindTurn("parent-turn");
    await vi.waitFor(() => expect(forget).toHaveBeenCalledOnce());

    expect(captureChildThreadForget).toHaveBeenCalledExactlyOnceWith("child-thread");
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: "codex-thread:child-thread", status: "cancelled" }),
    );
    expect(forget).toHaveBeenCalledOnce();
  });

  it("does not forget captured ownership after its parent retires during capture", async () => {
    const client = createClient();
    client.setLoadedThreads([]);
    const runtime = createRuntime();
    const forget = vi.fn();
    let resolveCapture!: (forget: () => void) => void;
    const capture = new Promise<() => void>((resolve) => {
      resolveCapture = resolve;
    });
    const captureChildThreadForget = vi.fn(() => capture);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      captureChildThreadForget,
    });
    registerParent(monitor).bindTurn("parent-turn");
    onTestFinished(() => monitor.dispose());
    await notifyChildStarted(client);

    const starting = client.notify(closeAgentNotification({ method: "item/started" }));
    await vi.waitFor(() => expect(captureChildThreadForget).toHaveBeenCalledOnce());
    monitor.retireParent("parent-thread");
    const finalizationsAfterRetirement = [...runtime.finalizeTaskRunByRunId.mock.calls];
    resolveCapture(forget);
    await starting;
    await client.notify(closeAgentNotification({ method: "item/completed" }));

    expect(runtime.finalizeTaskRunByRunId.mock.calls).toEqual(finalizationsAfterRetirement);
    expect(forget).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });
});

describe("same-monitor close assignment proof", () => {
  it.each([
    "original",
    "current",
    "delayed",
    "missing-start",
    "duplicate",
    "present",
    "read-error",
    "transient-explicit-close",
    "malformed",
    "incomplete",
    "ephemeral",
    "read-replacement",
    "read-error-replacement",
    "detached-during-read",
    "unregister-drain",
    "mismatched",
  ] as const)(
    "%s close preserves assignment ownership through the registered factory",
    async (scenario) => {
      await withStateDirEnv(`codex-same-monitor-${scenario}-`, async ({ stateDir }) => {
        const parentThreadId = "parent-thread";
        const childThreadId = "child-thread";
        const requesterSessionKey = `agent:main:same-monitor-${scenario}`;
        const initialRunId = "codex-thread:child-thread";
        const followupRunId = "codex-thread:child-thread:turn:assignment-b";
        const initialOnly =
          scenario === "original" ||
          scenario === "ephemeral" ||
          scenario === "unregister-drain" ||
          scenario === "transient-explicit-close";
        const closeBeforeFollowup =
          scenario === "delayed" ||
          scenario === "duplicate" ||
          scenario === "read-replacement" ||
          scenario === "read-error-replacement";
        const deferredMembership =
          scenario === "read-replacement" ||
          scenario === "read-error-replacement" ||
          scenario === "detached-during-read" ||
          scenario === "unregister-drain";
        const shouldCancel =
          initialOnly ||
          scenario === "current" ||
          scenario === "mismatched" ||
          scenario === "detached-during-read";
        const host = await createAdmittedHostCapabilityTestFixture({
          runId: `same-monitor-${scenario}-parent`,
          agentId: "main",
          sessionKey: requesterSessionKey,
          config: {},
        });
        const scope = host.agentHarnessTaskRuntimeScope;
        if (!scope) {
          throw new Error("host did not mint a task runtime scope");
        }
        const taskRuntime = createAgentHarnessTaskRuntime({
          runtime: "subagent",
          taskKind: "codex-native",
          scope,
          runIdPrefix: "codex-thread:",
        });
        const queue = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue");
        let phase = "assignment-a";
        const wire: unknown[] = [];
        const unsubscriptions: { phase: string; params: unknown }[] = [];
        const membershipRequests: unknown[] = [];
        const snapshots: Record<string, unknown> = {};
        const notifications: {
          notification: CodexServerNotification;
          completion: Promise<void> | void;
        }[] = [];
        let replyToMembership: (() => void) | undefined;
        const harness = createClientHarness({
          onWrite(line, reply) {
            const request = JSON.parse(line) as {
              id?: number | string;
              method?: string;
              params?: unknown;
            };
            wire.push({ direction: "request", phase, request });
            if (request.id === undefined) {
              return;
            }
            if (request.method === "thread/unsubscribe") {
              unsubscriptions.push({ phase, params: request.params });
              reply({ id: request.id, result: {} });
            } else if (request.method === "thread/loaded/list") {
              membershipRequests.push(request.params);
              if (scenario === "transient-explicit-close" && membershipRequests.length === 1) {
                return;
              }
              const respond = () => {
                if (scenario === "read-error" || scenario === "read-error-replacement") {
                  reply({
                    id: request.id,
                    error: { code: -32000, message: "synthetic membership unavailable" },
                  });
                  return;
                }
                const result =
                  scenario === "present"
                    ? { data: [childThreadId], nextCursor: null }
                    : scenario === "malformed"
                      ? { data: [42], nextCursor: null }
                      : scenario === "incomplete"
                        ? { data: [], nextCursor: "next-page" }
                        : scenario === "transient-explicit-close"
                          ? { data: [parentThreadId], nextCursor: null }
                          : { data: [], nextCursor: null };
                reply({ id: request.id, result });
              };
              if (deferredMembership) {
                replyToMembership = respond;
              } else {
                respond();
              }
            } else {
              reply({
                id: request.id,
                error: { code: -32601, message: "outside synthetic close proof wire" },
              });
            }
          },
        });
        const addNotificationHandler = harness.client.addNotificationHandler.bind(harness.client);
        const handlers = vi
          .spyOn(harness.client, "addNotificationHandler")
          .mockImplementation((handler) =>
            addNotificationHandler((notification) => {
              const completion = handler(notification);
              notifications.push({ notification, completion });
              return completion;
            }),
          );
        const send = (notification: CodexServerNotification) => {
          const cursor = notifications.length;
          wire.push({ direction: "notification", phase, notification });
          harness.send(notification);
          return cursor;
        };
        const drainOwnership = async () => {
          let joined = 0;
          while (joined < queue.mock.results.length) {
            const pending = queue.mock.results.slice(joined);
            joined = queue.mock.results.length;
            await Promise.all(
              pending.flatMap((result) => (result.type === "return" ? [result.value] : [])),
            );
          }
        };
        const settle = async (notification: CodexServerNotification, cursor: number) => {
          await vi.waitFor(() =>
            expect(notifications.slice(cursor).map((entry) => entry.notification)).toContainEqual(
              notification,
            ),
          );
          await Promise.all(
            notifications.slice(cursor).map((entry) => Promise.resolve(entry.completion)),
          );
          await drainOwnership();
        };
        const collab = (
          method: "item/started" | "item/completed",
          id: string,
          tool: "closeAgent" | "resumeAgent" | "sendInput",
          previousStatus: "running" | "completed" = "completed",
          itemStatus?: "failed",
        ): CodexServerNotification => ({
          method,
          params: {
            threadId: parentThreadId,
            turnId: "parent-p1",
            item: {
              type: "collabAgentToolCall",
              id,
              tool,
              status: itemStatus ?? (method === "item/started" ? "inProgress" : "completed"),
              senderThreadId: parentThreadId,
              receiverThreadIds: [childThreadId],
              agentsStates:
                method === "item/started"
                  ? {}
                  : {
                      [childThreadId]:
                        itemStatus === "failed"
                          ? { status: "errored", message: "previous child error" }
                          : {
                              status: previousStatus,
                              ...(previousStatus === "completed"
                                ? { message: "assignment A result" }
                                : {}),
                            },
                    },
            },
          },
        });
        ensureCodexAppServerClientRuntime(harness.client, { agentDir: stateDir });
        const parent = codexNativeSubagentMonitorRuntime.register({
          client: harness.client,
          parentThreadId,
          requesterSessionKey,
          taskRuntimeScope: scope,
          agentId: "main",
        });
        parent.bindTurn("parent-p1");
        const unregisterSettled = [vi.fn(), vi.fn()];
        let unregisterCompletion: Promise<unknown[]> | undefined;
        let detachedUnregisterCompletion: Promise<void> | undefined;
        let database: DatabaseSync | undefined;
        const read = (runId: string) =>
          database?.prepare("SELECT * FROM task_runs WHERE run_id = ?").get(runId);
        const expectUnconfirmedClose = (runId: string) => {
          const progressSummary =
            "Could not confirm that the subagent closed. Retry the close request.";
          expect(taskRuntime.listTaskRecords()).toContainEqual(
            expect.objectContaining({ runId, status: "running", progressSummary }),
          );
          expect(read(runId)).toMatchObject({
            status: "running",
            progress_summary: progressSummary,
            terminal_summary: null,
            error: null,
            ended_at: null,
          });
        };
        const startFollowup = async () => {
          phase = "native-resume-b";
          send(collab("item/started", "resume-b", "resumeAgent"));
          send(collab("item/completed", "resume-b", "resumeAgent"));
          send(collab("item/started", "send-b", "sendInput", "running"));
          send(turnStartedNotification("assignment-b", { threadId: childThreadId, error: null }));
          send(collab("item/completed", "send-b", "sendInput", "running"));
          send(
            successfulSendInputOutput({
              parentThreadId,
              turnId: "parent-p1",
              callId: "send-b",
              submissionId: "assignment-b",
            }),
          );
          await vi.waitFor(() => {
            expect(read(followupRunId)).toMatchObject({ status: "running" });
            expect(isCodexAppServerLiveThreadClaimed(harness.client, childThreadId)).toBe(true);
          });
          snapshots.successorRunning = read(followupRunId);
          expect(read(initialRunId)).toEqual(snapshots.predecessor);
          expect(unsubscriptions).toEqual([]);
        };
        try {
          if (scenario === "ephemeral") {
            send({
              method: "thread/started",
              params: {
                thread: {
                  id: childThreadId,
                  parentThreadId,
                  ephemeral: true,
                  path: null,
                  preview: "ephemeral assignment",
                  source: {
                    subAgent: {
                      thread_spawn: {
                        parent_thread_id: parentThreadId,
                        depth: 1,
                        agent_path: childThreadId,
                      },
                    },
                  },
                },
              },
            });
          }
          send({
            method: "item/completed",
            params: {
              threadId: parentThreadId,
              turnId: "parent-p1",
              item: { ...directSpawnItem("v1", parentThreadId, childThreadId), id: "spawn-a" },
            },
          });
          send(turnStartedNotification("assignment-a", { threadId: childThreadId, error: null }));
          await vi.waitFor(() => {
            expect(taskRuntime.listTaskRecords()).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ runId: initialRunId, status: "running" }),
              ]),
            );
            expect(isCodexAppServerLiveThreadClaimed(harness.client, childThreadId)).toBe(true);
          });
          database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
            readOnly: true,
          });
          snapshots.initialRunning = read(initialRunId);
          if (!initialOnly) {
            send(
              childTurnCompletedNotification({
                turnId: "assignment-a",
                status: "completed",
                items: [
                  {
                    type: "agentMessage",
                    id: "final-a",
                    phase: "final_answer",
                    text: "assignment A result",
                  },
                ],
              }),
            );
            send(
              nativeCompletionNotification({ turnId: "parent-p1", result: "assignment A result" }),
            );
            send(parentSampled("parent-p1"));
            await vi.waitFor(() => {
              expect(read(initialRunId)).toMatchObject({
                status: "succeeded",
                delivery_status: "delivered",
                terminal_summary: "assignment A result",
              });
              expect(isCodexAppServerLiveThreadClaimed(harness.client, childThreadId)).toBe(false);
            });
            snapshots.predecessor = read(initialRunId);
          }
          if (initialOnly || closeBeforeFollowup) {
            phase = "old-close-started";
            send(
              collab(
                "item/started",
                "close-a",
                "closeAgent",
                initialOnly ? "running" : "completed",
              ),
            );
          }
          if (scenario === "duplicate") {
            phase = "first-close-a-completed";
            const completion = collab("item/completed", "close-a", "closeAgent");
            await settle(completion, send(completion));
            expect(unsubscriptions).toEqual([]);
            expect(read(initialRunId)).toEqual(snapshots.predecessor);
          }
          let deferredCompletion:
            | { notification: CodexServerNotification; cursor: number }
            | undefined;
          if (scenario === "read-replacement" || scenario === "read-error-replacement") {
            phase = "old-close-membership-pending";
            const notification = collab("item/completed", "close-a", "closeAgent");
            deferredCompletion = { notification, cursor: send(notification) };
            await vi.waitFor(() => expect(replyToMembership).toBeTypeOf("function"));
          }
          if (!initialOnly) {
            await startFollowup();
          }
          const closeId =
            initialOnly || closeBeforeFollowup || scenario === "missing-start"
              ? "close-a"
              : "close-b";
          if (!initialOnly && !closeBeforeFollowup && scenario !== "missing-start") {
            send(collab("item/started", closeId, "closeAgent", "running"));
          }
          if (scenario === "mismatched") {
            const wrong = collab("item/completed", "unrelated-close", "closeAgent", "running");
            await settle(wrong, send(wrong));
            expect(membershipRequests).toEqual([]);
            expect(read(followupRunId)).toEqual(snapshots.successorRunning);
            expect(isCodexAppServerLiveThreadClaimed(harness.client, childThreadId)).toBe(true);
          }
          if (scenario === "transient-explicit-close") {
            phase = "native-child-shutdown";
            const interrupted = childTurnCompletedNotification({
              turnId: "assignment-a",
              status: "interrupted",
              items: [],
            });
            await settle(interrupted, send(interrupted));
            const notLoaded: CodexServerNotification = {
              method: "thread/status/changed",
              params: { threadId: childThreadId, status: { type: "notLoaded" } },
            };
            await settle(notLoaded, send(notLoaded));
            snapshots.afterNativeShutdown = read(initialRunId);
          }
          phase = `${closeId}-completed`;
          const completion =
            deferredCompletion?.notification ??
            collab(
              "item/completed",
              closeId,
              "closeAgent",
              initialOnly || closeId === "close-b" ? "running" : "completed",
              scenario === "ephemeral" ? "failed" : undefined,
            );
          const cursor = deferredCompletion?.cursor ?? send(completion);
          if (scenario === "detached-during-read") {
            await vi.waitFor(() => expect(replyToMembership).toBeTypeOf("function"));
            send({
              method: "turn/completed",
              params: {
                threadId: parentThreadId,
                turn: { id: "parent-p1", status: "completed", items: [], error: null },
              },
            });
            detachedUnregisterCompletion = parent.unregister();
          }
          if (scenario === "unregister-drain") {
            await vi.waitFor(() => expect(replyToMembership).toBeTypeOf("function"));
            unregisterCompletion = Promise.all(
              unregisterSettled.map((settled) =>
                Promise.resolve(parent.unregister()).then(settled),
              ),
            );
            await setImmediate();
            for (const settled of unregisterSettled) {
              expect(settled).not.toHaveBeenCalled();
            }
            expect(read(initialRunId)).toEqual(snapshots.initialRunning);
            expect(isCodexAppServerLiveThreadClaimed(harness.client, childThreadId)).toBe(true);
          }
          if (deferredMembership) {
            if (!replyToMembership) {
              throw new Error("membership request was not observed");
            }
            replyToMembership();
            replyToMembership = undefined;
          }
          await settle(completion, cursor);
          if (scenario === "detached-during-read") {
            await detachedUnregisterCompletion;
          }
          if (scenario === "transient-explicit-close") {
            snapshots.afterInconclusiveClose = read(initialRunId);
            snapshots.publicAfterInconclusiveClose = taskRuntime
              .listTaskRecords()
              .find((record) => record.runId === initialRunId);
            snapshots.claimedAfterInconclusiveClose = isCodexAppServerLiveThreadClaimed(
              harness.client,
              childThreadId,
            );
            expectUnconfirmedClose(initialRunId);
            expect(membershipRequests).toEqual([{}]);
            phase = "same-close-call-replay";
            send(collab("item/started", "close-a", "closeAgent", "running"));
            const replay = collab("item/completed", "close-a", "closeAgent", "running");
            await settle(replay, send(replay));
            snapshots.afterSameCallReplay = read(initialRunId);
            expect(read(initialRunId)).toEqual(snapshots.afterInconclusiveClose);
            expect(membershipRequests).toEqual([{}]);
            phase = "fresh-explicit-close";
            send(collab("item/started", "close-retry", "closeAgent", "running"));
            const retryCompletion: CodexServerNotification = {
              method: "item/completed",
              params: {
                threadId: parentThreadId,
                turnId: "parent-p1",
                item: {
                  id: "close-retry",
                  type: "collabAgentToolCall",
                  tool: "closeAgent",
                  status: "failed",
                  senderThreadId: parentThreadId,
                  receiverThreadIds: [childThreadId],
                  agentsStates: { [childThreadId]: { status: "notFound", message: null } },
                },
              },
            };
            await settle(retryCompletion, send(retryCompletion));
          }
          if (scenario === "unregister-drain") {
            await unregisterCompletion;
            for (const settled of unregisterSettled) {
              expect(settled).toHaveBeenCalledOnce();
            }
          }
          const activeRunId = initialOnly ? initialRunId : followupRunId;
          snapshots.afterClose = read(activeRunId);
          snapshots.publicAfterClose = taskRuntime
            .listTaskRecords()
            .find((record) => record.runId === activeRunId);
          snapshots.claimedAfterClose = isCodexAppServerLiveThreadClaimed(
            harness.client,
            childThreadId,
          );
          snapshots.predecessorAfterClose = initialOnly ? undefined : read(initialRunId);
          if (!initialOnly) {
            expect(read(initialRunId)).toEqual(snapshots.predecessor);
          }
          expect(unsubscriptions).toEqual([]);
          expect(membershipRequests).toEqual(
            scenario === "missing-start"
              ? []
              : scenario === "transient-explicit-close"
                ? [{}, {}]
                : [{}],
          );
          if (shouldCancel) {
            expect(read(activeRunId)).toMatchObject({
              status: "cancelled",
              terminal_summary: "Subagent was closed.",
            });
            expect(isCodexAppServerLiveThreadClaimed(harness.client, childThreadId)).toBe(false);
          } else if (
            scenario === "read-error" ||
            scenario === "malformed" ||
            scenario === "incomplete"
          ) {
            expectUnconfirmedClose(activeRunId);
            expect(isCodexAppServerLiveThreadClaimed(harness.client, childThreadId)).toBe(true);
          } else {
            expect(read(followupRunId)).toEqual(snapshots.successorRunning);
            expect(isCodexAppServerLiveThreadClaimed(harness.client, childThreadId)).toBe(true);
          }
          expect(wire).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                direction: "request",
                request: expect.objectContaining({ method: "thread/read" }),
              }),
            ]),
          );
        } finally {
          if (scenario === "detached-during-read") {
            replyToMembership?.();
            await detachedUnregisterCompletion;
          }
          if (scenario === "unregister-drain") {
            replyToMembership?.();
            await unregisterCompletion;
          }
          const evidenceDirectory = process.env.OPENCLAW_SAME_MONITOR_PROOF_DIRECTORY;
          if (evidenceDirectory) {
            fs.writeFileSync(
              path.join(evidenceDirectory, `${scenario}-evidence.json`),
              JSON.stringify(
                {
                  scenario,
                  sameParentTurn: "parent-p1",
                  parentRegistrations: 1,
                  snapshots,
                  membershipRequests,
                  unsubscriptions,
                  wire,
                },
                null,
                2,
              ) + "\n",
            );
          }
          phase = "task-cleanup";
          codexNativeSubagentMonitorRuntime.retireParent(harness.client, parentThreadId);
          await drainOwnership();
          await harness.client.closeAndWait();
          await parent.unregister();
          database?.close();
          host.closeHost();
          host.closeAdmission();
          handlers.mockRestore();
          queue.mockRestore();
        }
      });
    },
  );
});
