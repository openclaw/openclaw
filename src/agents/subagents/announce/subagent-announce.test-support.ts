import { isDeepStrictEqual } from "node:util";
import { expect } from "vitest";
import type { AgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.types.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { immutableSubagentRun, subagentRuns } from "../registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";

export type AgentCallRequest = {
  method?: string;
  params?: Record<string, unknown> & {
    message?: string;
    internalEvents?: Array<{ type?: string; taskLabel?: string; result?: string }>;
  };
};

export function visibleAgentResponse(runId = "run-main") {
  return {
    runId,
    status: "ok",
    result: {
      payloads: [{ text: "announced" }],
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["announced"],
      didDeliverSourceReplyViaMessageTool: true,
      messagingToolSourceReplyPayloads: [{ text: "announced", sourceReplyFinal: true }],
    },
  };
}

export function expectInputProvenance(
  params: Record<string, unknown> | undefined,
  sourceSessionKey: string,
) {
  expect(params?.inputProvenance).toMatchObject({
    kind: "inter_session",
    sourceSessionKey,
    sourceTool: "subagent_announce",
  });
}

export function expectAgentCallFields(
  call: AgentCallRequest,
  expected: {
    channel?: string;
    deliver?: boolean;
    sessionKey: string;
    to?: string;
  },
) {
  expect(call).toMatchObject({
    method: "agent",
    params: { deliver: expected.deliver, ...expected },
  });
}

export type MockSubagentRun = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterDisplayKey: string;
  task: string;
  cleanup: "keep" | "delete";
  createdAt: number;
  execution: {
    endedAt?: number;
    outcome?: {
      status: "ok" | "timeout" | "error" | "unknown";
      error?: string;
    };
  };
  cleanupCompletedAt?: number;
  label?: string;
  completion?: {
    required: boolean;
    resultText?: string | null;
    terminalReply?: AgentRunTerminalReplySnapshot;
  };
};

export function publishAnnounceRunFixture(fixture: MockSubagentRun): SubagentRunRecord {
  const canonical = createSubagentRunRecord({
    ...fixture,
    execution:
      typeof fixture.execution.endedAt === "number"
        ? { status: "terminal", ...fixture.execution }
        : { status: "running" },
  });
  const current = subagentRuns.get(canonical.runId);
  if (current && isDeepStrictEqual(current, canonical)) {
    return current;
  }
  const published = immutableSubagentRun(structuredClone(canonical));
  subagentRuns.set(published.runId, published);
  return published;
}
