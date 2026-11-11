import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { bindMessageInjectionAdmission } from "../../auto-reply/reply/message-injection-authority.js";
import type { ReplyBackendMessageInjectionV2 } from "../../sessions/session-controller.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
} from "../../sessions/session-controller.js";
import { captureCurrentReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../embedded-agent-runner/run/attempt-queue-message.js";
import {
  createEmbeddedRunHandle,
  registerTestEmbeddedRun,
  steerTestSessionTurn,
  testing as embeddedTesting,
} from "../embedded-agent-runner/runs.test-support.js";
import {
  createAssistant,
  createTestSession,
  holdAssistantResponse,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { getSteeringMessageIdentity } from "./steering-message-identity.js";

registerAgentSessionLoopTestLifecycle();
afterEach(() => {
  embeddedTesting.resetActiveEmbeddedRuns();
  testing.resetSessionControllerForTest();
  vi.useRealTimers();
});

async function setupSteering(sessionId: string, prepare?: () => Promise<void>, fakeTimers = false) {
  const context = await createTestSession();
  if (fakeTimers) {
    vi.useFakeTimers();
  }
  const { session } = context;
  const streaming = createDeferredCore();
  const held = holdAssistantResponse("active response");
  streamMocks.streamSimple.mockImplementationOnce(() => {
    streaming.resolve();
    return held.response;
  });
  const sessionKey = `agent:main:${sessionId}`;
  const queueMessage: ReplyBackendMessageInjectionV2["queueMessage"] = (
    text,
    options,
    assertCurrent,
  ) =>
    steerActiveSessionWithOptionalDeliveryWait(
      session,
      text,
      options,
      undefined,
      () => {
        assertCurrent();
        return true;
      },
      undefined,
      prepare,
    );
  const cancel = vi.fn();
  const handle = {
    ...createEmbeddedRunHandle({ runId: sessionId, supportsTranscriptCommitWait: true }),
    kind: "embedded" as const,
    cancel,
    messageInjectionV2: { version: 2 as const, isAvailable: () => true, queueMessage },
  };
  const operation = registerTestEmbeddedRun(sessionId, handle, sessionKey);
  const queue = (
    surface: "registry" | "controller" | "session",
    text: string,
    options: Parameters<typeof queueMessage>[1],
  ) => {
    if (surface === "session") {
      return queueMessage(text, options, () => {}, "run");
    }
    if (surface === "controller") {
      return steerTestSessionTurn(sessionId, text, options);
    }
    const target = captureCurrentReplyMessageInjectionTarget(sessionKey)!;
    return beginReplyMessageInjectionTarget(target, text, options).then((attempt) =>
      finalizeReplyMessageInjectionAttempt({ target, attempt }),
    );
  };
  return { ...context, held, streaming, operation, cancel, queue };
}

it.each(
  (["registry", "controller"] as const).flatMap((surface) =>
    (["none", "error"] as const).map((observer) => ({
      surface,
      observer,
    })),
  ),
)(
  "classifies withdrawn $surface steering after $observer settlement",
  async ({ surface, observer }) => {
    const { session, streaming, held, operation, queue } = await setupSteering(
      `withdrawal-${surface}-${observer}`,
    );
    const accepted = createDeferredCore();
    const active = session.prompt("active prompt");
    let terminated = false;
    let outcome: Promise<unknown> | undefined;
    try {
      await awaitGateBeforeSettlement(streaming.promise, active, "Active prompt never streamed");
      const options = {
        waitForTranscriptCommit: true,
        onQueueAccepted: (value: boolean) => {
          if (value) {
            accepted.resolve();
          }
        },
        onQueueSettled: () => {
          if (observer === "error") {
            throw new Error("settlement observer failed");
          }
        },
      };
      outcome = queue(surface, "withdraw this input", options);
      await awaitGateBeforeSettlement(accepted.promise, outcome, "Steering was not accepted");
      expect(session.getSteeringMessages()).toEqual(["withdraw this input"]);
      expect(session.agent.hasQueuedMessages()).toBe(true);
      const failure = createAssistant(testModel, [], "error");
      held.response.push({ type: "error", reason: "error", error: failure });
      held.response.end();
      terminated = true;
      await active;
      const result = await outcome;
      expect(session.getSteeringMessages()).toEqual([]);
      expect(session.agent.hasQueuedMessages()).toBe(false);
      expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ status: "rejected" });
    } finally {
      if (!terminated) {
        held.release();
      }
      await Promise.allSettled([active, ...(outcome ? [outcome] : [])]);
      operation.complete();
    }
  },
);

it.each([
  ...(["registry", "controller"] as const).flatMap((surface) =>
    (["fulfilled", "rejected"] as const).map((admission) => ({ surface, admission })),
  ),
  { surface: "session", admission: "reported" } as const,
])(
  "retains $surface input when persistence fails before $admission admission settles",
  async ({ surface, admission }) => {
    const installed = createDeferredCore();
    const release = createDeferredCore();
    const accepted = createDeferredCore();
    const queueIdentity = `persistence-${surface}-${admission}`;
    const prepare = async () => {};
    const { session, sessionManager, streaming, held, operation, cancel, queue } =
      await setupSteering(queueIdentity, prepare, true);
    const persistenceError = new Error("queued transcript append failed");
    const append = sessionManager.appendMessageAsync.bind(sessionManager);
    const persistenceFailed = vi.fn();
    vi.spyOn(sessionManager, "appendMessageAsync").mockImplementation(async (message, options) => {
      if (getSteeringMessageIdentity(message) === queueIdentity) {
        persistenceFailed();
        throw persistenceError;
      }
      return await append(message, options);
    });
    const steering = vi.spyOn(session, "steer");
    bindMessageInjectionAdmission(prepare, async (consume) => {
      const admissionResult = consume();
      installed.resolve();
      if (admission !== "reported") {
        await release.promise;
      }
      if (admission === "rejected") {
        throw new Error("admission cleanup failed");
      }
      return admissionResult;
    });
    const active = session.prompt("active prompt");
    let settlement: { result?: unknown; failure?: unknown } | undefined;
    let waiting: Promise<void> | undefined;
    const onQueueAccepted = vi.fn((value: boolean) => {
      if (value) {
        accepted.resolve();
      }
    });
    try {
      await awaitGateBeforeSettlement(streaming.promise, active, "Active prompt never streamed");
      const options = { waitForTranscriptCommit: true, queueIdentity, onQueueAccepted };
      const outcome = queue(surface, "input with failed persistence", options);
      waiting = outcome.then(
        (value) => {
          settlement = { result: value };
        },
        (error: unknown) => {
          settlement = { failure: error };
        },
      );
      await awaitGateBeforeSettlement(installed.promise, waiting, "Steering was not installed");
      if (admission === "reported") {
        await awaitGateBeforeSettlement(accepted.promise, waiting, "Acceptance was not reported");
      }
      held.release();
      await active;
      await vi.advanceTimersByTimeAsync(0);
      expect(persistenceFailed).toHaveBeenCalledOnce();
      expect(session.agent.hasQueuedMessages()).toBe(false);
      expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
      if (admission !== "reported") {
        expect(settlement).toBeUndefined();
        expect(onQueueAccepted).not.toHaveBeenCalled();
      }
      release.resolve();
      await waiting;
      const { result, failure } = settlement!;
      if (surface === "session") {
        expect(failure).toBe(persistenceError);
      } else {
        expect(failure).toBeUndefined();
        expect(result).toMatchObject({ status: "indeterminate" });
      }
      expect(onQueueAccepted).not.toHaveBeenCalledWith(false);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      held.release();
      await Promise.allSettled([
        active,
        ...(waiting ? [waiting] : []),
        ...steering.mock.results.map((call) => call.value),
      ]);
      operation.complete();
    }
  },
);
