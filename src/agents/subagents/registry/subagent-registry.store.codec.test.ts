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

it("encodes restart-safe cleanup without changing the live lease or its shared reply", () => {
  const entry = createRun();
  entry.cleanupHandled = true;
  entry.completion = {
    required: true,
    terminalReply: { disposition: "visible", text: "[Mon 2026-09-21 12:00 UTC] reply" },
  };
  const completion = entry.completion;
  const reply = completion.terminalReply;
  const before = structuredClone(entry);
  const row = bindSubagentRunRecord(entry);
  expect(entry).toStrictEqual(before);
  expect(entry.completion).toBe(completion);
  expect(completion.terminalReply).toBe(reply);
  expect(JSON.parse(row.payload_json)).toMatchObject({
    cleanupHandled: false,
    completion: { required: true, terminalReply: { disposition: "visible", text: "reply" } },
  });
});

it.each([{ version: 2 }, { snapshot: "x".repeat(65_537) }])(
  "keeps interrupted results when stored operator evidence is invalid",
  (operatorRecoverySource) => {
    const entry = createRun();
    entry.execution.outcome = { status: "error", error: "interrupted by a Gateway restart" };
    const row = bindSubagentRunRecord(entry);
    row.payload_json = JSON.stringify({ ...entry, operatorRecoverySource });
    const restored = rowToSubagentRunRecord(row);
    expect(restored?.operatorRecoverySource).toBeUndefined();
    expect(restored?.execution.outcome).toEqual(entry.execution.outcome);
    expect(restored?.delivery?.status).toBe("pending");
  },
);

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
