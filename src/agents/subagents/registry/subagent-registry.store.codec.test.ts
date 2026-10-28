import { expect, it } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import { bindSubagentRunRecord, rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const timestamp = "[Mon 2026-09-21 12:00 UTC] ";
const completionReply = (prefix = "") => ({
  required: true,
  terminalReply: { disposition: "visible" as const, text: prefix + "reply" },
});
const createRun = (overrides: Partial<SubagentRunRecord> = {}) =>
  createSubagentRunRecord({ runId: "captured", endedAt: 2, ...overrides });
function expectRejected(captured: SubagentRunRecord, error: string | ErrorConstructor = TypeError) {
  const before = structuredClone(captured);
  expect(() => bindSubagentRunRecord(captured)).toThrow(error);
  expect(captured).toStrictEqual(before);
}

it("persists child ownership independently of a redirected transcript", () => {
  const expected = {
    childSessionKey: "global",
    childAgentId: "research",
    childSessionIdentity: { sessionId: "child", lifecycleRevision: "original" },
    execution: { status: "terminal" as const, transcriptTarget: { sessionId: "redirected" } },
  };
  const entry = createRun(expected);
  expect(rowToSubagentRunRecord(bindSubagentRunRecord(entry))).toMatchObject(expected);
});

it("encodes restart-safe cleanup without changing the live lease or shared reply", () => {
  const completion = completionReply(timestamp);
  const entry = createRun({ cleanupHandled: true, completion });
  const reply = completion.terminalReply;
  const before = structuredClone(entry);
  const row = bindSubagentRunRecord(entry);
  expect(entry).toStrictEqual(before);
  expect(entry.completion).toBe(completion);
  expect(completion.terminalReply).toBe(reply);
  expect(JSON.parse(row.payload_json)).toMatchObject({
    cleanupHandled: false,
    completion: completionReply(),
  });
});

it.each([undefined, "queued-completion"])(
  "restores in-progress delivery only when the durable queue owns it (%s)",
  (queueId) => {
    const entry = createRun({
      cleanupHandled: true,
      delivery: { status: "in_progress", queueId },
    });
    const row = bindSubagentRunRecord(entry);
    row.payload_json = JSON.stringify(entry);

    const restored = rowToSubagentRunRecord(row);
    expect(restored?.delivery?.status).toBe(queueId ? "in_progress" : "pending");
    expect(restored?.cleanupHandled).toBe(false);
    expect(entry.delivery?.status).toBe("in_progress");
  },
);

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

it.each([
  ["root array", () => Object.assign([], createRun())],
  ["completion array", () => createRun({ completion: Object.assign([], { required: true }) })],
] as const)("rejects a noncanonical %s without mutation", (_kind, createCaptured) => {
  expectRejected(createCaptured(), "subagent run is missing canonical nested state");
});

it.each([true, false])("rejects unserializable launch without mutation (reply=%s)", (withReply) => {
  const captured = normalizeSubagentRunState(
    createRun({ completion: completionReply(timestamp.repeat(2)) }),
  );
  if (!withReply) {
    delete captured.completion!.terminalReply;
  }
  captured.queuedLaunch = {
    request: { value: 1n },
    timeoutMs: 100,
    schedulerGroupKey: "synthetic",
    maxConcurrent: 1,
  };
  expectRejected(captured);
});
