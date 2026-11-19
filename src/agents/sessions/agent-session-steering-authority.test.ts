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
import { createEnteredGate } from "../entered-gate.test-support.js";
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

async function preparePolicyRun(
  config: OpenClawConfig,
  params: Parameters<typeof createQueueTestRun>[0],
  execution: Partial<ReturnType<typeof createQueueTestRun>["run"]>,
) {
  const run = createQueueTestRun(params);
  Object.assign(run.run, { agentId: "main", config, senderIsOwner: true }, execution);
  const { sessionKey, sessionId } = run.run;
  const operation = createTestReplyOperation({ sessionKey, sessionId });
  await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
  await operation.bindToolAuthorityRouteAsync(run.run);
  return { run, operation, overlay: toolAuthorityOverlay(run) };
}

function attachSteering(
  operation: ReturnType<typeof createTestReplyOperation>,
  sessionId: string,
  sessionKey: string,
  injection: ReplyBackendMessageInjectionV2,
  runId?: string,
) {
  const handle = {
    ...createEmbeddedRunHandle({
      ...(runId === undefined ? {} : { runId }),
      toolAuthorityFingerprint: operation.toolAuthorityFingerprint,
    }),
    kind: "embedded" as const,
    cancel() {},
    messageInjectionV2: injection,
  };
  operation.attachBackend(handle);
  operation.setPhase("running");
  setActiveEmbeddedRun(sessionId, handle, sessionKey);
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
    const gate = createEnteredGate();
    let canInject = caller !== "refused";
    const onQueueAccepted = vi.fn();
    const injection = preparedInjection(session, {
      after: async () => {
        if (caller === "revoked") {
          await gate.wait();
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
        await awaitGate(gate.entered, outcome, "Preparation not reached");
        canInject = false;
        gate.release();
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
      gate.release();
      await outcome.catch(() => {});
    }
  },
);

it("orders final steering preparation through the actual session enqueue", async () => {
  vi.useFakeTimers();
  const { session } = await createTestSession();
  const gate = createEnteredGate();
  const first = steer(session, "first", { prepare: gate.wait });
  const pending = [first];
  try {
    await awaitGate(gate.entered, first, "First preparation not reached");
    pending.push(steer(session, "second", { prepare: async () => {} }));
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getSteeringMessages()).toEqual([]);
    gate.release();
    await Promise.all(pending);
    expect(session.getSteeringMessages()).toEqual(["first", "second"]);
  } finally {
    gate.release();
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
      const { run, operation, overlay } = await preparePolicyRun(
        config,
        { prompt: "input" },
        {
          sessionKey,
          sessionId,
          runtimePolicySessionKey: policyKey,
        },
      );
      const { session } = await createTestSession();
      let atBackend = false;
      const injection = preparedInjection(session, {
        sessionKey,
        before: () => {
          atBackend = true;
        },
      });
      attachSteering(operation, sessionId, sessionKey, injection, sessionId);
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
      const { operation, overlay } = await preparePolicyRun(
        config,
        { prompt: "steer", originatingChannel: "webchat" },
        {
          sessionId: "original",
          sessionKey,
          runtimePolicySessionKey: policyKey,
          clientCaps: ["ui-commands"],
          gatewayUiCommandTarget: { connId: "browser", profileId: "viewer" },
        },
      );
      const { session } = await createTestSession();
      const recorderGate = createEnteredGate();
      const policyGate = createEnteredGate();
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("original source revoked");
        }
      };
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "steer" },
        resolveInput: async () => {
          await recorderGate.wait();
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
                      await policyGate.wait();
                    }
                  },
                  recorder: options?.userTurnTranscriptRecorder,
                })) satisfies NonNullable<ReplyBackendMessageInjectionV2["queueMessageAsync"]>,
            }),
      };
      attachSteering(operation, "original", sessionKey, injection);
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
        await awaitGate(recorderGate.entered, accepted, "Recorder not reached");
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
        recorderGate.release();
        if (change === "worker-revoked") {
          await awaitGate(policyGate.entered, accepted, "Policy not reached");
          current = false;
          policyGate.release();
        }
        await expect(accepted).resolves.toBe(change === "legacy-metadata");
        expect(session.getSteeringMessages()).toEqual(
          change === "legacy-metadata" ? ["steer"] : [],
        );
      } finally {
        recorderGate.release();
        policyGate.release();
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
    const gate = createEnteredGate();
    const cleanupError = new Error("admission cleanup failed");
    const notificationError = new Error("queue notification failed");
    const cleanupFails = outcome.includes("cleanup");
    const notificationFails = outcome.includes("notification");
    let insideAdmission = false;
    let callerCurrent = true;
    const prepare = async () => {};
    bindMessageInjectionAdmission(prepare, async (consume) => {
      await prepare();
      await gate.wait();
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
      await awaitGate(gate.entered, pending, "Admission not reached");
      expect(enqueue).not.toHaveBeenCalled();
      callerCurrent = outcome !== "revoked";
      gate.release();
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
      gate.release();
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
