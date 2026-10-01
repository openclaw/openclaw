import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";

export const REQUESTER_KEY = "agent:main:main";

export function settledChild(): SubagentRunRecord {
  return {
    runId: "settled-child",
    childSessionKey: "agent:main:subagent:settled-child",
    requesterSessionKey: REQUESTER_KEY,
    requesterDisplayKey: "main",
    requesterAgentId: "main",
    task: "finish child work",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "terminal", startedAt: 2_000, endedAt: 3_000, outcome: { status: "ok" } },
    expectsCompletionMessage: true,
    completion: { required: true, resultText: "child result", capturedAt: 3_000 },
    delivery: { status: "delivered" },
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      rearmGeneration: 1,
    },
  };
}
