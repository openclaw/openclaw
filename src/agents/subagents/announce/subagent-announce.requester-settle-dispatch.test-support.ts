import { afterEach, beforeEach, vi } from "vitest";
import { createGatewayMethodRegistry } from "../../../gateway/methods/registry.js";
import { createChatRunState } from "../../../gateway/server-chat-state.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { createContext as createGatewayTestContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import {
  clearSessionControllerMailbox,
  sessionControllerMailboxes,
} from "../../../sessions/session-controller.mailbox.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import * as deliveryRuntime from "./subagent-announce-delivery.runtime.js";
import { completionReader, visibleCompletion } from "./subagent-announce-fixtures.test-support.js";
import * as announceOutput from "./subagent-announce-output.js";
import {
  outputTesting,
  setSubagentAnnounceDeliveryDepsForTest,
} from "./subagent-announce-overrides.test-support.js";
import {
  deliver,
  registryRead,
  startTurn,
  readDescendantFacts,
  loadRequester,
} from "./subagent-announce.requester-settle-dispatch-mocks.test-support.js";
import { makeSettledChild } from "./subagent-announce.requester-settle-wake.test-support.js";

export { publishWakeTransition } from "./subagent-announce.requester-settle-wake.test-support.js";

export { deliver, registryRead, startTurn, readDescendantFacts, loadRequester };

const readChildCompletionFindings = announceOutput.readChildCompletionFindings;

export function useRequesterSettleDispatchFixture() {
  let restoreRequesterCurrent: (() => void) | undefined;
  beforeEach(() => {
    outputTesting.setDepsForTest({
      readSubagentSessionEntry: (_storePath, sessionKey) => ({
        sessionId: `session-${sessionKey}`,
        updatedAt: 1,
      }),
      findTranscriptEvent: completionReader((sessionId) =>
        registryRead
          .listSubagentRunsForRequester()
          .find((entry) => `session-${entry.childSessionKey}` === sessionId),
      ),
    });
    const requesterCurrent = vi
      .spyOn(deliveryRuntime, "captureRequesterSessionEntryCurrent")
      .mockResolvedValue({
        readCurrent: () => ({ sessionId: "requester-session" }),
        release() {},
      });
    restoreRequesterCurrent = () => requesterCurrent.mockRestore();
    vi.spyOn(announceOutput, "readChildCompletionFindings").mockImplementation((children) =>
      readChildCompletionFindings(children, (runId) =>
        registryRead.listSubagentRunsForRequester().find((entry) => entry.runId === runId),
      ),
    );
    resetCommandQueueStateForTest();
    startTurn.mockReset();
    deliver.mockReset();
    loadRequester.mockReset().mockImplementation(async (sessionKey) => ({
      cfg: {},
      canonicalKey: sessionKey,
      agentId: "main",
      storePath: "/synthetic/requester-settle-dispatch/sessions.db",
      entry: { sessionId: "requester-session", updatedAt: 1 },
    }));
    readDescendantFacts.mockReset().mockResolvedValue({ unsettled: false, active: 0 });
    registryRead.getLatestLiveSubagentRunByChildSessionKey.mockReset().mockReturnValue(undefined);
    registryRead.getLatestSubagentRunByChildSessionKey.mockReset().mockReturnValue(undefined);
  });

  afterEach(() => {
    for (const mailbox of sessionControllerMailboxes()) {
      clearSessionControllerMailbox(mailbox, () => {});
    }
    vi.mocked(announceOutput.readChildCompletionFindings).mockRestore();
    resetCommandQueueStateForTest();
    setSubagentAnnounceDeliveryDepsForTest();
    outputTesting.setDepsForTest();
    restoreRequesterCurrent?.();
    vi.useRealTimers();
  });
}

export const REQUESTER_KEY = "agent:main:main";

export function settledChild(): SubagentRunRecord {
  return makeSettledChild({
    runId: "settled-child",
    requesterAgentId: "main",
    task: "finish child work",
    outcome: { status: "ok" },
    completion: { ...visibleCompletion("child result"), capturedAt: 3_000 },
    delivery: { status: "delivered" },
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      rearmGeneration: 1,
    },
  });
}

export function createRequesterSettleContext(): GatewayRequestContext {
  const methodRegistry = createGatewayMethodRegistry([]);
  const context = createGatewayTestContext();
  // This fixture deliberately leaves session-target preparation to its caller.
  delete context.resolveSessionRequestTargets;
  return Object.assign(context, {
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    chatRunState: createChatRunState(),
    getGatewayMethodRegistry: () => methodRegistry,
    nodeSendToSession: vi.fn(),
    removeChatRun: vi.fn(() => undefined),
  });
}
