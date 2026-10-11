import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import {
  bindMessageInjectionAdmission,
  MessageInjectionAcceptedUnconfirmedError,
} from "../../auto-reply/reply/message-injection-authority.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import type {
  ReplyBackendMessageInjectionV2,
  ReplyToolAuthorityOverlay,
} from "../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import { testing } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import {
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../embedded-agent-runner/run/attempt-queue-message.js";
import {
  queueGuardedEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "../embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedTesting,
} from "../embedded-agent-runner/runs.test-support.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  holdAssistantResponse,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";

registerAgentSessionLoopTestLifecycle();
afterEach(() => {
  embeddedTesting.resetActiveEmbeddedRuns();
  testing.resetReplyRunRegistry();
  vi.useRealTimers();
});

it.each(["allowed", "refused", "revoked"] as const)(
  "retains the independent embedded caller guard through real enqueue: %s",
  async (caller) => {
    const { session } = await createTestSession();
    const enqueue = vi.spyOn(session.agent, "admitSteeringMessage");
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    let canInject = caller !== "refused";
    const onQueueAccepted = vi.fn();
    const sourcePreparation = {
      assertCurrent() {},
      async prepareCurrent() {},
    };
    const injection: ReplyBackendMessageInjectionV2 = {
      version: 2,
      isAvailable: () => true,
      async queueMessage() {
        throw new Error("Expected prepared embedded steering");
      },
      queueMessageAsync: (text, options, preparation) =>
        steerActiveSessionWithOptionalDeliveryWait(
          session,
          text,
          options,
          undefined,
          () => {
            preparation.assertCurrent();
            return true;
          },
          undefined,
          async () => {
            await preparation.prepareCurrent();
            if (caller === "revoked") {
              entered.resolve();
              await resume.promise;
            }
          },
        ),
    };
    const sessionId = `independent-caller-${caller}`;
    setActiveEmbeddedRun(sessionId, {
      ...createEmbeddedRunHandle(),
      messageInjectionV2: injection,
    });
    const outcome = queueGuardedEmbeddedAgentMessageWithOutcomeAsync(
      sessionId,
      "independent caller input",
      { onQueueAccepted },
      () => canInject,
      sourcePreparation,
    );
    try {
      if (caller === "revoked") {
        await awaitGateBeforeSettlement(
          entered.promise,
          outcome,
          "Final preparation was not reached",
        );
        canInject = false;
        resume.resolve();
      }
      await expect(outcome).resolves.toMatchObject({ queued: caller === "allowed" });
      if (caller === "allowed") {
        expect(enqueue).toHaveBeenCalledOnce();
        expect(session.getSteeringMessages()).toEqual(["independent caller input"]);
        expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(true);
      } else {
        expect(enqueue).not.toHaveBeenCalled();
        expect(session.getSteeringMessages()).toEqual([]);
        expect(onQueueAccepted).not.toHaveBeenCalledWith(true);
      }
    } finally {
      resume.resolve();
      await outcome;
    }
  },
);

it("orders final steering preparation through the actual session enqueue", async () => {
  vi.useFakeTimers();
  const { session } = await createTestSession();
  const enqueue = vi.spyOn(session.agent, "admitSteeringMessage");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const steer = (text: string, prepare: () => Promise<void>) =>
    session.steer(
      text,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => true,
      undefined,
      prepare,
    );
  const first = steer("first", async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = [first];
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      first,
      "first final preparation did not start",
    );
    pending.push(steer("second", async () => {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(enqueue).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all(pending);
    expect(enqueue.mock.calls.map(([message]) => message)).toMatchObject([
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]);
  } finally {
    release.resolve();
    await Promise.allSettled(pending);
  }
});

it.each([
  { surface: "registry", changePolicy: false },
  { surface: "registry", changePolicy: true },
  { surface: "talk", changePolicy: false },
  { surface: "talk", changePolicy: true },
] as const)(
  "revalidates an independent policy row at $surface enqueue after reader cleanup (policy changed: $changePolicy)",
  async ({ surface, changePolicy }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = `agent:main:execution-${surface}-${changePolicy}`;
      const policyKey = `agent:main:policy-${surface}-${changePolicy}`;
      const sessionId = `execution-${surface}-${changePolicy}`;
      const policyScope = { agentId: "main", sessionKey: policyKey, env: state.env };
      await upsertSessionEntryCore(policyScope, {
        sessionId: "independent-policy",
        updatedAt: 1,
        sandboxMode: "off",
      });
      const run = createQueueTestRun({ prompt: "input under current caller policy" });
      Object.assign(run.run, {
        agentId: "main",
        sessionKey,
        sessionId,
        runtimePolicySessionKey: policyKey,
        senderIsOwner: true,
        config: {
          agents: { defaults: { sandbox: { mode: "all" } } },
          tools: { sandbox: { tools: { deny: ["exec"] } } },
        },
      });
      const operation = createTestReplyOperation({ sessionKey, sessionId });
      await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
      const fingerprint = await operation.bindToolAuthorityRouteAsync(run.run);
      const { session } = await createTestSession();
      const enqueue = vi.spyOn(session.agent, "admitSteeringMessage");
      let atBackend = false;
      const injection: ReplyBackendMessageInjectionV2 = {
        version: 2,
        isAvailable: () => true,
        async queueMessage() {
          throw new Error("Expected prepared steering");
        },
        queueMessageAsync: (text, options, preparation) => {
          atBackend = true;
          return steerActiveSessionWithOptionalDeliveryWait(
            session,
            text,
            options,
            sessionKey,
            () => {
              preparation.assertCurrent();
              return true;
            },
            undefined,
            preparation.prepareCurrent,
          );
        },
      };
      const handle = {
        ...createEmbeddedRunHandle({ runId: sessionId, toolAuthorityFingerprint: fingerprint }),
        kind: "embedded" as const,
        cancel() {},
        messageInjectionV2: injection,
      };
      operation.attachBackend(handle);
      operation.setPhase("running");
      setActiveEmbeddedRun(sessionId, handle, sessionKey);
      let changed = false;
      const project = operation.projectToolAuthorityFingerprintAsync;
      const delayed = vi
        .spyOn(operation, "projectToolAuthorityFingerprintAsync")
        .mockImplementation(async (caller) => {
          const result = await project(caller);
          if (atBackend && !changed) {
            changed = true;
            await updateSessionEntry(policyScope, () =>
              changePolicy ? { sandboxMode: undefined } : { label: "renamed policy session" },
            );
          }
          return result;
        });
      const overlay: ReplyToolAuthorityOverlay = {
        senderIsOwner: true,
        disableTools: false,
        traceAuthorized: false,
      };
      try {
        const accepted =
          surface === "registry"
            ? await beginReplyMessageInjectionTarget(
                replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey)!,
                run.prompt,
                { isInboundUserMessage: true, toolAuthorityOverlay: overlay },
              ).then(async (attempt) => (await attempt.outcome).status === "accepted")
            : (
                await controlRealtimeVoiceAgentRun({
                  sessionKey,
                  mode: "steer",
                  text: run.prompt,
                  getToolAuthorityOverlay: () => overlay,
                })
              ).queued;
        expect(changed).toBe(true);
        expect(accepted).toBe(!changePolicy);
        expect(enqueue).toHaveBeenCalledTimes(changePolicy ? 0 : 1);
        expect(session.getSteeringMessages()).toEqual(changePolicy ? [] : [run.prompt]);
      } finally {
        delayed.mockRestore();
        operation.complete();
      }
    });
  },
);

it.each([
  ...(["worker-policy", "worker-revoked", "legacy-policy"] as const).map((change) => ({
    change,
    surface: "registry" as const,
  })),
  ...(["registry", "embedded"] as const).flatMap((surface) =>
    (["legacy-session", "legacy-revision", "legacy-metadata"] as const).map((change) => ({
      change,
      surface,
    })),
  ),
])(
  "retains $surface authority after delayed recorder preparation: $change",
  async ({ change, surface }) => {
    await withOpenClawTestState({ label: `steering-${change}` }, async ({ env }) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const sessionKey = "agent:main:steering-execution";
      const policyKey = "agent:main:steering-policy";
      writeSessionEntry(database, sessionKey, { sessionId: "original", updatedAt: 1 });
      writeSessionEntry(database, policyKey, {
        sessionId: "policy-original",
        updatedAt: 1,
        sandboxMode: "off",
      });
      const run = createQueueTestRun({ prompt: "steer", originatingChannel: "webchat" });
      Object.assign(run.run, {
        agentId: "main",
        sessionId: "original",
        sessionKey,
        runtimePolicySessionKey: policyKey,
        config: createCanonicalAgentConfigFixture({
          agents: { defaults: { sandbox: { mode: "all" } } },
        }).config,
        senderIsOwner: true,
        clientCaps: ["ui-commands"],
        gatewayUiCommandTarget: { connId: "browser", profileId: "viewer" },
      });
      const operation = createTestReplyOperation({ sessionKey, sessionId: "original" });
      await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
      await operation.bindToolAuthorityRouteAsync({
        provider: run.run.provider,
        model: run.run.model,
      });
      const overlay: ReplyToolAuthorityOverlay = {
        ...run.run,
        originatingChannel: run.originatingChannel,
        senderIsOwner: true,
        disableTools: false,
        traceAuthorized: false,
      };
      const { session } = await createTestSession();
      const enqueue = vi.spyOn(session.agent, "admitSteeringMessage");
      const recorderEntered = createDeferredCore();
      const releaseRecorder = createDeferredCore();
      const policyPrepared = createDeferredCore();
      const releasePolicy = createDeferredCore();
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("original source revoked");
        }
      };
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "steer" },
        resolveInput: async () => {
          recorderEntered.resolve();
          await releaseRecorder.promise;
          return { text: "steer" };
        },
        target: createTestUserTurnTranscriptTarget({
          sessionKey,
          sessionId: "original",
          storePath: database.path,
        }),
      });
      const injection: ReplyBackendMessageInjectionV2 = {
        version: 2,
        isAvailable: () => true,
        queueMessage: (text, options, assertOwner) =>
          session.steer(
            text,
            undefined,
            options?.userTurnTranscriptRecorder,
            undefined,
            undefined,
            undefined,
            () => {
              assertOwner();
              return true;
            },
          ),
        ...(change.startsWith("legacy-")
          ? {}
          : {
              queueMessageAsync: (async (text, options, preparation) =>
                session.steer(
                  text,
                  undefined,
                  options?.userTurnTranscriptRecorder,
                  undefined,
                  undefined,
                  undefined,
                  () => {
                    preparation.assertCurrent();
                    return true;
                  },
                  undefined,
                  async () => {
                    await preparation.prepareCurrent();
                    if (change === "worker-revoked") {
                      policyPrepared.resolve();
                      await releasePolicy.promise;
                    }
                  },
                )) satisfies NonNullable<ReplyBackendMessageInjectionV2["queueMessageAsync"]>,
            }),
      };
      const handle = {
        ...createEmbeddedRunHandle(),
        kind: "embedded",
        cancel: () => {},
        toolAuthorityFingerprint: operation.toolAuthorityFingerprint,
        messageInjectionV2: injection,
      } as const;
      operation.attachBackend(handle);
      operation.setPhase("running");
      setActiveEmbeddedRun("original", handle, sessionKey);
      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey)!;
      try {
        const options = {
          isInboundUserMessage: true,
          toolAuthorityOverlay: overlay,
          userTurnTranscriptRecorder: recorder,
          assertCurrent,
        };
        const accepted =
          surface === "registry"
            ? beginReplyMessageInjectionTarget(target, "steer", options).then(
                async (attempt) => (await attempt.outcome).status === "accepted",
              )
            : queueGuardedEmbeddedAgentMessageWithOutcomeAsync("original", "steer", options, () => {
                assertCurrent();
                return true;
              }).then((result) => result.queued);
        await awaitGateBeforeSettlement(
          recorderEntered.promise,
          accepted,
          "Steering settled before recorder preparation",
        );
        if (
          change === "legacy-session" ||
          change === "legacy-revision" ||
          change === "legacy-metadata"
        ) {
          await updateSessionEntry(
            { agentId: "main", sessionKey: policyKey, storePath: database.path },
            () =>
              change === "legacy-session"
                ? { sessionId: "replacement" }
                : change === "legacy-revision"
                  ? { lifecycleRevision: "replacement" }
                  : { label: "renamed" },
          );
        } else if (change !== "worker-revoked") {
          await updateSessionEntry(
            { agentId: "main", sessionKey: policyKey, storePath: database.path },
            () => ({ sandboxMode: undefined }),
          );
        }
        releaseRecorder.resolve();
        if (change === "worker-revoked") {
          await awaitGateBeforeSettlement(
            policyPrepared.promise,
            accepted,
            "Steering settled before policy preparation",
          );
          current = false;
          releasePolicy.resolve();
        }
        await expect(accepted).resolves.toBe(change === "legacy-metadata");
        expect(enqueue).toHaveBeenCalledTimes(change === "legacy-metadata" ? 1 : 0);
        expect(session.getSteeringMessages()).toEqual(
          change === "legacy-metadata" ? ["steer"] : [],
        );
      } finally {
        releaseRecorder.resolve();
        releasePolicy.resolve();
        operation.complete();
      }
    });
  },
);

it.each([
  "current",
  "revoked",
  "cleanup-failed",
  "notification-failed",
  "cleanup-and-notification-failed",
] as const)(
  "enqueues inside final admission and notifies after settlement: %s",
  async (outcome) => {
    const { session } = await createTestSession();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const cleanupError = new Error("admission cleanup failed");
    const notificationError = new Error("queue notification failed");
    const cleanupFails =
      outcome === "cleanup-failed" || outcome === "cleanup-and-notification-failed";
    const notificationFails =
      outcome === "notification-failed" || outcome === "cleanup-and-notification-failed";
    let insideAdmission = false;
    let callerCurrent = true;
    const prepare = async () => {};
    bindMessageInjectionAdmission(prepare, async (consume) => {
      await prepare();
      entered.resolve();
      await release.promise;
      insideAdmission = true;
      try {
        const value = consume();
        if (cleanupFails) {
          throw cleanupError;
        }
        return value;
      } finally {
        insideAdmission = false;
      }
    });
    const admit = session.agent.admitSteeringMessage.bind(session.agent);
    const enqueue = vi
      .spyOn(session.agent, "admitSteeringMessage")
      .mockImplementation((message) => {
        expect(insideAdmission).toBe(true);
        return admit(message);
      });
    const notified = vi.fn(() => {
      expect(insideAdmission).toBe(false);
      if (notificationFails) {
        throw notificationError;
      }
    });
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "queue_update") {
        notified();
      }
    });
    const pending = session.steer(
      "owned enqueue",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => callerCurrent,
      undefined,
      prepare,
    );
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "Final admission was not entered");
      expect(enqueue).not.toHaveBeenCalled();
      callerCurrent = outcome !== "revoked";
      release.resolve();
      if (outcome === "revoked") {
        await expect(pending).rejects.toThrow("active session is finalizing");
        expect(enqueue).not.toHaveBeenCalled();
        expect(session.getSteeringMessages()).toEqual([]);
        expect(notified).not.toHaveBeenCalled();
      } else {
        if (cleanupFails || notificationFails) {
          await expect(pending).rejects.toBeInstanceOf(MessageInjectionAcceptedUnconfirmedError);
          const error = await pending.catch((cause: unknown) => cause);
          expect(error).toMatchObject({
            cause:
              cleanupFails && notificationFails
                ? { errors: [expect.objectContaining({ cause: cleanupError }), notificationError] }
                : cleanupFails
                  ? cleanupError
                  : notificationError,
          });
        } else {
          await expect(pending).resolves.toBeUndefined();
        }
        expect(enqueue).toHaveBeenCalledOnce();
        expect(session.getSteeringMessages()).toEqual(["owned enqueue"]);
        expect(notified).toHaveBeenCalledOnce();
      }
    } finally {
      release.resolve();
      await pending.catch(() => {});
      unsubscribe();
    }
  },
);

it.each(["current", "notification", "preflight", "both", "refused"] as const)(
  "retains streaming prompt custody after %s feedback",
  async (feedback) => {
    const { session } = await createTestSession();
    const entered = createDeferredCore();
    const held = holdAssistantResponse("initial response");
    streamMocks.streamSimple
      .mockImplementationOnce(() => {
        entered.resolve();
        return held.response;
      })
      .mockImplementation(() =>
        createAssistantResultStream(createAssistant(testModel, [{ type: "text", text: "done" }])),
      );
    const notificationError = new Error("notification failed");
    const preflightError = new Error("preflight observer failed");
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === "queue_update" &&
        event.steering.includes("streamed prompt") &&
        (feedback === "notification" || feedback === "both")
      ) {
        throw notificationError;
      }
    });
    const preflightResult = vi.fn((accepted: boolean) => {
      if (accepted && (feedback === "preflight" || feedback === "both")) {
        throw preflightError;
      }
    });
    const active = session.prompt("active run");
    try {
      await awaitGateBeforeSettlement(entered.promise, active, "Active prompt never streamed");
      const pending = session.prompt("streamed prompt", {
        streamingBehavior: feedback === "refused" ? undefined : "steer",
        preflightResult,
      });
      if (feedback === "current") {
        await expect(pending).resolves.toBeUndefined();
      } else if (feedback === "refused") {
        await expect(pending).rejects.toThrow("Specify streamingBehavior");
      } else {
        await expect(pending).rejects.toBeInstanceOf(MessageInjectionAcceptedUnconfirmedError);
        await expect(pending).rejects.toMatchObject({
          cause:
            feedback === "both"
              ? { errors: [notificationError, preflightError] }
              : feedback === "notification"
                ? notificationError
                : preflightError,
        });
      }
      expect(preflightResult).toHaveBeenCalledExactlyOnceWith(feedback !== "refused");
      expect(session.getSteeringMessages()).toEqual(
        feedback === "refused" ? [] : ["streamed prompt"],
      );
    } finally {
      unsubscribe();
      held.release();
      await active;
    }
    expect(streamMocks.streamSimple).toHaveBeenCalledTimes(feedback === "refused" ? 1 : 2);
  },
);
