import { invokeNativeHookRelay, onAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentHarnessTaskRecord } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createCodexNativeHookRelay } from "./native-hook-relay.js";
import {
  type CodexThreadReadResponse,
  directSpawnItem,
  successfulSendInputOutput,
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  createRecordedRuntime,
  createTaskScope,
  registerParent,
  nativeHistoryOwner,
  notifyChildStarted,
  parentSampled,
  nativeCompletionNotification,
  deliveredNativeCompletion,
  childTurnCompletedNotification,
  turnStartedNotification,
  threadRead,
  taskRecord,
} from "./native-subagent-monitor.test-support.js";

describe("CodexNativeSubagentMonitor", () => {
  it.each(["v1", "v2"] as const)(
    "observes completed %s children again when a parent starts follow-up work",
    async (version) => {
      const client = createClient();
      const runtime = createRuntime();
      const host = await createAdmittedHostCapabilityTestFixture({
        runId: `native-followup-${version}`,
      });
      const relay = createCodexNativeHookRelay({
        options: { enabled: true },
        events: ["pre_tool_use"],
        agentId: undefined,
        sessionId: `native-followup-${version}`,
        sessionKey: undefined,
        config: {},
        runId: `native-followup-${version}`,
        attemptTimeoutMs: 30_000,
        startupTimeoutMs: 1_000,
        turnStartTimeoutMs: 1_000,
        loopDetectionPreToolUseRelay: false,
        signal: new AbortController().signal,
        hostCapabilities: host.hostCapabilities,
        onPreToolUseFailure: () => {},
      });
      if (!relay) {
        throw new Error("native hook relay missing");
      }
      onTestFinished(async () => {
        relay.unregister();
        await relay.drain();
        host.closeHost();
        host.closeAdmission();
      });
      await relay.ready;
      const claimDirectChild = vi.fn(relay.claimDirectChild);
      const onDirectChildAccepted = vi.fn();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
      const owner = monitor.registerParent({
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        taskRuntimeScope: createTaskScope("agent:main:main"),
        agentId: "main",
        claimDirectChild,
        onDirectChildAccepted,
      });
      owner.bindTurn("parent-turn");
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          item: directSpawnItem(version, "parent-thread", "child-thread"),
        },
      });
      if (version === "v1") {
        await client.notify(turnStartedNotification("initial-turn", { error: null }));
      }
      await client.notify(
        nativeCompletionNotification({
          agentPath: version === "v2" ? "/root/child-thread" : "child-thread",
          turnId: "parent-turn",
          result: "first result",
        }),
      );
      await client.notify(turnStartedNotification("followup-turn", { error: null }));
      onDirectChildAccepted.mockClear();
      expect(runtime.createRunningTaskRun).toHaveBeenCalledOnce();
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          item:
            version === "v2"
              ? {
                  type: "subAgentActivity",
                  id: "followup",
                  kind: "interacted",
                  agentThreadId: "child-thread",
                  agentPath: "/root/child-thread",
                }
              : {
                  type: "collabAgentToolCall",
                  id: "followup",
                  tool: "sendInput",
                  status: "completed",
                  senderThreadId: "parent-thread",
                  receiverThreadIds: ["child-thread"],
                },
        },
      });
      if (version === "v1") {
        await client.notify(
          successfulSendInputOutput({ callId: "followup", submissionId: "followup-turn" }),
        );
      }
      expect(claimDirectChild).toHaveBeenCalledTimes(2);
      expect(onDirectChildAccepted).toHaveBeenCalledOnce();
      await expect(
        invokeNativeHookRelay(
          {
            provider: "codex",
            relayId: relay.relayId,
            generation: relay.generation,
            event: "pre_tool_use",
            rawPayload: {
              agent_id: "child-thread",
              tool_name: "Bash",
              tool_input: { command: "printf followup" },
            },
          },
          AbortSignal.timeout(1_000),
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
      await owner.unregister();
      await client.notify({
        method: "turn/completed",
        params: {
          threadId: "child-thread",
          turn: {
            id: "followup-turn",
            status: "completed",
            error: null,
            items: [
              {
                type: "agentMessage",
                id: "followup-final",
                phase: "final_answer",
                text: "second result",
              },
            ],
          },
        },
      });
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ childSessionId: "child-thread", result: "second result" }),
      );
      monitor.dispose();
    },
  );

  it("moves a running child's claim to the new parent that sends its follow-up", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const oldRelease = vi.fn();
    const newRelease = vi.fn();
    const oldClaim = vi.fn(() => oldRelease);
    const newClaim = vi.fn(() => newRelease);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    onTestFinished(() => {
      monitor.retireParent("parent-thread");
      monitor.dispose();
    });
    const register = (claimDirectChild: typeof oldClaim) =>
      monitor.registerParent({
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        taskRuntimeScope: createTaskScope("agent:main:main"),
        claimDirectChild,
      });
    const first = register(oldClaim);
    first.bindTurn("first-parent-turn");
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "first-parent-turn",
        item: directSpawnItem("v2", "parent-thread", "child-thread"),
      },
    });
    await client.notify(turnStartedNotification("running-turn", { error: null }));
    await first.unregister();
    expect(oldRelease).not.toHaveBeenCalled();
    const second = register(newClaim);
    second.bindTurn("second-parent-turn");
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "second-parent-turn",
        item: {
          type: "subAgentActivity",
          id: "steer-running",
          kind: "interacted",
          agentThreadId: "child-thread",
          agentPath: "/root/child-thread",
        },
      },
    });
    expect(oldRelease).toHaveBeenCalledOnce();
    expect(newClaim).toHaveBeenCalledExactlyOnceWith("child-thread");
    expect(runtime.createRunningTaskRun).toHaveBeenCalledOnce();
    await client.notify(
      childTurnCompletedNotification({
        turnId: "running-turn",
        status: "completed",
        items: [{ type: "agentMessage", id: "final", phase: "final_answer", text: "result" }],
      }),
    );
    expect(newRelease).toHaveBeenCalledOnce();
    await second.unregister();
  });

  it("keeps a successor observed after parent release out of the old task owner", async () => {
    const client = createClient();
    const runtime = createRuntime();
    runtime.deliverAgentHarnessTaskCompletion.mockResolvedValue({ delivered: false, path: "none" });
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    onTestFinished(() => {
      monitor.retireParent("parent-thread");
      monitor.dispose();
    });
    const parent = registerParent(monitor);
    parent.bindTurn("parent-turn");
    await notifyChildStarted(client);
    await client.notify(
      childTurnCompletedNotification({
        status: "completed",
        items: [{ type: "agentMessage", id: "first", phase: "final_answer", text: "first result" }],
      }),
    );
    await parent.unregister();
    await client.notify(turnStartedNotification("unowned-turn", { error: null }));
    expect(runtime.createRunningTaskRun).toHaveBeenCalledOnce();
  });

  it.each([
    "first",
    "second",
    "neither",
    "duplicate",
    "fresh-owner",
    "fresh-unbound",
    "resumed",
    "resumed-start-first",
    "resumed-completed-first",
  ] as const)(
    "preserves overlapping follow-up outcomes when native delivery consumes %s result",
    async (consumed) => {
      const freshOwner = consumed === "fresh-owner" || consumed === "fresh-unbound";
      const resumed = consumed.startsWith("resumed");
      const client = createClient();
      const runtime = createRuntime();
      const records = new Map<string, AgentHarnessTaskRecord>();
      runtime.createRunningTaskRun.mockImplementation((params) => {
        const existing = records.get(params.runId);
        if (existing) {
          if (params.detail !== undefined) {
            existing.detail = params.detail;
          }
          return existing;
        }
        const task = {
          ...taskRecord({
            childThreadId: "child-thread",
            requesterSessionKey: "agent:main:main",
          }),
          ...params,
          taskId: params.runId,
          runId: params.runId,
        };
        records.set(params.runId, task);
        return task;
      });
      runtime.listTaskRecords.mockImplementation(() => [...records.values()]);
      runtime.finalizeTaskRunByRunId.mockImplementation((params) => {
        const record = records.get(params.runId);
        if (!record) {
          return [];
        }
        Object.assign(record, params);
        return [record];
      });
      runtime.setDetachedTaskDeliveryStatusByRunId.mockImplementation((params) => {
        const record = records.get(params.runId);
        if (!record) {
          return [];
        }
        Object.assign(record, params);
        return [record];
      });
      const claim = vi.fn(() => vi.fn());
      const followupClaim = vi.fn(() => vi.fn());
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
      onTestFinished(() => monitor.dispose());
      const registration = {
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:main",
        taskRuntimeScope: createTaskScope("agent:main:main"),
        historyOwner: {
          parentThreadId: "parent-thread",
          sessionId: "parent-session",
          connectionFingerprint: "a".repeat(64),
        },
      };
      let parent = monitor.registerParent({
        ...registration,
        claimDirectChild: claim,
      });
      parent.bindTurn("parent-turn");
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          item: directSpawnItem("v2", "parent-thread", "child-thread"),
        },
      });
      const complete = (turnId: string, result: string) =>
        client.notify(
          childTurnCompletedNotification({
            turnId,
            status: "completed",
            items: [
              { type: "agentMessage", id: `${turnId}-final`, phase: "final_answer", text: result },
            ],
          }),
        );
      const firstResult = consumed === "duplicate" ? "same result" : "first result";
      const secondResult = consumed === "duplicate" ? "same result" : "second result";
      await complete("first-turn", firstResult);
      if (consumed === "duplicate" || freshOwner) {
        await client.notify(
          nativeCompletionNotification({
            agentPath: "/root/child-thread",
            turnId: "parent-turn",
            result: firstResult,
          }),
        );
        await client.notify(parentSampled());
      }
      const first = structuredClone(records.get("codex-thread:child-thread"));
      const parentTurnId = freshOwner ? "next-parent-turn" : "parent-turn";
      if (freshOwner) {
        await parent.unregister();
        expect(claim.mock.results[0]?.value).toHaveBeenCalledOnce();
        parent = monitor.registerParent({ ...registration, claimDirectChild: followupClaim });
        if (consumed !== "fresh-unbound") {
          parent.bindTurn(parentTurnId);
        }
      }
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: parentTurnId,
          item: {
            type: "subAgentActivity",
            id: "followup",
            kind: "interacted",
            agentThreadId: "child-thread",
            agentPath: "/root/child-thread",
          },
        },
      });
      expect(claim).toHaveBeenCalledOnce();
      expect(records.size).toBe(1);
      await client.notify(turnStartedNotification("followup-turn", { error: null }));
      if (consumed === "fresh-unbound") {
        expect(records.size).toBe(1);
        expect(followupClaim).not.toHaveBeenCalled();
        parent.bindTurn(parentTurnId);
      }
      expect(claim).toHaveBeenCalledTimes(freshOwner ? 1 : 2);
      if (freshOwner) {
        expect(followupClaim).toHaveBeenCalledOnce();
      }
      expect(records.get("codex-thread:child-thread")).toEqual(first);
      await complete("first-turn", "stale result");
      expect(records.get("codex-thread:child-thread:turn:followup-turn")?.status).toBe("running");
      if (resumed) {
        await client.notify(
          childTurnCompletedNotification({ turnId: "followup-turn", status: "interrupted" }),
        );
        const interact = () =>
          client.notify({
            method: "item/completed",
            params: {
              threadId: "parent-thread",
              turnId: parentTurnId,
              item: {
                type: "subAgentActivity",
                id: "resume-followup",
                kind: "interacted",
                agentThreadId: "child-thread",
                agentPath: "/root/child-thread",
              },
            },
          });
        if (consumed === "resumed") {
          await interact();
        }
        await client.notify(turnStartedNotification("resumed-turn", { error: null }));
        if (consumed === "resumed-completed-first") {
          await complete("resumed-turn", secondResult);
        }
        if (consumed !== "resumed") {
          await interact();
        }
        expect(claim).toHaveBeenCalledTimes(consumed === "resumed-completed-first" ? 2 : 3);
        expect(records.size).toBe(2);
      }
      if (consumed === "first" || consumed === "second") {
        await client.notify(
          nativeCompletionNotification({
            agentPath: "/root/child-thread",
            turnId: "parent-turn",
            result: `${consumed} result`,
          }),
        );
        await client.notify(parentSampled());
      }
      await complete(resumed ? "resumed-turn" : "followup-turn", secondResult);
      if (resumed) {
        await client.notify(turnStartedNotification("unadmitted-turn", { error: null }));
        expect(claim).toHaveBeenCalledTimes(consumed === "resumed-completed-first" ? 2 : 3);
        expect(records.size).toBe(2);
      }
      if (consumed === "duplicate") {
        await client.notify({
          method: "item/completed",
          params: {
            threadId: "parent-thread",
            turnId: "parent-turn",
            item: {
              type: "collabAgentToolCall",
              id: "late-wait",
              tool: "wait",
              status: "completed",
              senderThreadId: "parent-thread",
              receiverThreadIds: ["child-thread"],
              agentsStates: { "child-thread": { status: "completed", message: firstResult } },
            },
          },
        });
      }
      await parent.unregister();
      await vi.waitFor(() =>
        expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(
          consumed === "neither" || resumed ? 2 : 1,
        ),
      );
      const delivered = runtime.deliverAgentHarnessTaskCompletion.mock.calls.map(
        ([params]) => params.result,
      );
      expect(delivered).toEqual(
        consumed === "duplicate" || freshOwner
          ? [secondResult]
          : consumed === "first"
            ? ["second result"]
            : consumed === "second"
              ? ["first result"]
              : ["first result", "second result"],
      );
      expect(records.get("codex-thread:child-thread")?.terminalSummary).toBe(firstResult);
      expect(records.get("codex-thread:child-thread:turn:followup-turn")?.terminalSummary).toBe(
        secondResult,
      );
      expect(records.get("codex-thread:child-thread:turn:followup-turn")?.detail).toMatchObject({
        nativeTurnId: resumed ? "resumed-turn" : "followup-turn",
      });
    },
  );

  it("recovers a follow-up's exact turn without borrowing a newer result", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const historyOwner = nativeHistoryOwner();
    const task = taskRecord({
      historyOwner,
      childThreadId: "child-thread:turn:turn-previous",
      status: "succeeded",
      deliveryStatus: "pending",
    });
    runtime.listTaskRecords.mockReturnValue([task]);
    client.setThreadRead(
      "child-thread",
      threadRead({ previousResult: "requested result", result: "newer result" }),
    );
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    onTestFinished(() => monitor.dispose());
    const parent = registerParent(monitor, undefined, undefined, historyOwner);
    await vi.waitFor(() =>
      expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
        expect.objectContaining({ runId: task.runId, terminalSummary: "requested result" }),
      ),
    );
    await parent.unregister();
    await vi.waitFor(() =>
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ childSessionId: "child-thread", result: "requested result" }),
      ),
    );
  });

  it.each([true, false])(
    "recovers the initial recorded result after a successor completes (locator=%s)",
    async (locator) => {
      const client = createClient();
      const runtime = createRuntime();
      const historyOwner = nativeHistoryOwner();
      const result = locator ? "original\n  result" : "original result";
      const task = {
        ...taskRecord({
          historyOwner,
          childThreadId: "child-thread",
          status: "succeeded",
          deliveryStatus: "pending",
        }),
        terminalSummary: "original result",
        ...(locator
          ? { detail: { nativeHistory: historyOwner, nativeTurnId: "turn-previous" } }
          : {}),
      } satisfies AgentHarnessTaskRecord;
      runtime.listTaskRecords.mockReturnValue([task]);
      client.setThreadRead(
        "child-thread",
        threadRead({ previousResult: result, result: "successor result" }),
      );
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
      onTestFinished(() => monitor.dispose());
      await registerParent(monitor, undefined, undefined, historyOwner).unregister();
      await vi.waitFor(() =>
        expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ result }),
        ),
      );
    },
  );

  it.each(
    [false, true].flatMap((active) =>
      ["turn-previous", "turn-1"].flatMap((savedTurnId) =>
        [false, true].map((initial) => ({ active, savedTurnId, initial })),
      ),
    ),
  )(
    "restores the current native turn of an interrupted assignment (active=$active, saved=$savedTurnId, initial=$initial)",
    async ({ active, savedTurnId, initial }) => {
      const client = createClient();
      const runtime = createRuntime();
      const historyOwner = nativeHistoryOwner();
      const task = {
        ...taskRecord({
          historyOwner,
          childThreadId: initial ? "child-thread" : "child-thread:turn:turn-previous",
          status: "running",
        }),
        detail: { nativeHistory: historyOwner, nativeTurnId: savedTurnId },
      };
      runtime.listTaskRecords.mockReturnValue([task]);
      const history = threadRead({
        previousResult: "interrupted",
        result: "resumed result",
        status: active ? "inProgress" : "completed",
        threadStatus: active ? "active" : "idle",
      });
      history.thread.turns![0]!.status = "interrupted";
      if (!active) {
        const later = threadRead({ result: "later assignment result" }).thread.turns![0]!;
        history.thread.turns!.push({ ...later, id: "turn-later" });
      }
      client.setThreadRead("child-thread", history);
      const retainClient = vi.fn(() => () => undefined);
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, { retainClient });
      onTestFinished(() => monitor.dispose());
      await registerParent(monitor, undefined, undefined, historyOwner).unregister();
      if (active) {
        await vi.waitFor(() => expect(retainClient).toHaveBeenCalled());
        const completed = threadRead({ previousResult: "interrupted", result: "resumed result" });
        completed.thread.turns![0]!.status = "interrupted";
        const later = threadRead({ result: "later assignment result" }).thread.turns![0]!;
        completed.thread.turns!.push({ ...later, id: "turn-later" });
        client.setThreadRead("child-thread", completed);
        await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(true);
      }
      await vi.waitFor(() =>
        expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ result: "resumed result" }),
        ),
      );
    },
  );

  it.each(
    [false, true].flatMap((released) => [
      { released, legacy: false, source: "history" },
      { released, legacy: true, source: "history" },
      { released, legacy: true, source: "paged" },
    ]),
  )(
    "admits recovered active work only while its interacting parent is registered (released=$released, legacy=$legacy, source=$source)",
    async ({ released, legacy, source }) => {
      const client = createClient();
      let releaseRead!: (response: CodexThreadReadResponse) => void;
      client.setThreadReadFactory(
        "child-thread",
        () =>
          new Promise((resolve) => {
            releaseRead = resolve;
          }),
      );
      const runtime = createRuntime();
      const nativeHistory = {
        parentThreadId: "parent-thread",
        sessionId: "parent-session",
        connectionFingerprint: "a".repeat(64),
      };
      runtime.listTaskRecords.mockReturnValue([
        {
          ...taskRecord({
            childThreadId: legacy ? "child-thread" : "child-thread:turn:turn-previous",
            status: "running",
          }),
          detail: {
            ...(!legacy ? { nativeTurnId: "turn-previous" } : {}),
            nativeHistory,
          },
        },
      ]);
      const releaseClaim = vi.fn();
      const claimDirectChild = vi.fn(() => releaseClaim);
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
      onTestFinished(() => monitor.dispose());
      const owner = monitor.registerParent({
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:discord:channel:C123",
        taskRuntimeScope: createTaskScope(),
        agentId: "main",
        historyOwner: nativeHistory,
        claimDirectChild,
      });
      owner.bindTurn("parent-turn");
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          item: {
            type: "subAgentActivity",
            id: "interaction",
            kind: "interacted",
            agentThreadId: "child-thread",
            agentPath: "/root/worker",
          },
        },
      });
      expect(claimDirectChild).not.toHaveBeenCalled();
      let unregisterPromise: Promise<void> | undefined;
      if (released) {
        unregisterPromise = owner.unregister();
      }
      const history = threadRead({
        previousResult: "interrupted",
        status: "inProgress",
        threadStatus: "active",
      });
      history.thread.turns![0]!.status = "interrupted";
      if (source === "paged") {
        client.setThreadTurns("child-thread", {
          data: [{ id: "turn-1", status: "inProgress", items: [] }],
        });
        history.thread.status = { type: "systemError" };
        history.thread.turns = [];
      }
      client.setThreadRead("child-thread", history);
      releaseRead(history);
      await vi.waitFor(() =>
        expect(runtime.tryCreateRunningTaskRun).toHaveBeenCalledWith(
          expect.objectContaining({ detail: expect.objectContaining({ nativeTurnId: "turn-1" }) }),
        ),
      );
      expect(claimDirectChild).toHaveBeenCalledTimes(released ? 0 : 1);
      await (unregisterPromise ?? owner.unregister());
      expect(releaseClaim).not.toHaveBeenCalled();
      await client.notify(
        childTurnCompletedNotification({
          turnId: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "result", text: "resumed result" }],
        }),
      );
      expect(releaseClaim).toHaveBeenCalledTimes(released ? 0 : 1);
    },
  );

  it.each([
    ...(["completed", "failed", "interrupted"] as const).flatMap((previousEnd) =>
      (["current", "released", "retired", "replaced"] as const).map((parent) => ({
        previousEnd,
        parent,
        initialActive: false,
        interactionFirst: true,
        received: false,
        proof: "history",
      })),
    ),
    ...(["completed", "interrupted"] as const).map((previousEnd) => ({
      previousEnd,
      parent: "current" as const,
      initialActive: true,
      interactionFirst: true,
      received: false,
      proof: "history",
    })),
    ...(["completed", "interrupted"] as const).map((previousEnd) => ({
      previousEnd,
      parent: "current" as const,
      initialActive: false,
      interactionFirst: false,
      received: true,
      proof: "history",
    })),
    ...(["completed", "failed", "interrupted"] as const).map((previousEnd) => ({
      previousEnd,
      parent: "current" as const,
      initialActive: false,
      interactionFirst: true,
      received: false,
      proof: "notification",
    })),
    ...(["completed", "failed"] as const).map((previousEnd) => ({
      previousEnd,
      parent: "unbound" as const,
      initialActive: false,
      interactionFirst: true,
      received: false,
      proof: "notification",
    })),
  ])(
    "resolves an ambiguous native turn boundary without replacing its predecessor ($previousEnd, $parent, active=$initialActive, receipt=$received, $proof)",
    async ({ previousEnd, parent, initialActive, interactionFirst, received, proof }) => {
      const client = createClient();
      const initial = threadRead({
        turnId: "turn-previous",
        status: "inProgress",
        threadStatus: "active",
      });
      if (!initialActive) {
        initial.thread.turns = [];
      }
      client.setThreadRead("child-thread", initial);
      const nativeHistory = {
        parentThreadId: "parent-thread",
        sessionId: "parent-session",
        connectionFingerprint: "a".repeat(64),
      };
      const original = {
        ...taskRecord({ childThreadId: "child-thread" }),
        runId: "codex-thread:child-thread",
        createdAt: 1,
        detail: { nativeHistory, nativeTurnId: "turn-previous" },
      };
      const records = new Map<string, AgentHarnessTaskRecord>([[original.runId, original]]);
      const executionEvents: unknown[] = [];
      onTestFinished(
        onAgentEvent((event) => {
          if (event.stream === "execution") {
            executionEvents.push(event.data);
          }
        }),
      );
      const runtime = createRecordedRuntime(records);
      const retained = vi.fn(() => () => undefined);
      const releaseClaim = vi.fn();
      const claimDirectChild = vi.fn(() => releaseClaim);
      const replacementClaim = vi.fn(() => () => undefined);
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [],
        retainClient: retained,
      });
      onTestFinished(() => monitor.dispose());
      const owner = monitor.registerParent({
        parentThreadId: "parent-thread",
        requesterSessionKey: original.requesterSessionKey,
        taskRuntimeScope: createTaskScope(),
        historyOwner: nativeHistory,
        claimDirectChild,
      });
      if (parent !== "unbound") {
        owner.bindTurn("parent-turn");
      }
      await vi.waitFor(() => expect(retained).toHaveBeenCalled());
      let releaseRead!: (value: CodexThreadReadResponse) => void;
      const readGate = new Promise<CodexThreadReadResponse>((resolve) => {
        releaseRead = resolve;
      });
      client.setThreadReadFactory("child-thread", () => readGate);
      const interact = () =>
        client.notify({
          method: "item/completed",
          params: {
            threadId: "parent-thread",
            turnId: "parent-turn",
            item: {
              type: "subAgentActivity",
              kind: "interacted",
              agentThreadId: "child-thread",
              agentPath: "/root/worker",
            },
          },
        });
      if (interactionFirst) {
        await interact();
      }
      await client.notify(turnStartedNotification("turn-1"));
      if (!interactionFirst) {
        await interact();
      }
      const recovery = monitor.reconcileChildThread("child-thread");
      const history = threadRead({
        previousResult: "first result",
        result: received ? "The build passed." : undefined,
        status: received ? "completed" : "inProgress",
        threadStatus: received ? "idle" : "active",
      });
      history.thread.turns![0]!.status = previousEnd;
      let replacement: ReturnType<typeof registerParent> | undefined;
      let unregisterPromise: Promise<void> | undefined;
      try {
        expect(records.size).toBe(1);
        expect(records.get(original.runId)).toMatchObject({
          detail: { nativeTurnId: "turn-previous" },
        });
        const priorClaims = initialActive && interactionFirst ? 1 : 0;
        expect(claimDirectChild).toHaveBeenCalledTimes(priorClaims);
        expect(releaseClaim).toHaveBeenCalledTimes(priorClaims);
        const beforeLateProgress = executionEvents.length;
        await client.notify({
          method: "item/agentMessage/delta",
          params: { threadId: "child-thread", turnId: "turn-previous", delta: "late progress" },
        });
        expect(executionEvents).toHaveLength(beforeLateProgress);
        if (received) {
          await client.notify(deliveredNativeCompletion());
          await client.notify(parentSampled());
        }
        if (proof === "notification") {
          await client.notify(
            childTurnCompletedNotification({
              turnId: "turn-previous",
              status: previousEnd,
              ...(previousEnd === "failed" ? { error: "first result" } : {}),
              items: [{ id: "first-final", type: "agentMessage", text: "first result" }],
            }),
          );
          if (parent === "unbound") {
            expect(records.size).toBe(1);
            expect(claimDirectChild).not.toHaveBeenCalled();
            owner.bindTurn("parent-turn");
          }
          expect(records.size).toBe(previousEnd === "interrupted" ? 1 : 2);
          expect(claimDirectChild).toHaveBeenCalledOnce();
        }
        if (parent === "released") {
          unregisterPromise = owner.unregister();
        }
        if (parent === "retired" || parent === "replaced") {
          monitor.retireParent("parent-thread");
        }
        if (parent === "replaced") {
          replacement = monitor.registerParent({
            parentThreadId: "parent-thread",
            claimDirectChild: replacementClaim,
          });
          replacement.bindTurn("replacement-turn");
        }
        releaseRead(history);
        await recovery;
        if (parent === "retired" || parent === "replaced") {
          expect(records.size).toBe(1);
          expect(records.get(original.runId)).toMatchObject({
            status: "cancelled",
            detail: { nativeTurnId: "turn-previous" },
          });
          expect(claimDirectChild).toHaveBeenCalledTimes(priorClaims);
          expect(replacementClaim).not.toHaveBeenCalled();
          return;
        }
        const resultRunId =
          previousEnd === "interrupted" ? original.runId : "codex-thread:child-thread:turn:turn-1";
        expect(records.size).toBe(previousEnd === "interrupted" ? 1 : 2);
        expect(records.get(resultRunId)).toMatchObject({ detail: { nativeTurnId: "turn-1" } });
        expect(claimDirectChild).toHaveBeenCalledTimes(
          priorClaims + ((parent === "current" || parent === "unbound") && !received ? 1 : 0),
        );
        if (received) {
          await monitor.reconcileChildThread("child-thread");
        } else {
          await client.notify(
            childTurnCompletedNotification({
              turnId: "turn-1",
              status: "completed",
              items: [{ id: "next-final", type: "agentMessage", text: "next result" }],
            }),
          );
        }
        expect(records.get(resultRunId)?.terminalSummary).toBe(
          received ? "The build passed." : "next result",
        );
        if (previousEnd !== "interrupted") {
          expect(records.get(original.runId)).toMatchObject({
            terminalSummary: "first result",
            detail: { nativeTurnId: "turn-previous" },
          });
        }
        await owner.unregister();
        if (received) {
          expect(
            runtime.deliverAgentHarnessTaskCompletion.mock.calls.map(([params]) => params.result),
          ).toEqual(previousEnd === "interrupted" ? [] : ["first result"]);
        }
      } finally {
        releaseRead(history);
        await recovery;
        await (unregisterPromise ?? owner.unregister());
        await replacement?.unregister();
      }
    },
  );
});
