import type { AgentHarnessTaskRecord } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  type CodexThreadReadResponse,
  directSpawnItem,
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  createRecordedRuntime,
  createTaskScope,
  registerParent,
  notifyChildStarted,
  deliveredNativeCompletion,
  closeAgentNotification,
  childTurnCompletedNotification,
  turnStartedNotification,
  threadRead,
  taskRecord,
  nativeHistoryOwner,
} from "./native-subagent-monitor.test-support.js";
import { isJsonObject } from "./protocol.js";

describe("CodexNativeSubagentMonitor", () => {
  it.each(
    [
      ...(["completed", "interrupted"] as const).flatMap((firstEnd) =>
        (["completed", "interrupted"] as const).flatMap((secondEnd) =>
          (["current", "released", "unbound"] as const).flatMap((parent) =>
            [false, true].map((secondEndEvent) => ({
              firstEnd,
              secondEnd,
              parent,
              secondEndEvent,
              eventOrder: "interaction-first" as const,
            })),
          ),
        ),
      ),
      ...(["retired", "replaced"] as const).map((parent) => ({
        firstEnd: "completed" as const,
        secondEnd: "completed" as const,
        parent,
        secondEndEvent: false,
        eventOrder: "interaction-first" as const,
      })),
      ...(
        [
          "start-first",
          "interactions-first",
          "starts-first",
          "start-interactions-start",
          "interaction-starts-interaction",
          "end-before-start",
        ] as const
      ).flatMap((eventOrder) =>
        (eventOrder === "end-before-start"
          ? ["unbound" as const]
          : ["current" as const, "unbound" as const]
        ).map((parent) => ({
          firstEnd: "completed" as const,
          secondEnd: "completed" as const,
          parent,
          secondEndEvent: true,
          eventOrder,
        })),
      ),
    ].flatMap((scenario) => {
      const options = {
        legacy: false,
        savedTurn: true,
        observedPredecessorEnd: false,
        metadataFirst: false,
      };
      const scenarios = [Object.assign({}, scenario, options)];
      const lateInteractions = ["interactions-first", "starts-first"].includes(scenario.eventOrder);
      if (lateInteractions || scenario.parent === "retired" || scenario.parent === "replaced") {
        scenarios.push(Object.assign({}, scenario, options, { legacy: true }));
      }
      if (lateInteractions && scenario.parent === "current") {
        scenarios.push(
          Object.assign({}, scenario, options, { parent: "released" as const, legacy: true }),
        );
        for (const observedPredecessorEnd of [false, true]) {
          scenarios.push(
            Object.assign({}, scenario, options, {
              legacy: true,
              savedTurn: false,
              observedPredecessorEnd,
            }),
          );
          scenarios.push(
            Object.assign({}, scenario, options, {
              legacy: false,
              savedTurn: false,
              observedPredecessorEnd,
              secondEndEvent: false,
            }),
          );
        }
        scenarios.push(
          Object.assign({}, scenario, options, {
            legacy: true,
            savedTurn: false,
            metadataFirst: true,
            secondEndEvent: false,
          }),
        );
      }
      return scenarios;
    }),
  )(
    "preserves queued native turns until every boundary resolves ($firstEnd, $secondEnd, $parent, end-event=$secondEndEvent, order=$eventOrder, legacy=$legacy, saved=$savedTurn, observed-end=$observedPredecessorEnd, metadata-first=$metadataFirst)",
    async ({
      firstEnd,
      secondEnd,
      parent,
      secondEndEvent,
      eventOrder,
      legacy,
      savedTurn,
      observedPredecessorEnd,
      metadataFirst,
    }) => {
      const client = createClient();
      const initial = threadRead({
        turnId: "turn-a",
        status: "inProgress",
        threadStatus: "active",
      });
      initial.thread.turns = [];
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
        detail: {
          ...(legacy ? {} : { nativeHistory }),
          ...(savedTurn ? { nativeTurnId: "turn-a" } : {}),
        },
      };
      const originalSnapshot = structuredClone(original);
      const records = new Map<string, AgentHarnessTaskRecord>([[original.runId, original]]);
      const runtime = createRecordedRuntime(records);
      const releaseClaim = vi.fn();
      const claimDirectChild = vi.fn(() => releaseClaim);
      const rejectPendingDirectChild = vi.fn();
      const replacementClaim = vi.fn(() => () => undefined);
      const retained = vi.fn(() => () => undefined);
      let releaseRead!: (value: CodexThreadReadResponse) => void;
      const readGate = new Promise<CodexThreadReadResponse>((resolve) => {
        releaseRead = resolve;
      });
      if ((legacy || !savedTurn) && !metadataFirst) {
        client.setThreadReadFactory("child-thread", () => readGate);
      }
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [10],
        retainClient: retained,
      });
      onTestFinished(() => monitor.dispose());
      const owner = await monitor.registerParent({
        parentThreadId: "parent-thread",
        requesterSessionKey: original.requesterSessionKey,
        taskRuntimeScope: createTaskScope(),
        historyOwner: nativeHistory,
        claimDirectChild,
        rejectPendingDirectChild,
      });
      if (parent !== "unbound") {
        owner.bindTurn("parent-turn");
      } else {
        await client.notify(turnStartedNotification("parent-turn", { threadId: "parent-thread" }));
      }
      if (legacy || (!savedTurn && !metadataFirst)) {
        await vi.waitFor(() => expect(client.request).toHaveBeenCalled());
        if (metadataFirst) {
          client.setThreadReadFactory("child-thread", () => readGate);
        }
      } else {
        await vi.waitFor(() => expect(retained).toHaveBeenCalled());
        client.setThreadReadFactory("child-thread", () => readGate);
      }
      const interact = (id: string) =>
        client.notify({
          method: "item/completed",
          params: {
            threadId: "parent-thread",
            turnId: "parent-turn",
            item: {
              id,
              type: "subAgentActivity",
              kind: "interacted",
              agentThreadId: "child-thread",
              agentPath: "/root/worker",
            },
          },
        });
      const start = (id: string) => client.notify(turnStartedNotification(id));
      const eventActions = {
        interactionB: () => interact("admit-b"),
        interactionC: () => interact("admit-c"),
        startB: async () => {
          await start("turn-b");
          if (secondEndEvent) {
            await client.notify(
              childTurnCompletedNotification({ turnId: "turn-b", status: secondEnd }),
            );
          }
        },
        startC: () => start("turn-c"),
        endA: async () => {
          await client.notify(
            childTurnCompletedNotification({
              turnId: "turn-a",
              status: firstEnd,
              items: [{ id: "first-result", type: "agentMessage", text: "first result" }],
            }),
          );
          expect(rejectPendingDirectChild).not.toHaveBeenCalled();
        },
      };
      const eventOrders = {
        "interaction-first": ["interactionB", "startB", "interactionC", "startC"],
        "start-first": ["startB", "interactionB", "startC", "interactionC"],
        "interactions-first": ["interactionB", "interactionC", "startB", "startC"],
        "starts-first": ["startB", "startC", "interactionB", "interactionC"],
        "start-interactions-start": ["startB", "interactionB", "interactionC", "startC"],
        "interaction-starts-interaction": ["interactionB", "startB", "startC", "interactionC"],
        "end-before-start": ["interactionB", "endA", "startB", "interactionC", "startC"],
      } as const;
      if (observedPredecessorEnd) {
        await eventActions.endA();
      }
      for (const event of eventOrders[eventOrder]) {
        await eventActions[event]();
      }
      await client.notify(deliveredNativeCompletion());
      const recovery = monitor.reconcileChildThread("child-thread");
      const history = threadRead({ turnId: "turn-c", result: "The build passed." });
      history.thread.turns!.unshift(
        ...threadRead({ turnId: "turn-a", status: firstEnd, result: "first result" }).thread.turns!,
        ...threadRead({ turnId: "turn-b", status: secondEnd, result: "second result" }).thread
          .turns!,
      );
      if (!savedTurn) {
        history.thread.forkedFromId = "parent-thread";
        history.thread.turns!.unshift(
          ...threadRead({ turnId: "copied-parent-turn", result: "copied parent result" }).thread
            .turns!,
        );
      }
      let replacement: Awaited<ReturnType<typeof registerParent>> | undefined;
      let unregisterPromise: Promise<void> | undefined;
      try {
        expect(records.size).toBe(1);
        expect(claimDirectChild).not.toHaveBeenCalled();
        if (parent === "unbound") {
          owner.bindTurn("parent-turn");
        }
        if (parent === "released") {
          unregisterPromise = owner.unregister();
        }
        if (parent === "retired" || parent === "replaced") {
          monitor.retireParent("parent-thread");
        }
        if (parent === "replaced") {
          replacement = await monitor.registerParent({
            parentThreadId: "parent-thread",
            claimDirectChild: replacementClaim,
          });
          replacement.bindTurn("replacement-turn");
        }
        client.setThreadRead("child-thread", history);
        releaseRead(history);
        await recovery;
        if (legacy) {
          await (unregisterPromise ?? owner.unregister());
          expect(records.size).toBe(1);
          expect(records.get(original.runId)).toEqual(originalSnapshot);
          expect(runtime.createRunningTaskRun).not.toHaveBeenCalled();
          expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
          expect(runtime.setDetachedTaskDeliveryStatusByRunId).not.toHaveBeenCalled();
          expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
          expect(claimDirectChild).not.toHaveBeenCalled();
          expect(replacementClaim).not.toHaveBeenCalled();
          return;
        }
        if (!savedTurn && !observedPredecessorEnd) {
          await vi.waitFor(() =>
            expect(
              client.request.mock.calls.filter(
                ([method, params]) =>
                  method === "thread/read" &&
                  isJsonObject(params) &&
                  params.threadId === "child-thread",
              ).length,
            ).toBeGreaterThan(1),
          );
          await monitor.reconcileChildThread("child-thread");
          expect(records.size).toBe(1);
          expect(records.get(original.runId)).toMatchObject({
            status: "running",
            deliveryStatus: "not_applicable",
          });
          expect(records.get(original.runId)?.detail).not.toHaveProperty("nativeTurnId");
          expect(records.get(original.runId)?.terminalSummary).toBeUndefined();
          expect(claimDirectChild).not.toHaveBeenCalled();
          expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
          return;
        }
        if (parent === "retired" || parent === "replaced") {
          expect(records.size).toBe(1);
          expect(records.get(original.runId)).toMatchObject({
            status: legacy ? "running" : "cancelled",
            detail: { nativeTurnId: "turn-a" },
          });
          expect(replacementClaim).not.toHaveBeenCalled();
          return;
        }
        const expected = [
          ...(firstEnd === "completed"
            ? [{ runId: original.runId, turnId: "turn-a", result: "first result" }]
            : []),
          ...(secondEnd === "completed"
            ? [
                {
                  runId:
                    firstEnd === "completed"
                      ? "codex-thread:child-thread:turn:turn-b"
                      : original.runId,
                  turnId: "turn-b",
                  result: "second result",
                },
              ]
            : []),
          {
            runId:
              secondEnd === "completed"
                ? "codex-thread:child-thread:turn:turn-c"
                : firstEnd === "completed"
                  ? "codex-thread:child-thread:turn:turn-b"
                  : original.runId,
            turnId: "turn-c",
            result: "The build passed.",
          },
        ];
        await vi.waitFor(() => {
          expect(records.size).toBe(expected.length);
          for (const assignment of expected) {
            expect(records.get(assignment.runId)).toMatchObject({
              status: "succeeded",
              terminalSummary: assignment.result,
              detail: { nativeTurnId: assignment.turnId },
            });
          }
        });
        const activeClaims = eventOrder === "end-before-start" ? 1 : 0;
        expect(claimDirectChild).toHaveBeenCalledTimes(activeClaims);
        expect(releaseClaim).toHaveBeenCalledTimes(activeClaims);
        await owner.unregister();
        await vi.waitFor(() =>
          expect([...records.values()].every((task) => task.deliveryStatus === "delivered")).toBe(
            true,
          ),
        );
        expect(
          runtime.deliverAgentHarnessTaskCompletion.mock.calls
            .map(([params]) => params.result)
            .toSorted(),
        ).toEqual(
          expected
            .filter((assignment) => assignment.result !== "The build passed.")
            .map((assignment) => assignment.result)
            .toSorted(),
        );
      } finally {
        releaseRead(history);
        await recovery;
        await (unregisterPromise ?? owner.unregister());
        await replacement?.unregister();
      }
    },
  );

  it.each(
    [
      ...(["completed", "interrupted"] as const).flatMap((previousEnd) =>
        (["bound", "unbound", "returned"] as const).map((parent) => ({
          status: "running" as const,
          previousEnd,
          parent,
        })),
      ),
      ...(["succeeded", "failed", "cancelled"] as const).map((status) => ({
        status,
        previousEnd: "interrupted" as const,
        parent: "unbound" as const,
      })),
    ].flatMap((scenario) => [false, true].map((legacy) => Object.assign({ legacy }, scenario))),
  )(
    "classifies the stored predecessor before admitting a turn during restoration ($status, $previousEnd, $parent, legacy=$legacy)",
    async ({ status, previousEnd, parent, legacy }) => {
      const client = createClient();
      const nativeHistory = {
        parentThreadId: "parent-thread",
        sessionId: "parent-session",
        connectionFingerprint: "a".repeat(64),
      };
      const original = {
        ...taskRecord({
          childThreadId: "child-thread",
          status,
          deliveryStatus: status === "running" ? "not_applicable" : "pending",
        }),
        runId: "codex-thread:child-thread",
        detail: { ...(legacy ? {} : { nativeHistory }), nativeTurnId: "turn-previous" },
        ...(status === "running" ? {} : { terminalSummary: "recorded result" }),
      };
      const originalSnapshot = structuredClone(original);
      const records = new Map<string, AgentHarnessTaskRecord>([[original.runId, original]]);
      const runtime = createRecordedRuntime(records);
      let releaseRead!: (value: CodexThreadReadResponse) => void;
      const readGate = new Promise<CodexThreadReadResponse>((resolve) => {
        releaseRead = resolve;
      });
      client.setThreadReadFactory("child-thread", () => readGate);
      const claimDirectChild = vi.fn(() => () => undefined);
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [10],
      });
      onTestFinished(() => monitor.dispose());
      const owner = await monitor.registerParent({
        parentThreadId: "parent-thread",
        requesterSessionKey: original.requesterSessionKey,
        taskRuntimeScope: createTaskScope(),
        historyOwner: nativeHistory,
        claimDirectChild,
      });
      if (parent !== "unbound") {
        owner.bindTurn("parent-turn");
      }
      const history = threadRead({
        previousResult: "first result",
        status: "inProgress",
        threadStatus: "active",
      });
      history.thread.turns![0]!.status = previousEnd;
      let unregisterPromise: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(client.request).toHaveBeenCalled());
        await client.notify({
          method: "item/completed",
          params: {
            threadId: "parent-thread",
            turnId: "parent-turn",
            item: {
              id: "followup",
              type: "subAgentActivity",
              kind: "interacted",
              agentThreadId: "child-thread",
            },
          },
        });
        await client.notify(turnStartedNotification("turn-1"));
        expect(records.size).toBe(1);
        expect(records.get(original.runId)).toMatchObject({
          detail: { nativeTurnId: "turn-previous" },
        });
        expect(claimDirectChild).not.toHaveBeenCalled();
        if (parent === "returned") {
          unregisterPromise = owner.unregister();
        }
        client.setThreadRead("child-thread", history);
        releaseRead(history);
        if (legacy) {
          await (unregisterPromise ?? owner.unregister());
          expect(records.size).toBe(1);
          expect(records.get(original.runId)).toEqual(originalSnapshot);
          expect(runtime.createRunningTaskRun).not.toHaveBeenCalled();
          expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
          expect(runtime.setDetachedTaskDeliveryStatusByRunId).not.toHaveBeenCalled();
          expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
          expect(claimDirectChild).not.toHaveBeenCalled();
          return;
        }
        const resumed = status === "running" && previousEnd === "interrupted";
        if (resumed) {
          await vi.waitFor(() =>
            expect(records.get(original.runId)).toMatchObject({
              detail: { nativeTurnId: "turn-1" },
            }),
          );
        } else {
          await vi.waitFor(() =>
            expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
              expect.objectContaining({
                runId: original.runId,
                detail: expect.objectContaining({ nativeTurnId: "turn-previous" }),
              }),
            ),
          );
        }
        if (parent === "unbound") {
          owner.bindTurn("parent-turn");
        }
        const resultRunId = resumed ? original.runId : "codex-thread:child-thread:turn:turn-1";
        await vi.waitFor(() =>
          expect(records.get(resultRunId)).toMatchObject({ detail: { nativeTurnId: "turn-1" } }),
        );
        expect(records.size).toBe(resumed ? 1 : 2);
        expect(claimDirectChild).toHaveBeenCalledTimes(parent === "returned" ? 0 : 1);
        if (!resumed) {
          expect(records.get(original.runId)).toMatchObject({
            status: status === "running" ? "succeeded" : status,
            detail: { nativeTurnId: "turn-previous" },
            terminalSummary: status === "running" ? "first result" : "recorded result",
          });
        }
        await client.notify(
          childTurnCompletedNotification({
            turnId: "turn-1",
            status: "completed",
            items: [{ id: "final", type: "agentMessage", text: "later result" }],
          }),
        );
        expect(records.get(resultRunId)?.terminalSummary).toBe("later result");
        await owner.unregister();
        await vi.waitFor(() =>
          expect([...records.values()].every((task) => task.deliveryStatus === "delivered")).toBe(
            true,
          ),
        );
      } finally {
        client.setThreadRead("child-thread", history);
        releaseRead(history);
        await (unregisterPromise ?? owner.unregister());
      }
    },
  );

  it("claims a saved active turn whose start arrives before restoration finishes", async () => {
    const client = createClient();
    const nativeHistory = {
      parentThreadId: "parent-thread",
      sessionId: "parent-session",
      connectionFingerprint: "a".repeat(64),
    };
    const task = {
      ...taskRecord({ childThreadId: "child-thread" }),
      runId: "codex-thread:child-thread",
      detail: { nativeHistory, nativeTurnId: "turn-1" },
    };
    const records = new Map<string, AgentHarnessTaskRecord>([[task.runId, task]]);
    const runtime = createRecordedRuntime(records);
    let releaseRead!: (value: CodexThreadReadResponse) => void;
    const readGate = new Promise<CodexThreadReadResponse>((resolve) => {
      releaseRead = resolve;
    });
    client.setThreadReadFactory("child-thread", () => readGate);
    const claimDirectChild = vi.fn(() => () => undefined);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      recoveryPollDelaysMs: [],
    });
    onTestFinished(() => monitor.dispose());
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: task.requesterSessionKey,
      taskRuntimeScope: createTaskScope(),
      historyOwner: nativeHistory,
      claimDirectChild,
    });
    owner.bindTurn("parent-turn");
    const history = threadRead({ status: "inProgress", threadStatus: "active" });
    try {
      await vi.waitFor(() => expect(client.request).toHaveBeenCalled());
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          item: {
            id: "resume",
            type: "subAgentActivity",
            kind: "interacted",
            agentThreadId: "child-thread",
          },
        },
      });
      await client.notify(turnStartedNotification("turn-1"));
      expect(records.size).toBe(1);
      expect(records.get(task.runId)).toMatchObject({ detail: { nativeTurnId: "turn-1" } });
      expect(claimDirectChild).toHaveBeenCalledOnce();
    } finally {
      client.setThreadRead("child-thread", history);
      releaseRead(history);
      await owner.unregister();
    }
  });

  it("keeps follow-up admission through repeated active predecessor history", async () => {
    const client = createClient();
    client.setThreadRead(
      "child-thread",
      threadRead({ turnId: "turn-a", status: "inProgress", threadStatus: "active" }),
    );
    const runtime = createRuntime();
    const claimDirectChild = vi.fn(() => () => undefined);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      recoveryPollDelaysMs: [],
    });
    onTestFinished(() => monitor.dispose());
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:main",
      taskRuntimeScope: createTaskScope("agent:main:main"),
      claimDirectChild,
    });
    owner.bindTurn("parent-turn");
    await notifyChildStarted(client);
    await client.notify(turnStartedNotification("turn-a"));
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: { type: "subAgentActivity", kind: "interacted", agentThreadId: "child-thread" },
      },
    });
    await monitor.reconcileChildThread("child-thread");
    await monitor.reconcileChildThread("child-thread");
    await client.notify(
      childTurnCompletedNotification({
        turnId: "turn-a",
        status: "completed",
        items: [{ id: "first-result", type: "agentMessage", text: "first result" }],
      }),
    );
    await client.notify(turnStartedNotification("turn-b"));
    expect(runtime.createRunningTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "codex-thread:child-thread:turn:turn-b" }),
    );
    expect(claimDirectChild).toHaveBeenCalledTimes(2);
    await owner.unregister();
  });

  it("requires active native evidence before claiming a restored saved turn", async () => {
    const client = createClient();
    const historyOwner = nativeHistoryOwner();
    const metadata = threadRead();
    metadata.thread.turns = [];
    client.setThreadRead("child-thread", metadata);
    const runtime = createRuntime();
    runtime.listTaskRecords.mockReturnValue([
      {
        ...taskRecord({ childThreadId: "child-thread:turn:turn-1" }),
        detail: { nativeHistory: historyOwner, nativeTurnId: "turn-1" },
      },
    ]);
    const retained = vi.fn(() => () => undefined);
    const claimDirectChild = vi.fn(() => () => undefined);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      recoveryPollDelaysMs: [],
      retainClient: retained,
    });
    onTestFinished(() => monitor.dispose());
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:discord:channel:C123",
      taskRuntimeScope: createTaskScope(),
      historyOwner,
      claimDirectChild,
    });
    owner.bindTurn("parent-turn");
    await vi.waitFor(() => expect(retained).toHaveBeenCalled());
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: { type: "subAgentActivity", kind: "interacted", agentThreadId: "child-thread" },
      },
    });
    expect(claimDirectChild).not.toHaveBeenCalled();
    await client.notify(turnStartedNotification("turn-1"));
    expect(claimDirectChild).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "keeps a delivered successor current during older recovery (legacy=%s)",
    async (legacy) => {
      const client = createClient();
      client.setLoadedThreads(["child-thread"]);
      const metadata = threadRead();
      metadata.thread.turns = [];
      client.setThreadRead("child-thread", metadata);
      const nativeHistory = {
        parentThreadId: "parent-thread",
        sessionId: "parent-session",
        connectionFingerprint: "a".repeat(64),
      };
      const runtime = createRuntime();
      runtime.listTaskRecords.mockReturnValue([
        {
          ...taskRecord({ childThreadId: "child-thread" }),
          createdAt: 1,
          detail: { nativeHistory, nativeTurnId: "turn-previous" },
        },
        {
          ...taskRecord({
            childThreadId: "child-thread:turn:turn-1",
            status: "succeeded",
            deliveryStatus: "delivered",
          }),
          createdAt: 2,
          terminalSummary: "Delivered result.",
          detail: { ...(legacy ? {} : { nativeHistory }), nativeTurnId: "turn-1" },
        },
      ]);
      const retained = vi.fn(() => () => undefined);
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [],
        retainClient: retained,
      });
      onTestFinished(() => monitor.dispose());
      const owner = await monitor.registerParent({
        parentThreadId: "parent-thread",
        requesterSessionKey: "agent:main:discord:channel:C123",
        taskRuntimeScope: createTaskScope(),
        agentId: "main",
        historyOwner: nativeHistory,
      });
      owner.bindTurn("parent-turn");
      await vi.waitFor(() => expect(retained).toHaveBeenCalled());
      await client.notify(
        closeAgentNotification({ method: "item/started", itemId: "close-recovered-child" }),
      );
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          item: {
            type: "collabAgentToolCall",
            id: "close-recovered-child",
            tool: "closeAgent",
            status: "failed",
            senderThreadId: "parent-thread",
            receiverThreadIds: ["child-thread"],
            agentsStates: {
              "child-thread": { status: "errored", message: "stale lifecycle error" },
            },
          },
        },
      });
      expect(client.request.mock.calls.map(([method]) => method)).toContain("thread/loaded/list");
      expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
      expect(runtime.recordTaskRunProgressByRunId).not.toHaveBeenCalled();
      await client.notify({
        method: "item/completed",
        params: {
          threadId: "parent-thread",
          turnId: "parent-turn",
          item: { type: "subAgentActivity", kind: "interacted", agentThreadId: "child-thread" },
        },
      });
      await client.notify(turnStartedNotification("turn-next"));
      expect(runtime.createRunningTaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "codex-thread:child-thread:turn:turn-next",
        }),
      );
      expect(runtime.createRunningTaskRun).not.toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "codex-thread:child-thread",
          detail: expect.objectContaining({ nativeTurnId: "turn-next" }),
        }),
      );
    },
  );

  it("releases direct authority when history ends a native turn before its final text arrives", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const releaseClaim = vi.fn();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    onTestFinished(() => monitor.dispose());
    const owner = await monitor.registerParent({
      parentThreadId: "parent-thread",
      claimDirectChild: () => releaseClaim,
    });
    owner.bindTurn("parent-turn");
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: directSpawnItem("v2", "parent-thread", "child-thread"),
      },
    });
    await client.notify(turnStartedNotification("turn-1", { error: null }));
    client.setThreadRead("child-thread", threadRead({ status: "completed" }));
    await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(false);
    expect(releaseClaim).toHaveBeenCalledOnce();
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });
});
