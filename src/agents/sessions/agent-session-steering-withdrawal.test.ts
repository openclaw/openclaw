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
import { extractFirstTextBlock } from "../../shared/chat-message-content.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import { applyCodeModeCatalog } from "../code-mode.js";
import {
  createCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
} from "../code-mode.test-support.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../embedded-agent-runner/run/attempt-queue-message.js";
import {
  createEmbeddedRunHandle,
  registerTestEmbeddedRun,
  steerTestSessionTurn,
  testing as embeddedTesting,
} from "../embedded-agent-runner/runs.test-support.js";
import { jsonResult } from "../tools/common.js";
import {
  createAssistant,
  createAssistantResultStream,
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

it.each(["single cell", "separate cells"] as const)(
  "delivers native steering only between top-level Code Mode calls (%s)",
  async (polling) => {
    const started = [createDeferredCore(), createDeferredCore()];
    const release = [createDeferredCore(), createDeferredCore()];
    const accepted = createDeferredCore();
    let polls = 0;
    const poll = pluginToolWithExecute("poll_work", "Poll synthetic work", async () => {
      const index = polls++;
      if (index > 1) {
        throw new Error("Work was polled after completion");
      }
      started[index]!.resolve();
      await release[index]!.promise;
      return jsonResult({ status: index === 0 ? "running" : "completed" });
    });
    const harness = createCodeModeHarness();
    applyCodeModeCatalog({ ...harness.ctx, tools: [...harness.tools, poll] });
    const { session, sessionManager } = await createTestSession({
      customTools: toToolDefinitions(harness.tools),
    });
    let requests = 0;
    streamMocks.streamSimple.mockImplementation((model) => {
      const index = requests++;
      const code =
        polling === "single cell"
          ? 'let result; do { result = await poll_work({}); } while (result.status !== "completed"); return result;'
          : "return await poll_work({});";
      return createAssistantResultStream(
        createAssistant(
          model,
          index < (polling === "single cell" ? 1 : 2)
            ? [
                {
                  type: "toolCall",
                  id: "poll-cell-" + index,
                  name: "exec",
                  arguments: {
                    title: "Poll synthetic work",
                    code,
                    awaitResults: true,
                  },
                },
              ]
            : [{ type: "text", text: "WORK_COMPLETED" }],
          index < (polling === "single cell" ? 1 : 2) ? "toolUse" : "stop",
        ),
      );
    });
    const sessionId = "code-mode-steering-" + polling;
    const sessionKey = "agent:main:" + sessionId;
    const queueIdentity = "refresh-" + polling;
    const operation = registerTestEmbeddedRun(
      sessionId,
      {
        ...createEmbeddedRunHandle({ runId: sessionId, supportsTranscriptCommitWait: true }),
        kind: "embedded",
        cancel() {},
        messageInjectionV2: {
          version: 2,
          isAvailable: () => true,
          queueMessage: (text, options, assertCurrent) =>
            steerActiveSessionWithOptionalDeliveryWait(session, text, options, undefined, () => {
              assertCurrent();
              return true;
            }),
        },
      },
      sessionKey,
    );
    const active = session.prompt("Finish the synthetic work");
    let completed = false;
    void active.then(() => {
      completed = true;
    });
    let outcome: Promise<unknown> | undefined;
    try {
      await awaitGateBeforeSettlement(started[0]!.promise, active, "First poll never started");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const target = captureCurrentReplyMessageInjectionTarget(sessionKey)!;
      outcome = beginReplyMessageInjectionTarget(target, "Refresh progress", {
        queueIdentity,
        waitForTranscriptCommit: true,
        onQueueAccepted: (value) => {
          if (value) {
            accepted.resolve();
          }
        },
      }).then((attempt) => finalizeReplyMessageInjectionAttempt({ target, attempt }));
      await awaitGateBeforeSettlement(accepted.promise, outcome, "Steering was not accepted");
      expect(session.getSteeringMessages()).toEqual(["Refresh progress"]);
      release[0]!.resolve();
      await awaitGateBeforeSettlement(started[1]!.promise, active, "Second poll never started");
      if (polling === "single cell") {
        // Nested poll completion is not a native agent-loop checkpoint. The actual
        // default delivery deadline withdraws input while the same cell continues.
        expect(requests).toBe(1);
        expect(session.getSteeringMessages()).toEqual(["Refresh progress"]);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(await outcome).toMatchObject({ status: "rejected", targetRunId: sessionId });
      } else {
        expect(await outcome).toMatchObject({ status: "accepted", targetRunId: sessionId });
        expect(requests).toBe(2);
      }
      expect(completed).toBe(false);
      expect(session.getSteeringMessages()).toEqual([]);
      const committed = sessionManager
        .buildSessionContext()
        .messages.filter(
          (message) =>
            message.role === "user" && extractFirstTextBlock(message) === "Refresh progress",
        );
      expect(committed).toHaveLength(polling === "single cell" ? 0 : 1);
      release[1]!.resolve();
      await active;
      expect(polls).toBe(2);
      expect(session.agent.state.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "WORK_COMPLETED" }],
      });
    } finally {
      vi.useRealTimers();
      for (const gate of release) {
        gate.resolve();
      }
      await Promise.allSettled([active, ...(outcome ? [outcome] : [])]);
      operation.complete();
      await resetCodeModeTestState();
    }
  },
);

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
