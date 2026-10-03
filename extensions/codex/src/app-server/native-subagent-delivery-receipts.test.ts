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
  it.each([
    { received: false, predecessorResult: "same" },
    { received: true, predecessorResult: "different" },
  ])(
    "defers successor acknowledgment behind unresolved evidence (received=$received, predecessor=$predecessorResult)",
    ({ received, predecessorResult }) => {
      const receipts = new CodexNativeSubagentDeliveryReceipts();
      receipts.track("first-run", ["child-thread"]);
      if (received) {
        expect(receipts.observe(completedWaitReceipt("prior rendering", "initial"))).toEqual([
          "first-run",
        ]);
      }
      receipts.track("second-run", ["child-thread"]);
      expect(receipts.observe(completedWaitReceipt("shared result"))).toEqual([]);
      expect(receipts.record("second-run", ["child-thread"], "shared result")).toEqual([]);
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

  it("acknowledges a distinct successor after a received predecessor", () => {
    const receipts = new CodexNativeSubagentDeliveryReceipts();
    receipts.record("first-run", ["child-thread"], "first result");
    expect(receipts.observe(completedWaitReceipt("first result", "initial"))).toEqual([
      "first-run",
    ]);
    receipts.record("second-run", ["child-thread"], "second result");
    expect(receipts.observe(completedWaitReceipt("second result"))).toEqual(["second-run"]);
  });

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

  it("attributes a multiline receipt to its predecessor after an equivalent successor result", () => {
    const receipts = new CodexNativeSubagentDeliveryReceipts();
    const multilineResult = "First line\n  Second line\tvalue";
    receipts.record("first-run", ["child-thread"], "First line Second line value");
    receipts.track("second-run", ["child-thread"]);
    expect(receipts.record("second-run", ["child-thread"], multilineResult)).toEqual([]);
    expect(receipts.observe(completedWaitReceipt(multilineResult))).toEqual(["first-run"]);
    expect(receipts.track("second-run", ["child-thread"])).toEqual([]);
  });
});
