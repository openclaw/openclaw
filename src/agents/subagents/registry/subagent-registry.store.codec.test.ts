import { expect, it } from "vitest";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import {
  bindCapturedSubagentRunRecord,
  bindSubagentRunRecord,
} from "./subagent-registry.store.codec.js";
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

it.each([false, true])(
  "restores captured completion after encoding fails (reply present=%s)",
  (hasReply) => {
    const timestamp = "[Mon 2026-09-21 12:00 UTC] ";
    const captured = normalizeSubagentRunState({
      ...createRun(),
      completion: {
        required: true,
        terminalReply: { disposition: "visible", text: `${timestamp}${timestamp}reply` },
      },
    });
    if (!hasReply) {
      delete captured.completion!.terminalReply;
    }
    captured.queuedLaunch = {
      request: { value: 1n },
      timeoutMs: 100,
      schedulerGroupKey: "synthetic",
      maxConcurrent: 1,
    };
    const before = structuredClone(captured);
    expect(() => bindCapturedSubagentRunRecord(captured)).toThrow(TypeError);
    expect(captured).toStrictEqual(before);
  },
);

it.each(["root", "completion"] as const)("rejects a captured array %s", (location) => {
  const entry =
    location === "root"
      ? Object.assign([], createRun())
      : { ...createRun(), completion: Object.assign([], { required: true }) };
  for (const bind of [bindSubagentRunRecord, bindCapturedSubagentRunRecord]) {
    expect(() => bind(entry)).toThrow("subagent run is missing canonical nested state");
  }
});
