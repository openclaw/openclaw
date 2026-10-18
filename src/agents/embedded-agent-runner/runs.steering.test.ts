import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { waitForSessionRunEnd as waitForEmbeddedAgentRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { testing as replyRunTesting } from "../../sessions/session-controller.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  claimPendingEmbeddedAgentQuestionAnswer,
  preemptAndDrainEmbeddedHeartbeatRun,
  type EmbeddedAgentQueueHandle,
} from "./runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
  testing,
} from "./runs.test-support.js";

const sessionId = "session";
type Injection = NonNullable<EmbeddedAgentQueueHandle["messageInjectionV2"]>;
const accept = () => true;
const asyncNoop = async () => {};
function unused(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}
function injection(overrides: Partial<Injection> = {}): Injection {
  return { version: 2, isAvailable: accept, queueMessage: vi.fn(asyncNoop), ...overrides };
}
function start(overrides: Partial<EmbeddedAgentQueueHandle> = {}) {
  const handle = {
    ...createEmbeddedRunHandle(),
    queueMessage: vi.fn(asyncNoop),
    ...overrides,
  };
  const operation = setActiveEmbeddedRun(sessionId, handle);
  return { handle, operation };
}
afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  resetDiagnosticRunActivityForTest();
  replyRunTesting.resetSessionControllerForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("embedded-agent active-run question answers and waits", () => {
  it.each([true, false])("claims pending answers without steering: %s", async (claimed) => {
    const queueMessage = vi.fn(asyncNoop);
    const { operation } = start({
      runId: "question-owner",
      queueMessage,
      messageInjectionV2: injection({
        queueMessage,
        claimPendingUserInputAnswer: async (_text, options, assertCurrent) => {
          assertCurrent();
          return options?.isInboundUserMessage === true && claimed;
        },
      }),
    });
    await expect(claimPendingEmbeddedAgentQuestionAnswer(operation, "Green")).resolves.toEqual(
      claimed ? { runId: "question-owner" } : null,
    );
    unused(queueMessage);
  });

  it("claims only the captured owner's answer when stores share a session ID", async () => {
    const claimed: string[] = [];
    const sessionKey = "agent:main:shared-question";
    const operations = ["left", "right"].map((name) => {
      const operation = createReplyOperation({
        sessionKey,
        sessionId,
        resetTriggered: false,
        target: captureSessionTarget({
          storeScope: `/tmp/question-${name}/sessions.json`,
          sessionKey,
          agentId: "main",
          incarnation: sessionId,
        }),
      });
      const handle = {
        ...createEmbeddedRunHandle({ runId: `question-${name}` }),
        messageInjectionV2: injection({
          claimPendingUserInputAnswer: async (_text, _options, assertCurrent) => {
            assertCurrent();
            claimed.push(name);
            return true;
          },
        }),
      };
      setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, "main", operation);
      return operation;
    });
    await expect(claimPendingEmbeddedAgentQuestionAnswer(operations[1]!, "Green")).resolves.toEqual(
      {
        runId: "question-right",
      },
    );
    expect(claimed).toEqual(["right"]);
  });

  it.each(["availability", "claim"] as const)(
    "rejects backend replacement during question %s",
    async (stage) => {
      const entered = createDeferredCore(),
        released = createDeferredCore();
      const queueMessage = vi.fn(asyncNoop),
        replacement = createEmbeddedRunHandle({ runId: "replacement", queueMessage });
      const claim = vi.fn<NonNullable<Injection["claimPendingUserInputAnswer"]>>(
        async (_text, _options, assertCurrent) => {
          entered.resolve();
          await released.promise;
          assertCurrent();
          return true;
        },
      );
      const { operation } = start({
        runId: "question-owner",
        queueMessage,
        messageInjectionV2: injection({
          queueMessage,
          claimPendingUserInputAnswer: claim,
          isAvailable: () => {
            if (stage === "availability") {
              setActiveEmbeddedRun(sessionId, replacement);
            }
            return true;
          },
        }),
      });
      const result = claimPendingEmbeddedAgentQuestionAnswer(operation, "Green");
      try {
        if (stage === "availability") {
          await expect(result).resolves.toBeNull();
          unused(claim);
        } else {
          await entered.promise;
          setActiveEmbeddedRun(sessionId, replacement);
          released.resolve();
          await expect(result).rejects.toThrow("Message injection authority is no longer current");
        }
        unused(queueMessage);
      } finally {
        released.resolve();
      }
    },
  );

  it("keeps handle and session waiters distinct through replacements", async () => {
    vi.useFakeTimers();
    const preempt = vi.fn(() => true),
      visibleAbort = vi.fn();
    const { handle: heartbeat } = start({
      isAbortable: () => false,
      preemptByVisibleTurn: preempt,
    });
    const replacement = createEmbeddedRunHandle({ abort: visibleAbort });
    setActiveEmbeddedRun("visible", replacement);
    const heartbeatWait = preemptAndDrainEmbeddedHeartbeatRun(sessionId, 1_000);
    const sessionWait = waitForEmbeddedAgentRunEnd(sessionId, null);
    let heartbeatDrained = false,
      sessionDrained = false;
    void heartbeatWait.then(() => {
      heartbeatDrained = true;
    });
    void sessionWait.then(() => {
      sessionDrained = true;
    });
    await expect(preemptAndDrainEmbeddedHeartbeatRun("visible", 1_000)).resolves.toBe(
      "not-heartbeat",
    );
    setActiveEmbeddedRun(sessionId, replacement);
    await Promise.resolve();
    expect(heartbeatDrained).toBe(false);
    clearActiveEmbeddedRun(sessionId, heartbeat);
    await expect(heartbeatWait).resolves.toBe("drained");
    expect(sessionDrained).toBe(false);
    clearActiveEmbeddedRun(sessionId, replacement);
    const successor = createEmbeddedRunHandle();
    setActiveEmbeddedRun(sessionId, successor);
    await Promise.resolve();
    await Promise.resolve();
    expect(sessionDrained).toBe(false);
    clearActiveEmbeddedRun(sessionId, successor);
    await expect(sessionWait).resolves.toBe(true);
    expect(preempt).toHaveBeenCalledOnce();
    unused(visibleAbort);
  });
});
