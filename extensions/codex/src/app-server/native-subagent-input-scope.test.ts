import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import {
  agentMessage,
  collabItem,
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  notifyChildStarted,
  observeCompletionAttempts,
  parentRegistration,
  threadRead,
} from "./native-subagent-monitor.test-support.js";

describe("Codex native input target scope", () => {
  it.for([
    { order: "notification first", prepare: true },
    { order: "inference first", prepare: true },
    { order: "notification first", prepare: false },
    { order: "inference first", prepare: false },
  ] as const)(
    "assigns a collected receiver to its accepted native turn ($order, preparation=$prepare)",
    async ({ order, prepare }, { signal }) => {
      const client = createClient();
      const runtime = createRuntime();
      const claimChildThread = vi.fn(async () => {});
      const monitor = new CodexNativeSubagentMonitor(client.client, runtime, { claimChildThread });
      const completions = observeCompletionAttempts();
      const childId = "00000000-0000-4000-8000-000000000042";
      const first = await monitor.registerParent(parentRegistration());
      let second: typeof first | undefined;
      try {
        first.bindTurn("first-parent-turn");
        await notifyChildStarted(client, "parent-thread", childId);
        await client.spawn(childId, "first-parent-turn");
        await client.startTurn("first-child-turn", { threadId: childId });
        await client.completeTurn({
          threadId: childId,
          turnId: "first-child-turn",
          status: "completed",
          items: [agentMessage("first-result", "Initial result", "final_answer")],
        });
        await first.unregister();
        await completions.settle();
        expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ childSessionKey: `codex-thread:${childId}` }),
        );
        claimChildThread.mockClear();
        const metadata = threadRead({ childThreadId: childId, threadStatus: "notLoaded" });
        metadata.thread.modelProvider = "test-provider";
        client.setThreadRead(childId, metadata);
        const source = { sourceIdentity: {}, assertCurrent: vi.fn(), release: vi.fn() };
        const qualification = {
          assertCurrent: () => {},
          hasProvider: (provider: string) => provider === "test-provider",
        };
        second = await monitor.registerParent(
          parentRegistration({ modelSource: source, configurationQualification: qualification }),
        );
        second.bindTurn("second-parent-turn");
        if (prepare) {
          await monitor.prepareModelInput({
            threadId: "parent-thread",
            turnId: "second-parent-turn",
            itemId: "followup-input",
            target: childId,
            readQualification: () => qualification,
            assertCurrent: () => {},
          });
        }
        // Preparation and receiver observations must not recreate the initial task.
        await client.item(
          collabItem("sendInput", [childId], { id: "followup-input", status: "inProgress" }),
          "second-parent-turn",
          "parent-thread",
          "started",
        );
        if (order === "notification first") {
          await client.startTurn("second-child-turn", { threadId: childId });
        }
        expect(claimChildThread).not.toHaveBeenCalled();
        expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledTimes(1);
        await client.item(
          collabItem("sendInput", [childId], { id: "followup-input" }),
          "second-parent-turn",
        );
        const pending = monitor.captureModelSource({
          threadId: childId,
          turnId: "second-child-turn",
          parentThreadId: "parent-thread",
          parentTurnId: "second-parent-turn",
          rootTurnId: "second-parent-turn",
          signal,
        });
        void pending.catch(() => {});
        await client.sendInputOutput({
          turnId: "second-parent-turn",
          callId: "followup-input",
          submissionId: "second-child-turn",
        });
        const capture = await pending;
        assert(capture, "Accepted follow-up lost its current model source");
        expect(capture.source).toBe(source);
        capture.assertCurrent();
        capture.release();
        await client.startTurn("second-child-turn", { threadId: childId });
        await client.startTurn("second-child-turn", { threadId: childId });
        for (let repeat = 0; repeat < 2; repeat += 1) {
          await client.completeTurn({
            threadId: childId,
            turnId: "second-child-turn",
            status: "completed",
            items: [agentMessage("second-result", "Follow-up result", "final_answer")],
          });
        }
        await second.unregister();
        await completions.settle();
        expect(
          runtime.deliverAgentHarnessCompletion.mock.calls.map(([call]) => ({
            key: call.childSessionKey,
            result: call.result,
          })),
        ).toEqual([
          { key: `codex-thread:${childId}`, result: "Initial result" },
          { key: `codex-thread:${childId}:turn:second-child-turn`, result: "Follow-up result" },
        ]);
        expect(
          new Set(runtime.deliverAgentHarnessCompletion.mock.calls.map(([call]) => call.announceId))
            .size,
        ).toBe(2);
      } finally {
        await first.unregister();
        await second?.unregister();
        await monitor.dispose();
        await completions.settle();
      }
    },
  );

  it("does not execute a prepared restored receiver after its parent retires", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const claimChildThread = vi.fn(async () => {});
    const monitor = new CodexNativeSubagentMonitor(client.client, runtime, { claimChildThread });
    const parent = await monitor.registerParent(parentRegistration({ modelSource: undefined }));
    const target = "00000000-0000-4000-8000-000000000042";
    const metadata = threadRead({ childThreadId: target, threadStatus: "idle" });
    metadata.thread.modelProvider = "test-provider";
    client.setThreadRead(target, metadata);
    try {
      parent.bindTurn("parent-turn");
      await monitor.prepareModelInput({
        threadId: "parent-thread",
        turnId: "parent-turn",
        itemId: "prepared-input",
        target,
        readQualification: () => undefined,
        assertCurrent: () => {},
      });
      expect(claimChildThread).not.toHaveBeenCalled();
      await monitor.retireParent("parent-thread");
      await client.sendInputOutput({ callId: "prepared-input", submissionId: "late-turn" });
      await client.startTurn("late-turn", { threadId: target });
      expect(
        await monitor.captureModelSource({
          threadId: target,
          turnId: "late-turn",
          parentThreadId: "parent-thread",
          parentTurnId: "parent-turn",
          rootTurnId: "parent-turn",
        }),
      ).toBeUndefined();
      expect(claimChildThread).not.toHaveBeenCalled();
      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
    } finally {
      await parent.unregister();
      await monitor.dispose();
    }
  });

  it.each([
    ["unknown", "idle"],
    ["unknown", "notLoaded"],
    ["unknown", "active"],
    ["unrelated root", "idle"],
    ["unrelated root", "notLoaded"],
    ["unrelated root", "active"],
    ["unrelated child", "idle"],
    ["unrelated child", "notLoaded"],
    ["unrelated child", "active"],
  ] as const)("rejects %s input with %s target state", async (kind, status) => {
    const client = createClient();
    const monitor = new CodexNativeSubagentMonitor(client.client, createRuntime());
    const sender = await monitor.registerParent({
      parentThreadId: "parent-thread",
      modelSource: undefined,
    });
    sender.bindTurn("sender-turn");
    const target = "00000000-0000-4000-8000-000000000042";
    const foreign = await monitor.registerParent({
      parentThreadId: kind === "unrelated root" ? target : "unrelated-root",
      modelSource: undefined,
    });
    foreign.bindTurn("foreign-turn");
    if (kind === "unrelated child") {
      await notifyChildStarted(client, "unrelated-root", target, "/root/worker");
    }
    const metadata = threadRead({ childThreadId: target, threadStatus: status });
    metadata.thread.modelProvider = "test-provider";
    if (kind !== "unrelated child") {
      delete metadata.thread.parentThreadId;
      delete metadata.thread.source;
    }
    client.setThreadRead(target, metadata);
    client.request.mockClear();
    const nativeWrite = vi.fn();
    try {
      await expect(
        monitor
          .prepareModelInput({
            threadId: "parent-thread",
            turnId: "sender-turn",
            itemId: "input",
            target,
            readQualification: () => undefined,
            assertCurrent: () => {},
          })
          .then(nativeWrite),
      ).rejects.toThrow("outside the sender's admitted tree");
      expect(nativeWrite).not.toHaveBeenCalled();
      if (kind !== "unknown") {
        expect(client.request).not.toHaveBeenCalledWith(
          "thread/read",
          { threadId: target, includeTurns: false },
          expect.anything(),
        );
      } else {
        // Cold same-tree recovery needs native metadata, never turn history.
        expect(client.request).toHaveBeenCalledWith(
          "thread/read",
          { threadId: target, includeTurns: false },
          expect.anything(),
        );
      }
    } finally {
      await monitor.dispose();
      await sender.unregister();
      await foreign.unregister();
    }
  });
});
