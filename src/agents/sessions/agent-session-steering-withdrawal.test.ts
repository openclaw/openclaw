import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { bindMessageInjectionAdmission } from "../../auto-reply/reply/message-injection-authority.js";
import type { ReplyBackendMessageInjectionV2 } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import { testing } from "../../auto-reply/reply/reply-run-registry.test-support.js";
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
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "../embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
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
  testing.resetReplyRunRegistry();
  vi.useRealTimers();
});

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
    const operation = createTestReplyOperation({ sessionId, sessionKey });
    operation.attachBackend({
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
    });
    operation.setPhase("running");
    const active = session.prompt("Finish the synthetic work");
    let completed = false;
    void active.then(() => {
      completed = true;
    });
    let outcome: Promise<unknown> | undefined;
    try {
      await awaitGateBeforeSettlement(started[0]!.promise, active, "First poll never started");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey)!;
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
  (["registry", "embedded"] as const).flatMap((surface) =>
    (["none", "error"] as const).map((observer) => ({
      surface,
      observer,
    })),
  ),
)(
  "classifies withdrawn $surface steering after $observer settlement",
  async ({ surface, observer }) => {
    const { session } = await createTestSession();
    const streaming = createDeferredCore();
    const accepted = createDeferredCore();
    const held = holdAssistantResponse("active response");
    streamMocks.streamSimple.mockImplementationOnce(() => {
      streaming.resolve();
      return held.response;
    });
    const sessionId = `withdrawal-${surface}-${observer}`;
    const sessionKey = `agent:main:${sessionId}`;
    const operation = createTestReplyOperation({ sessionId, sessionKey });
    const injection: ReplyBackendMessageInjectionV2 = {
      version: 2,
      isAvailable: () => true,
      queueMessage: (text, options, assertCurrent) =>
        steerActiveSessionWithOptionalDeliveryWait(session, text, options, undefined, () => {
          assertCurrent();
          return true;
        }),
    };
    const handle = {
      ...createEmbeddedRunHandle({ runId: sessionId, supportsTranscriptCommitWait: true }),
      kind: "embedded" as const,
      cancel() {},
      messageInjectionV2: injection,
    };
    operation.attachBackend(handle);
    operation.setPhase("running");
    setActiveEmbeddedRun(sessionId, handle, sessionKey);
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
      if (surface === "registry") {
        const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey)!;
        outcome = beginReplyMessageInjectionTarget(target, "withdraw this input", options).then(
          (attempt) => finalizeReplyMessageInjectionAttempt({ target, attempt }),
        );
      } else {
        outcome = queueEmbeddedAgentMessageWithOutcomeAsync(
          sessionId,
          "withdraw this input",
          options,
        );
      }
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
      expect(result).toMatchObject(
        surface === "registry" ? { status: "rejected" } : { queued: false },
      );
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
  ...(["registry", "embedded"] as const).flatMap((surface) =>
    (["fulfilled", "rejected"] as const).map((admission) => ({ surface, admission })),
  ),
  { surface: "session", admission: "reported" } as const,
])(
  "retains $surface input when persistence fails before $admission admission settles",
  async ({ surface, admission }) => {
    const { session, sessionManager } = await createTestSession();
    vi.useFakeTimers();
    const streaming = createDeferredCore();
    const installed = createDeferredCore();
    const release = createDeferredCore();
    const accepted = createDeferredCore();
    const held = holdAssistantResponse("active response");
    const queueIdentity = `persistence-${surface}-${admission}`;
    const sessionKey = `agent:main:${queueIdentity}`;
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
    streamMocks.streamSimple.mockImplementationOnce(() => {
      streaming.resolve();
      return held.response;
    });
    const prepare = async () => {};
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
    const operation = createTestReplyOperation({ sessionId: queueIdentity, sessionKey });
    const cancel = vi.fn();
    const handle = {
      ...createEmbeddedRunHandle({ runId: queueIdentity, supportsTranscriptCommitWait: true }),
      kind: "embedded" as const,
      cancel,
      messageInjectionV2: { version: 2 as const, isAvailable: () => true, queueMessage },
    };
    operation.attachBackend(handle);
    operation.setPhase("running");
    setActiveEmbeddedRun(queueIdentity, handle, sessionKey);
    const active = session.prompt("active prompt");
    let settled = false;
    let result: unknown;
    let failure: unknown;
    let waiting: Promise<void> | undefined;
    const onQueueAccepted = vi.fn((value: boolean) => {
      if (value) {
        accepted.resolve();
      }
    });
    try {
      await awaitGateBeforeSettlement(streaming.promise, active, "Active prompt never streamed");
      const options = { waitForTranscriptCommit: true, queueIdentity, onQueueAccepted };
      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey)!;
      const outcome =
        surface === "registry"
          ? beginReplyMessageInjectionTarget(target, "input with failed persistence", options).then(
              (attempt) => finalizeReplyMessageInjectionAttempt({ target, attempt }),
            )
          : surface === "embedded"
            ? queueEmbeddedAgentMessageWithOutcomeAsync(
                queueIdentity,
                "input with failed persistence",
                options,
              )
            : queueMessage("input with failed persistence", options, () => {}, "run");
      waiting = outcome.then(
        (value) => {
          result = value;
          settled = true;
        },
        (error: unknown) => {
          failure = error;
          settled = true;
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
        expect(settled).toBe(false);
        expect(onQueueAccepted).not.toHaveBeenCalled();
      }
      release.resolve();
      await waiting;
      if (surface === "session") {
        expect(failure).toBe(persistenceError);
      } else {
        expect(failure).toBeUndefined();
        expect(result).toMatchObject(
          surface === "registry"
            ? { status: "indeterminate" }
            : { queued: true, transcriptCommit: "unconfirmed" },
        );
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
