import { expect, it } from "vitest";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import { bindSubagentRunRecord, rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRun(): SubagentRunRecord {
  return {
    runId: "captured",
    childSessionKey: "agent:main:subagent:captured",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "preserve captured payload",
    cleanup: "keep",
    createdAt: 1,
    execution: { status: "terminal", endedAt: 2 },
    completion: { required: true },
    delivery: { status: "pending" },
  };
}

it("persists the child owner and identity independently of a redirected transcript", () => {
  const entry = createRun();
  entry.childSessionKey = "global";
  entry.childAgentId = "research";
  entry.childSessionIdentity = { sessionId: "original-child", lifecycleRevision: "original" };
  entry.execution.transcriptTarget = { sessionId: "hidden-transcript" };
  const restored = rowToSubagentRunRecord(bindSubagentRunRecord(entry));
  expect(restored).toMatchObject({
    childSessionKey: "global",
    childAgentId: "research",
    childSessionIdentity: { sessionId: "original-child", lifecycleRevision: "original" },
    execution: { transcriptTarget: { sessionId: "hidden-transcript" } },
  });
});

it.each(["reply", "no reply", "root array", "completion array"] as const)(
  "rejects invalid encoding without mutating the run: %s",
  (kind) => {
    const timestamp = "[Mon 2026-09-21 12:00 UTC] ";
    const invalidArray = kind === "root array" || kind === "completion array";
    const captured: SubagentRunRecord =
      kind === "root array"
        ? Object.assign([], createRun())
        : kind === "completion array"
          ? { ...createRun(), completion: Object.assign([], { required: true }) }
          : normalizeSubagentRunState({
              ...createRun(),
              completion: {
                required: true,
                terminalReply: { disposition: "visible", text: `${timestamp}${timestamp}reply` },
              },
            });
    if (!invalidArray) {
      if (kind === "no reply") {
        delete captured.completion!.terminalReply;
      }
      captured.queuedLaunch = {
        request: { value: 1n },
        timeoutMs: 100,
        schedulerGroupKey: "synthetic",
        maxConcurrent: 1,
      };
    }
    const before = structuredClone(captured);
    expect(() => bindSubagentRunRecord(captured)).toThrow(
      invalidArray ? "subagent run is missing canonical nested state" : TypeError,
    );
    expect(captured).toStrictEqual(before);
  },
);
