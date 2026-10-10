import { afterEach, beforeEach, vi } from "vitest";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import * as deliveryRuntime from "./subagent-announce-delivery.runtime.js";
import * as announceOutput from "./subagent-announce-output.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "./subagent-announce-overrides.test-support.js";
import {
  deliver,
  registryRead,
  startTurn,
  readDescendantFacts,
  loadRequester,
} from "./subagent-announce.requester-settle-dispatch-mocks.test-support.js";
import type { RequesterSettleWakeBatchCallbacks } from "./subagent-announce.requester-settle-state.js";

export { deliver, registryRead, startTurn, readDescendantFacts, loadRequester };

const readChildCompletionFindings = announceOutput.readChildCompletionFindings;

export function useRequesterSettleDispatchFixture() {
  let restoreRequesterCurrent: (() => void) | undefined;
  beforeEach(() => {
    const requesterCurrent = vi
      .spyOn(deliveryRuntime, "captureRequesterSessionEntryCurrent")
      .mockReturnValue(() => ({ sessionId: "requester-session" }));
    restoreRequesterCurrent = () => requesterCurrent.mockRestore();
    vi.spyOn(announceOutput, "readChildCompletionFindings").mockImplementation((children) =>
      readChildCompletionFindings(children, (runId) =>
        registryRead.listSubagentRunsForRequester().find((entry) => entry.runId === runId),
      ),
    );
    resetCommandQueueStateForTest();
    startTurn.mockReset();
    deliver.mockReset();
    loadRequester.mockReset().mockResolvedValue({
      cfg: {},
      canonicalKey: REQUESTER_KEY,
      entry: { sessionId: "requester-session", updatedAt: 1 },
    });
    readDescendantFacts.mockReset().mockResolvedValue({ unsettled: false, active: 0 });
    registryRead.getLatestLiveSubagentRunByChildSessionKey.mockReset().mockReturnValue(undefined);
    registryRead.getLatestSubagentRunByChildSessionKey.mockReset().mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.mocked(announceOutput.readChildCompletionFindings).mockRestore();
    resetCommandQueueStateForTest();
    setSubagentAnnounceDeliveryDepsForTest();
    restoreRequesterCurrent?.();
    vi.useRealTimers();
  });
}

export const REQUESTER_KEY = "agent:main:main";

export const publishWakeTransition: RequesterSettleWakeBatchCallbacks["transitionBatch"] = (
  batch,
  state,
  onPublished,
) => {
  for (const entry of batch) {
    entry.requesterSettleWake = state;
  }
  onPublished(batch);
};

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
