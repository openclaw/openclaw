import { afterEach, beforeEach, vi } from "vitest";
import { createInternalAgentTurnFacade } from "../../../gateway/agent-turn/internal-facade.js";
import { createGatewayMethodRegistry } from "../../../gateway/methods/registry.js";
import { createChatRunState } from "../../../gateway/server-chat-state.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import {
  clearSessionControllerMailbox,
  sessionControllerMailboxes,
} from "../../../sessions/session-controller.mailbox.js";
import { matchesTranscriptEvent } from "../../../sessions/transcript-visible-record.js";
import { trackAsyncWork } from "../../../shared/async-work-scope.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import * as deliveryRuntime from "./subagent-announce-delivery.runtime.js";
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
      findTranscriptEvent: async ({ sessionId }, match) => {
        const child = registryRead
          .listSubagentRunsForRequester()
          .find((entry) => `session-${entry.childSessionKey}` === sessionId);
        const event = {
          type: "message",
          message: {
            role: "assistant",
            display: true,
            content: [{ type: "text", text: child?.completion?.resultText }],
            __openclaw: { runId: child?.runId },
          },
        };
        return child && matchesTranscriptEvent(event, match) ? { event } : undefined;
      },
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
    completion: {
      required: true,
      resultText: "child result",
      terminalReply: { disposition: "visible", text: "child result" },
      capturedAt: 3_000,
    },
    delivery: { status: "delivered" },
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      rearmGeneration: 1,
    },
  };
}

export function createRequesterSettleContext(): GatewayRequestContext {
  const chatRunState = createChatRunState();
  const methodRegistry = createGatewayMethodRegistry([]);
  const context = Object.assign({} as GatewayRequestContext, {
    trackExecution: trackAsyncWork,
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    chatRunState,
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    getGatewayMethodRegistry: () => methodRegistry,
    logGateway: { error: vi.fn(), warn: vi.fn() },
    nodeSendToSession: vi.fn(),
    removeChatRun: vi.fn(() => undefined),
  });
  context.createAgentTurnFacade = (principal) =>
    createInternalAgentTurnFacade({
      ...principal,
      getContext: () => context,
      getMethodRegistry: () => methodRegistry,
    });
  return context;
}
