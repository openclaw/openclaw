import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createNativeSubagentCompletionCustodyFixture } from "./native-subagent-custody.test-support.js";
import {
  agentMessage,
  collabItem,
  CodexNativeSubagentMonitor,
  createClient,
  createMonitorFixture,
  createRuntime,
  notifyChildStarted,
  parentRegistration,
  threadRead,
} from "./native-subagent-monitor.test-support.js";

const target = "00000000-0000-4000-8000-000000000042";

describe("Codex native input target scope", () => {
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

async function coldChild() {
  const { client, monitor, runtime } = createMonitorFixture();
  const custody = createNativeSubagentCompletionCustodyFixture();
  runtime.captureAgentHarnessCompletionCustody.mockResolvedValue(custody.root);
  const parent = await monitor.registerParent(parentRegistration({ modelSource: undefined }));
  parent.bindTurn("parent-turn");
  onTestFinished(async () => {
    await parent.unregister();
    await monitor.dispose();
  });
  const metadata = threadRead({ childThreadId: target, agentPath: "/root/worker" });
  metadata.thread.modelProvider = "test-provider";
  metadata.thread.turns = [];
  client.setThreadRead(target, metadata);
  const first = {
    id: "first",
    status: "completed",
    completedAt: 100,
    itemsView: "summary",
    items: [agentMessage("answer-1", "First result", "final_answer")],
  };
  client.setThreadTurns(target, { data: [first], nextCursor: null });
  const prepare = (returnsSubmissionId = true) =>
    monitor.prepareModelInput({
      threadId: "parent-thread",
      turnId: "parent-turn",
      itemId: "input",
      target,
      returnsSubmissionId,
      readQualification: () => undefined,
      assertCurrent: () => {},
    });
  return { parent, client, runtime, metadata, first, prepare };
}

it.each(["First result", "Second result"])(
  "attributes a receipt for %s after resuming a settled child on a fresh client",
  async (result) => {
    const { client, parent, runtime, prepare } = await coldChild();
    await client.item(
      collabItem("resumeAgent", [target], { status: "inProgress" }),
      "parent-turn",
      "parent-thread",
      "started",
    );
    await client.item(collabItem("resumeAgent", [target]));
    await prepare();
    await client.item(collabItem("sendInput", [target], { id: "input" }));
    await client.sendInputOutput({ callId: "input", submissionId: "second" });
    await client.startTurn("second", { threadId: target });
    await client.completeNative({ agentPath: "/root/worker", turnId: "parent-turn", result });
    await client.completeTurn({
      threadId: target,
      turnId: "second",
      status: "completed",
      items: [agentMessage("answer", "Second result", "final_answer")],
    });
    await parent.unregister();
    if (result === "Second result") {
      expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      return;
    }
    expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        announceId: `codex-native:parent-thread:codex-thread:${target}:turn:second:succeeded`,
        completionCustody: expect.anything(),
        result: "Second result",
      }),
    );
  },
);

it.each(["fork", "multiple turns", "more pages", "commentary only", "failed turn"] as const)(
  "does not assign an inferred follow-up to %s",
  async (kind) => {
    const { metadata, client, first, prepare, parent } = await coldChild();
    if (kind === "fork") {
      metadata.thread.forkedFromId = "parent-thread";
    } else if (kind === "multiple turns") {
      client.setThreadTurns(target, { data: [{ ...first, id: "another" }, first] });
    } else if (kind === "more pages") {
      client.setThreadTurns(target, { data: [first], nextCursor: "earlier" });
    } else if (kind === "commentary only") {
      first.items = [agentMessage("update", "Working", "commentary")];
    } else {
      first.status = "failed";
    }
    await prepare();
    await client.sendInputOutput({ callId: "input", submissionId: "second" });
    await client.startTurn("second", { threadId: target });
    expect(parent.listPendingChildren().map((child) => child.runId)).not.toContain(
      `codex-thread:${target}:turn:second`,
    );
  },
);

it("does not read history for inputs without a native submission ID", async () => {
  const { client, prepare } = await coldChild();
  await prepare(false);
  expect(client.request.mock.calls.map(([method]) => method)).not.toContain("thread/turns/list");
});

it("refuses active children without an admitted execution before reading turn metadata", async () => {
  const { metadata, client, prepare } = await coldChild();
  metadata.thread.status = { type: "active" };
  await expect(prepare()).rejects.toThrow("receiver's exact admitted execution");
  expect(client.request.mock.calls.map(([method]) => method)).not.toContain("thread/turns/list");
});

it("refuses stale metadata after a receiver appears during turn lookup", async () => {
  const { client, first, metadata, prepare } = await coldChild();
  client.request.mockResolvedValueOnce(metadata).mockImplementationOnce(async () => {
    await notifyChildStarted(client, "parent-thread", target);
    return { data: [first], nextCursor: null };
  });
  await expect(prepare()).rejects.toThrow("receiver changed during input preparation");
});
