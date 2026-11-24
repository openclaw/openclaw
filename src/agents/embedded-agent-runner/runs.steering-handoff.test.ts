import { describe, afterEach, expect, it, vi } from "vitest";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { waitForSessionRunEnd as waitForEmbeddedAgentRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { getAttachedBackend } from "../../sessions/session-controller.state.js";
import { steerSessionControllerOperation } from "../../sessions/session-controller.steer.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { testing as replyRunTesting } from "../../sessions/session-controller.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import {
  captureEmbeddedRunDrainTarget,
  claimPendingEmbeddedAgentQuestionAnswer,
  type EmbeddedAgentQueueHandle,
} from "./runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
  testing,
} from "./runs.test-support.js";

const sessionId = "session";
const accept = () => true;
afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  resetDiagnosticRunActivityForTest();
  replyRunTesting.resetSessionControllerForTest();
  vi.restoreAllMocks();
});

it.each(["stopped", "replaced", "caller-revoked", "receiver-revoked"] as const)(
  "preserves receiver settlement versus authority refusal: %s",
  async (change) => {
    const entered = createDeferredCore(),
      release = createDeferredCore();
    const sessionKey = "agent:main:handoff-classification";
    let receiverCurrent = true,
      callerCurrent = true,
      stopped = false;
    const queueMessage = vi.fn<EmbeddedAgentQueueHandle["queueMessage"]>(async () => {});
    const handle = createEmbeddedRunHandle({ runId: "receiver", isStopped: () => stopped });
    handle.messageInjectionV2 = {
      version: 2,
      isAvailable: () => !stopped,
      queueMessage: async (text, options, assertCurrent) => {
        assertCurrent();
        await queueMessage(text, options);
      },
    };
    const assertReceiverCurrent = () => {
      if (!receiverCurrent) {
        throw new Error("receiver authority closed");
      }
    };
    const operation = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey,
        embeddedRunToolAuthorityBinding: () => ({
          source: "reply",
          project: () => "authority",
          projectAsync: async () => "authority",
          acceptsRequesterOrigin: accept,
          assertRegistrationActive: assertReceiverCurrent,
          assertActive: assertReceiverCurrent,
        }),
      },
      () => setActiveEmbeddedRun(sessionId, handle, sessionKey),
    );
    const first = steerSessionControllerOperation({
      operation,
      text: "first",
      options: {
        assertCurrent() {},
        toolAuthorityPreparation: {
          authorityKind: "source-bound",
          assertCurrent() {},
          compatAssertCurrent() {},
          async prepareCurrent() {},
          async prepareMessage() {
            entered.resolve();
            await release.promise;
            return "first";
          },
        },
      },
    });
    // Join both outcomes even when replacement closes the predecessor's admission.
    const firstSettled = first.catch(() => {});
    await entered.promise;
    const second = steerSessionControllerOperation({
      operation,
      text: "second",
      options: {
        assertCurrent() {
          if (!callerCurrent) {
            throw new Error("caller authority closed");
          }
        },
      },
    });
    const secondSettled = second.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    if (change === "replaced") {
      setActiveEmbeddedRun(
        sessionId,
        createEmbeddedRunHandle({ runId: "replacement" }),
        sessionKey,
      );
    } else if (change !== "receiver-revoked") {
      stopped = true;
    }
    receiverCurrent = false;
    callerCurrent = change !== "caller-revoked";
    release.resolve();
    await firstSettled;
    const outcome = await secondSettled;
    if (change === "caller-revoked" || change === "receiver-revoked") {
      expect(outcome).toHaveProperty("error");
    } else {
      expect(outcome).toMatchObject({ value: { status: "rejected" } });
    }
    expect(queueMessage).not.toHaveBeenCalled();
  },
);

describe("captured question and drain ownership", () => {
  type Injection = NonNullable<EmbeddedAgentQueueHandle["messageInjectionV2"]>;
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

  it.each(["claim", "reattach"] as const)(
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
        }),
      });
      const result = claimPendingEmbeddedAgentQuestionAnswer(operation, "Green");
      try {
        await entered.promise;
        if (stage === "reattach") {
          operation.attachBackend(getAttachedBackend(operation)!);
        } else {
          setActiveEmbeddedRun(sessionId, replacement);
        }
        released.resolve();
        await expect(result).rejects.toThrow(
          "The message input is no longer available. Start a new turn to retry.",
        );
        unused(queueMessage);
      } finally {
        released.resolve();
      }
    },
  );

  it("keeps handle and session waiters distinct through replacements", async () => {
    vi.useFakeTimers();
    const visibleAbort = vi.fn();
    const { handle: original, operation: originalOperation } = start();
    const captured = captureEmbeddedRunDrainTarget(sessionId, { defaultAgentId: "test" });
    expect(captured).toBeDefined();
    const replacement = createEmbeddedRunHandle({ abort: visibleAbort });
    setActiveEmbeddedRun("visible", replacement);
    const originalWait = captured!.waitForEnd(1_000);
    let originalDrained = false,
      sessionDrained = false;
    void originalWait.then(() => {
      originalDrained = true;
    });
    // A logical replacement closes its owner before attaching the next turn.
    originalOperation.complete();
    setActiveEmbeddedRun(sessionId, replacement);
    const sessionWait = waitForEmbeddedAgentRunEnd(sessionId, null);
    void sessionWait.then(() => {
      sessionDrained = true;
    });
    await Promise.resolve();
    expect(originalDrained).toBe(false);
    clearActiveEmbeddedRun(sessionId, original);
    await expect(originalWait).resolves.toBe(true);
    expect(sessionDrained).toBe(false);
    const successor = createEmbeddedRunHandle();
    setActiveEmbeddedRun(sessionId, successor);
    clearActiveEmbeddedRun(sessionId, replacement);
    await Promise.resolve();
    await Promise.resolve();
    expect(sessionDrained).toBe(false);
    clearActiveEmbeddedRun(sessionId, successor);
    await expect(sessionWait).resolves.toBe(true);
    unused(visibleAbort);
  });
});
