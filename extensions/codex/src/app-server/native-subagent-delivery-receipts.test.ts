import { describe, expect, it } from "vitest";
import { CodexNativeSubagentDeliveryReceipts } from "./native-subagent-delivery-receipts.js";
import type { CodexServerNotification } from "./protocol.js";

function completedWaitReceipt(message: string, id = "wait"): CodexServerNotification {
  return {
    method: "item/completed",
    params: {
      threadId: "parent-thread",
      turnId: "parent-turn",
      item: {
        type: "collabAgentToolCall",
        id,
        tool: "wait",
        status: "completed",
        senderThreadId: "parent-thread",
        receiverThreadIds: ["child-thread"],
        agentsStates: { "child-thread": { status: "completed", message } },
      },
    },
  };
}

describe("native subagent delivery receipts", () => {
  it.each(
    [false, true].flatMap((received) =>
      ["same", "different"].flatMap((predecessorResult) =>
        ["before", "after"].map((order) => ({ received, predecessorResult, order })),
      ),
    ),
  )(
    "defers successor acknowledgment behind unresolved evidence (received=$received, predecessor=$predecessorResult, receipt=$order)",
    ({ received, predecessorResult, order }) => {
      const receipts = new CodexNativeSubagentDeliveryReceipts();
      receipts.track("first-run", ["child-thread"]);
      if (received) {
        expect(receipts.observe(completedWaitReceipt("prior rendering", "initial"))).toEqual([
          "first-run",
        ]);
      }
      receipts.track("second-run", ["child-thread"]);
      const acknowledged: string[] = [];
      if (order === "before") {
        acknowledged.push(...receipts.observe(completedWaitReceipt("shared result")));
      }
      acknowledged.push(...receipts.record("second-run", ["child-thread"], "shared result"));
      if (order === "after") {
        acknowledged.push(...receipts.observe(completedWaitReceipt("shared result")));
      }
      expect(acknowledged).toEqual([]);
      receipts.record(
        "first-run",
        ["child-thread"],
        predecessorResult === "same" ? "shared result" : "different result",
      );
      expect(receipts.track("second-run", ["child-thread"])).toEqual(
        predecessorResult === "same" ? [] : ["second-run"],
      );
      if (predecessorResult === "same") {
        expect(receipts.track("first-run", ["child-thread"])).toEqual(["first-run"]);
      }
    },
  );

  it.each([false, true])(
    "acknowledges a distinct successor after a resolved predecessor (received=%s)",
    (received) => {
      const receipts = new CodexNativeSubagentDeliveryReceipts();
      receipts.record("first-run", ["child-thread"], "first result");
      if (received) {
        expect(receipts.observe(completedWaitReceipt("first result", "initial"))).toEqual([
          "first-run",
        ]);
      }
      receipts.record("second-run", ["child-thread"], "second result");
      expect(receipts.observe(completedWaitReceipt("second result"))).toEqual(["second-run"]);
    },
  );

  it("remembers accepted native renderings", () => {
    const receipts = new CodexNativeSubagentDeliveryReceipts();
    receipts.track("first-run", ["child-thread"]);
    expect(receipts.observe(completedWaitReceipt("first rendering", "first"))).toEqual([
      "first-run",
    ]);
    expect(receipts.observe(completedWaitReceipt("other rendering", "other"))).toEqual([]);
    receipts.record("first-run", ["child-thread"], "canonical result");
    receipts.record("second-run", ["child-thread"], "other rendering");
    expect(receipts.observe(completedWaitReceipt("other rendering", "duplicate"))).toEqual([]);
    expect(receipts.track("second-run", ["child-thread"])).toEqual([]);
  });

  it("does not acknowledge a known different result even when only one outcome is known", () => {
    const receipts = new CodexNativeSubagentDeliveryReceipts();
    receipts.record("first-run", ["child-thread"], "first result");
    expect(receipts.observe(completedWaitReceipt("second result"))).toEqual([]);
    expect(receipts.track("first-run", ["child-thread"])).toEqual([]);
  });

  it("retains a receipt matched before the child is registered", () => {
    const receipts = new CodexNativeSubagentDeliveryReceipts();
    receipts.record("child-run", ["child-thread"], "result");
    expect(receipts.observe(completedWaitReceipt("result"))).toEqual(["child-run"]);
    expect(receipts.track("child-run", ["child-thread"])).toEqual(["child-run"]);
  });

  it.each(["before", "after"])(
    "preserves a restored multiline predecessor when its receipt arrives %s the successor result",
    (order) => {
      const receipts = new CodexNativeSubagentDeliveryReceipts();
      const multilineResult = "First line\n  Second line\tvalue";
      receipts.record("first-run", ["child-thread"], "First line Second line value");
      receipts.track("second-run", ["child-thread"]);
      const acknowledged: string[] = [];
      if (order === "before") {
        acknowledged.push(...receipts.observe(completedWaitReceipt(multilineResult)));
      }
      acknowledged.push(...receipts.record("second-run", ["child-thread"], multilineResult));
      if (order === "after") {
        acknowledged.push(...receipts.observe(completedWaitReceipt(multilineResult)));
      }
      expect(acknowledged).toEqual(["first-run"]);
      expect(receipts.track("second-run", ["child-thread"])).toEqual([]);
    },
  );
});
