import { afterEach, beforeEach, vi } from "vitest";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createGatewayMethodRegistry } from "../../../gateway/methods/registry.js";
import { createChatRunState } from "../../../gateway/server-chat-state.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { createContext as createGatewayTestContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import {
  clearSessionControllerMailbox,
  sessionControllerMailboxes,
} from "../../../sessions/session-controller.mailbox.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import * as deliveryRuntime from "./subagent-announce-delivery.runtime.js";
import { sendSubagentAnnounceDirectly } from "./subagent-announce-direct-delivery.js";
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
import type { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";
import {
  makeSettledChild,
  publishWakeTransition,
} from "./subagent-announce.requester-settle-wake.test-support.js";

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
export const REQUESTER_TARGET = captureSessionTarget({
  storeScope: "/synthetic/requester-settle-dispatch/sessions.db",
  sessionKey: REQUESTER_KEY,
  incarnation: "requester-session",
  agentId: "main",
});
export const REQUESTER_TURN = {
  target: REQUESTER_TARGET,
  sessionKey: REQUESTER_KEY,
  sessionId: "requester-session",
  agentId: "main",
};

type WakeParams = Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0];
export function wakeParams(
  settledEntry: SubagentRunRecord,
  completeBatch: WakeParams["completeBatch"],
  overrides: Partial<WakeParams> = {},
): WakeParams {
  return {
    requesterSessionKey: settledEntry.requesterSessionKey,
    requesterOrigin: settledEntry.requesterOrigin,
    isSourceCurrent: () => true,
    settledEntry,
    transitionBatch: publishWakeTransition,
    completeBatch,
    ...overrides,
  };
}

export function withGateway(context: GatewayRequestContext, run: () => Promise<boolean>) {
  return withPluginRuntimeGatewayRequestScope(
    { context, client: createSyntheticPluginRuntimeClient(), isWebchatConnect: () => false },
    run,
  );
}

export function requesterSnapshot(
  cfg: OpenClawConfig = {},
  entry: InternalSessionEntry = { sessionId: "requester-session", updatedAt: 1 },
  { sessionKey = REQUESTER_KEY, storePath = REQUESTER_TARGET.storeScope } = {},
) {
  return { cfg, canonicalKey: sessionKey, agentId: "main", storePath, entry };
}

export function useDirectDelivery(requester = requesterSnapshot()) {
  setSubagentAnnounceDeliveryDepsForTest({
    getRuntimeConfig: () => requester.cfg,
    loadRequesterSessionEntry: () => requester,
    getRequesterSessionActivity: () => ({
      sessionId: requester.entry.sessionId,
      target: captureSessionTarget({
        storeScope: requester.storePath,
        sessionKey: requester.canonicalKey,
        incarnation: requester.entry.sessionId,
        agentId: requester.agentId,
      }),
      isActive: false,
    }),
  });
  deliver.mockImplementation(sendSubagentAnnounceDirectly);
  return requester;
}

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
