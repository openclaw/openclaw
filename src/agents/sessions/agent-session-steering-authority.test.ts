import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement as awaitGate } from "../../../test/helpers/promise.js";
import {
  bindMessageInjectionAdmission,
  MessageInjectionAcceptedUnconfirmedError,
} from "../../auto-reply/reply/message-injection-authority.js";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import {
  createQueueTestRun,
  toolAuthorityOverlay,
} from "../../auto-reply/reply/reply-tool-authority.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  updateSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyBackendMessageInjectionV2 } from "../../sessions/session-controller.contracts.js";
import { beginReplyMessageInjectionTarget } from "../../sessions/session-controller.js";
import { captureCurrentReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import { createCanonicalAgentConfigFixture } from "../../test-utils/config-roster.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../embedded-agent-runner/run/attempt-queue-message.js";
import {
  createEmbeddedRunHandle,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  steerTestSessionTurn,
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
type Session = Awaited<ReturnType<typeof createTestSession>>["session"];
function steer(
  session: Session,
  text: string,
  {
    canAdmit = () => true,
    prepare,
    recorder,
  }: {
    canAdmit?: () => boolean;
    prepare?: () => Promise<void>;
    recorder?: Parameters<Session["steer"]>[2];
  },
) {
  return session.steer(
    text,
    undefined,
    recorder,
    undefined,
    undefined,
    undefined,
    canAdmit,
    undefined,
    prepare,
  );
}
const currentGuard = (assertCurrent: () => void) => () => {
  assertCurrent();
  return true;
};
function preparedInjection(
  session: Session,
  {
    sessionKey,
    before = () => {},
    after,
  }: { sessionKey?: string; before?: () => void; after?: () => Promise<void> } = {},
): ReplyBackendMessageInjectionV2 {
  return {
    version: 2,
    isAvailable: () => true,
    async queueMessage() {
      throw new Error("Expected prepared steering");
    },
    queueMessageAsync(text, options, preparation) {
      before();
      return steerActiveSessionWithOptionalDeliveryWait(
        session,
        text,
        options,
        sessionKey,
        currentGuard(() => preparation.assertCurrent()),
        undefined,
        after
          ? async () => {
              await preparation.prepareCurrent();
              await after();
            }
          : preparation.prepareCurrent,
      );
    },
  };
}
afterEach(() => {
  embeddedTesting.resetActiveEmbeddedRuns();
  testing.resetSessionControllerForTest();
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
});

it.each(["allowed", "refused", "revoked"] as const)(
  "retains the independent embedded caller guard through real enqueue: %s",
  async (caller) => {
    const allowed = caller === "allowed";
    const { session } = await createTestSession();
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    let canInject = caller !== "refused";
    const onQueueAccepted = vi.fn();
    const injection = preparedInjection(session, {
      after: async () => {
        if (caller === "revoked") {
          entered.resolve();
          await resume.promise;
        }
      },
    });
    const sessionId = `caller-${caller}`;
    setActiveEmbeddedRun(sessionId, {
      ...createEmbeddedRunHandle(),
      messageInjectionV2: injection,
    });
    const outcome = steerTestSessionTurn(sessionId, "input", {
      onQueueAccepted,
      canAdmit: () => canInject,
      assertCurrent: () => {
        if (!canInject) {
          throw new Error("caller revoked");
        }
      },
      toolAuthorityPreparation: {
        assertCurrent() {},
        async prepareCurrent() {},
        compatAssertCurrent() {},
      },
    });
    void outcome.catch(() => {});
    try {
      if (caller === "revoked") {
        await awaitGate(entered.promise, outcome, "Preparation not reached");
        canInject = false;
        resume.resolve();
      }
      if (!allowed) {
        await expect(outcome).rejects.toThrow("caller revoked");
      } else {
        await expect(outcome).resolves.toMatchObject({ status: "accepted" });
      }
      expect(session.getSteeringMessages()).toEqual(allowed ? ["input"] : []);
      if (allowed) {
        expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(true);
      } else {
        expect(onQueueAccepted).not.toHaveBeenCalledWith(true);
      }
    } finally {
      resume.resolve();
      await outcome.catch(() => {});
    }
  },
);

it("orders final steering preparation through the actual session enqueue", async () => {
  vi.useFakeTimers();
  const { session } = await createTestSession();
  const enqueue = vi.spyOn(session.agent, "admitSteeringMessage");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const first = steer(session, "first", {
    prepare: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const pending = [first];
  try {
    await awaitGate(entered.promise, first, "First preparation not reached");
    pending.push(steer(session, "second", { prepare: async () => {} }));
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
      const config: OpenClawConfig = {
        agents: { defaults: { sandbox: { mode: "all" } } },
        tools: { sandbox: { tools: { deny: ["exec"] } } },
      };
      setRuntimeConfigSnapshot(config);
      const sessionKey = "agent:main:execution";
      const policyKey = "agent:main:policy";
      const sessionId = "execution";
      const policyScope = { agentId: "main", sessionKey: policyKey, env: state.env };
      await upsertSessionEntryCore(policyScope, {
        sessionId: "independent-policy",
        updatedAt: 1,
        sandboxMode: "off",
      });
      const run = createQueueTestRun({ prompt: "input" });
      Object.assign(run.run, {
        agentId: "main",
        sessionKey,
        sessionId,
        runtimePolicySessionKey: policyKey,
        senderIsOwner: true,
        config,
      });
      const operation = createTestReplyOperation({ sessionKey, sessionId });
      await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
      const fingerprint = await operation.bindToolAuthorityRouteAsync(run.run);
      const { session } = await createTestSession();
      let atBackend = false;
      const injection = preparedInjection(session, {
        sessionKey,
        before: () => {
          atBackend = true;
        },
      });
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
      using _ = vi
        .spyOn(operation, "projectToolAuthorityFingerprintAsync")
        .mockImplementation(async (caller) => {
          const result = await project(caller);
          if (atBackend && !changed) {
            changed = true;
            await updateSessionEntry(policyScope, () =>
              changePolicy ? { sandboxMode: undefined } : { label: "renamed" },
            );
          }
          return result;
        });
      const overlay = toolAuthorityOverlay(run);
      try {
        const accepted =
          surface === "registry"
            ? await beginReplyMessageInjectionTarget(
                captureCurrentReplyMessageInjectionTarget(sessionKey)!,
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
        expect(session.getSteeringMessages()).toEqual(changePolicy ? [] : [run.prompt]);
      } finally {
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
  ...(["registry", "controller"] as const).flatMap((surface) =>
    (["legacy-session", "legacy-revision", "legacy-metadata"] as const).map((change) => ({
      change,
      surface,
    })),
  ),
])(
  "retains $surface authority after delayed recorder preparation: $change",
  async ({ change, surface }) => {
    await withOpenClawTestState({ label: `steering-${change}` }, async ({ env }) => {
      const config = createCanonicalAgentConfigFixture({
        agents: { defaults: { sandbox: { mode: "all" } } },
      }).config;
      setRuntimeConfigSnapshot(config);
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
        config,
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
      const overlay = toolAuthorityOverlay(run);
      const { session } = await createTestSession();
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
          steer(session, text, {
            canAdmit: currentGuard(assertOwner),
            recorder: options?.userTurnTranscriptRecorder,
          }),
        ...(change.startsWith("legacy-")
          ? {}
          : {
              queueMessageAsync: (async (text, options, preparation) =>
                steer(session, text, {
                  canAdmit: currentGuard(() => preparation.assertCurrent()),
                  prepare: async () => {
                    await preparation.prepareCurrent();
                    if (change === "worker-revoked") {
                      policyPrepared.resolve();
                      await releasePolicy.promise;
                    }
                  },
                  recorder: options?.userTurnTranscriptRecorder,
                })) satisfies NonNullable<ReplyBackendMessageInjectionV2["queueMessageAsync"]>,
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
      const target = captureCurrentReplyMessageInjectionTarget(sessionKey)!;
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
            : steerTestSessionTurn("original", "steer", options).then(
                (result) => result.status === "accepted",
                // Controller authority failures reject; both surfaces must leave input unqueued.
                () => false,
              );
        await awaitGate(recorderEntered.promise, accepted, "Recorder not reached");
        const policyUpdate =
          change === "worker-revoked"
            ? undefined
            : change === "legacy-session"
              ? { sessionId: "replacement" }
              : change === "legacy-revision"
                ? { lifecycleRevision: "replacement" }
                : change === "legacy-metadata"
                  ? { label: "renamed" }
                  : { sandboxMode: undefined };
        if (policyUpdate) {
          await updateSessionEntry(
            { agentId: "main", sessionKey: policyKey, storePath: database.path },
            () => policyUpdate,
          );
        }
        releaseRecorder.resolve();
        if (change === "worker-revoked") {
          await awaitGate(policyPrepared.promise, accepted, "Policy not reached");
          current = false;
          releasePolicy.resolve();
        }
        await expect(accepted).resolves.toBe(change === "legacy-metadata");
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
    const cleanupFails = outcome.includes("cleanup");
    const notificationFails = outcome.includes("notification");
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
    const pending = steer(session, "owned enqueue", { canAdmit: () => callerCurrent, prepare });
    try {
      await awaitGate(entered.promise, pending, "Admission not reached");
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
        session.getSteeringMessages().includes("streamed prompt") &&
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
      await awaitGate(entered.promise, active, "Prompt never streamed");
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
