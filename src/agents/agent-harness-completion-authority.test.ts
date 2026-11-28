import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTestFollowupRun } from "../auto-reply/reply/agent-runner.test-fixtures.js";
import {
  readGoalContinuationContext,
  prepareGoalContinuationContext,
  recordGoalContinuationSettlement,
} from "../auto-reply/reply/goal-continuation-return.js";
import { enqueueGoalContinuation } from "../auto-reply/reply/goal-continuation.js";
import * as queue from "../auto-reply/reply/queue/enqueue.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { createSessionGoal } from "../config/sessions/goals.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createMemorySessionActorOwner } from "../config/sessions/session-actor-memory.js";
import { runWithSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import { prepareGatewayOperatorRunAuthority } from "../gateway/operator-run-authority.js";
import { createChatSendLateFollowupDisposition } from "../gateway/server-methods/chat-send-late-followup.js";
import {
  createContext,
  createOperatorClient,
} from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  captureAgentHarnessCompletionCustody as captureCustody,
  deliverAgentHarnessCompletion as deliverCompletion,
  type AgentHarnessCompletionDelivery,
  type AgentHarnessCompletionCustody,
} from "../plugin-sdk/agent-harness-completion.js";
import {
  getGatewayContextLifetime,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
} from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as profileReader from "../state/user-profile-list.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createTestAdmittedRunContext,
  createTestOperatorAuthority,
} from "./admitted-run-context.test-support.js";
import { runWithAgentHarnessCompletionCustody as runWithCustody } from "./agent-harness-completion-custody.js";
import { createAgentHarnessCompletionScope as makeScope } from "./agent-harness-completion-scope.js";
import { buildAnnounceIdempotencyKey } from "./announce-idempotency.js";
import { createLifecycleHarness } from "./harness/lifecycle.test-support.js";
import * as registry from "./harness/registry.js";
import * as announcement from "./subagents/announce/subagent-announce-delivery.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

afterEach(() => resetGatewayWorkAdmission());

const requesterSessionKey = "agent:main:main";
function gateway(sessionKey = requesterSessionKey) {
  const context = createContext();
  const resolver = () => context;
  context.resolveGatewayContext = resolver;
  const scope = makeScope({ requesterSessionKey: sessionKey, gatewayContextResolver: resolver });
  return { context, resolver, scope };
}
function requester(state: OpenClawTestState) {
  const target = {
    agentId: "main",
    sessionKey: requesterSessionKey,
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  return (sessionId: string) => replaceSessionEntry(target, { sessionId, updatedAt: Date.now() });
}
function operatorFixture(profileName: string) {
  setRuntimeConfigSnapshot({});
  const { context, resolver, scope } = gateway();
  const client = createOperatorClient({ profileName, scopes: ["operator.write"] });
  const capture = () =>
    withPluginRuntimeGatewayRequestScope(
      { client, context, resolveGatewayContext: resolver, isWebchatConnect: () => false },
      () => captureCustody(scope),
    );
  return { context, resolver, client, scope, capture };
}

it.each(["current", "missing-requester", "requester-closed", "connection-closed"] as const)(
  "settles memory requester root custody when %s",
  async (outcome) => {
    const sessionKey = "agent:main:dashboard:incognito-completion";
    const { context, scope } = gateway(
      outcome === "missing-requester" ? `${sessionKey}-missing` : sessionKey,
    );
    const work = new AsyncWorkScope();
    context.trackExecution = (run) => work.track(run);
    if (outcome === "connection-closed") {
      await work.drain();
    }
    const owner = createMemorySessionActorOwner({
      agentId: "main",
      path: "/synthetic/completion-custody",
    });
    const authority = { assertCurrent() {}, authorize() {} };
    const actor = await owner.acquire(
      { database: owner.identity, sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    const root = tryBeginGatewayRootWorkAdmission("test:memory-completion")!;
    let custody: AgentHarnessCompletionCustody | undefined;
    try {
      if (outcome === "current") {
        await actor.storage!.mutate(
          {
            type: "session.entry.create",
            input: { entry: { sessionId: "requester", updatedAt: 1, incognito: true } },
          },
          authority,
        );
      }
      const pending = root.run(() =>
        runWithSessionActorStorage({ actor, authority, agentId: "main", path: owner.path }, () =>
          captureCustody(scope),
        ),
      );
      if (outcome === "requester-closed" || outcome === "connection-closed") {
        await expect(pending).rejects.toThrow(
          outcome === "connection-closed"
            ? "Async work scope is closed"
            : "Harness completion requester was closed",
        );
      } else {
        custody = await pending;
        expect(custody?.isCurrent()).toBe(outcome === "current" ? true : undefined);
      }
      root.release();
      expect(getActiveGatewayRootWorkCount()).toBe(outcome === "current" ? 1 : 0);
      custody?.release();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    } finally {
      custody?.release();
      root.release();
      await actor.release();
      owner.close();
    }
  },
);

it.each(["current", "requester-replaced", "preparation-failed"] as const)(
  "settles retained root work when pending custody preparation is %s",
  (outcome) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { capture } = operatorFixture("preparing-completion-owner");
      const replaceRequester = requester(state);
      await replaceRequester("original");
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const prepare = profileReader.prepareUserProfileIdentity;
      const preparation = vi
        .spyOn(profileReader, "prepareUserProfileIdentity")
        .mockImplementationOnce(async (...args) => {
          const prepared = await prepare(...args);
          entered.resolve();
          await resume.promise;
          if (outcome === "preparation-failed") {
            throw new Error("profile preparation failed");
          }
          return prepared;
        });
      const root = tryBeginGatewayRootWorkAdmission("test:preparing-completion")!;
      const pending = root.run(capture);
      const checked = pending.then(
        (custody) => ({ custody, error: undefined }),
        (error: unknown) => ({ custody: undefined, error }),
      );
      try {
        await Promise.race([entered.promise, checked]);
        expect(preparation).toHaveBeenCalledOnce();
        root.release();
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        if (outcome === "requester-replaced") {
          await replaceRequester("replacement");
        }
        resume.resolve();
        const { custody, error } = await checked;
        if (outcome === "current") {
          expect(error).toBeUndefined();
          expect(custody?.isCurrent()).toBe(true);
          custody?.release();
        } else {
          expect(error).toBeDefined();
          expect(String(error)).toContain(
            outcome === "requester-replaced"
              ? "requester lifecycle was replaced"
              : "profile preparation failed",
          );
        }
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        resume.resolve();
        (await checked).custody?.release();
        root.release();
        preparation.mockRestore();
      }
    }),
);

it.each(["release", "revoke", "gateway-close"] as const)(
  "retains the admitted operator ceiling with %s",
  (ending) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { context, resolver, client, scope, capture } = operatorFixture("completion-owner");
      const revoked = new AbortController();
      const source = (await prepareGatewayOperatorRunAuthority({
        client,
        context,
        sourceAuthority: {
          signal: revoked.signal,
          assertCurrent: () => revoked.signal.throwIfAborted(),
        },
      }))!;
      client.internal = { operatorRunAuthority: source.authority };
      const custody = (await capture())!;
      try {
        source.release();
        expect(source.authority.signal?.aborted).not.toBe(true);
        const observer = createOperatorClient({
          profileId: "other-owner",
          scopes: ["operator.admin"],
        });
        withPluginRuntimeGatewayRequestScope(
          { client: observer, context, isWebchatConnect: () => false },
          () =>
            runWithCustody(custody, scope, () => {
              const authority =
                getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
              expect(authority?.source).toBe(source.authority.source);
              expect(authority?.scopes).toEqual(["operator.write"]);
            }),
        );
        for (const gatewayContextResolver of [undefined, () => createContext()]) {
          const foreignScope = makeScope({
            requesterSessionKey: scope.requesterSessionKey,
            gatewayContextResolver,
          });
          expect(() => runWithCustody(custody, foreignScope, () => {})).toThrow(
            "custody does not own this requester",
          );
        }
        if (ending === "release") {
          custody.release();
        } else if (ending === "revoke") {
          revoked.abort(new Error("operator revoked"));
          runWithCustody(custody, scope, () => {
            const authority =
              getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
            expect(authority?.source).toBe(source.authority.source);
            expect(authority?.scopes).toEqual(["operator.write"]);
          });
          custody.release();
        } else {
          getGatewayContextLifetime(resolver).abort();
        }
        expect(() => runWithCustody(custody, scope, () => {})).toThrow();
      } finally {
        custody.release();
        source.release();
      }
    }),
);
it.each(["retired-draining", "released", "requester-replaced", "uncaptured"] as const)(
  "delivers an owned child result when its spawning caller is %s",
  (callerState) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const childSessionKey = "native:child";
      const announceId = "native:parent:child:succeeded";
      const { context, resolver: resolveGatewayContext, scope } = gateway();
      context.dedupe.set(`agent:${buildAnnounceIdempotencyKey(announceId)}`, {
        ts: Date.now(),
        ok: true,
        payload: {
          runId: "requester-completion",
          status: "ok",
          result: { payloads: [{ text: "The child result was received." }] },
        },
      });
      const replaceRequester = requester(state);
      await replaceRequester("parent-session");
      const ready = createDeferredCore();
      let retired = false;
      let delivery: Promise<AgentHarnessCompletionDelivery> | undefined;
      let custody: AgentHarnessCompletionCustody | undefined;
      const root = tryBeginGatewayRootWorkAdmission("test:completion-parent")!;
      await root.run(async () =>
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: requesterSessionKey,
            operationalRunInstance:
              createTestAdmittedRunContext("parent-run").operationalRunInstance,
            receiptAuthority: () => {
              if (retired) {
                throw new Error("agent tool caller authority is no longer active");
              }
            },
            gatewayContextResolver: resolveGatewayContext,
          },
          async () => {
            const parentCustody = await captureCustody(scope);
            custody = parentCustody?.retain();
            parentCustody?.release();
            // Native monitor callbacks retain this async context after the parent yields.
            delivery = ready.promise.then(() =>
              deliverCompletion({
                scope,
                isSourceSessionAdmissionAllowed: () => custody?.isCurrent() ?? !retired,
                completionCustody: callerState === "uncaptured" ? undefined : custody,
                childSessionKey,
                childSessionId: "child-session",
                announceId,
                status: "succeeded",
                result: "Child result",
              }),
            );
          },
        ),
      );
      root.release();
      retired = true;
      if (callerState === "retired-draining") {
        markGatewayRestartDraining();
      }
      if (callerState === "released") {
        custody?.release();
      }
      if (callerState === "requester-replaced") {
        await replaceRequester("replacement-session");
      }
      ready.resolve();
      try {
        if (callerState === "released" || callerState === "requester-replaced") {
          await expect(delivery).rejects.toThrow(/custody|requester lifecycle/);
        } else {
          const outcome = await delivery;
          expect(outcome, JSON.stringify(outcome)).toMatchObject({
            delivered: true,
            path: "direct",
          });
        }
      } finally {
        custody?.release();
      }
    }),
);

it("resumes only the Goal nudge displaced by an acknowledged native result", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = requesterSessionKey;
    const sessionId = "parent-session";
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const { scope, capture, context } = operatorFixture("native-goal");
    const target = { storePath, agentId: "main", sessionKey };
    await replaceSessionEntry(target, {
      sessionId,
      updatedAt: Date.now(),
      agentHarnessId: "codex",
    });
    const goalId = (await createSessionGoal({ ...target, objective: "Verify both changes" })).id;
    const sessionEntry = (await announcement.loadRequesterSessionEntry(sessionKey, "main")).entry!;
    const custody = (await capture())!;
    const registered = vi
      .spyOn(registry, "getRegisteredAgentHarness")
      .mockReturnValue({ harness: createLifecycleHarness() });
    const enqueue = vi.spyOn(queue, "enqueueFollowupRun").mockReturnValue(false);
    const announce = vi.spyOn(announcement, "deliverSubagentAnnouncement");
    const result = { meta: { durationMs: 0, stopReason: "stop" } };
    try {
      for (const ending of [
        "direct",
        "siblings",
        "mixed siblings",
        "handled failure",
        "revoked",
        "replay",
        "failed delivery",
        "cancelled",
        "no displaced turn",
        "uncaptured",
      ]) {
        const operation = createReplyOperation({
          sessionKey,
          sessionId,
          resetTriggered: false,
          target: captureSessionTarget({
            sessionKey,
            agentId: "main",
            storeScope: storePath,
            incarnation: sessionId,
          }),
        });
        const caller = new AbortController();
        const base = createTestFollowupRun({ sessionKey, sessionId });
        base.operatorAuthority = createTestOperatorAuthority({
          profileId: "original",
          scopes: ["operator.write"],
          signal: caller.signal,
        });
        base.queuedFollowupReplyDisposition = {
          kind: "deliver",
          deliver: createChatSendLateFollowupDisposition({
            runId: "foreground",
            originatingChannel: "webchat",
            logGateway: context.logGateway,
            deliver: async () => ({ kind: "delivered" }),
          }).deliver,
        };
        enqueue.mockClear();
        const deliver = (id: string) =>
          deliverCompletion({
            scope,
            completionCustody: ending === "uncaptured" ? undefined : custody,
            childSessionKey: `native:${id}`,
            childSessionId: id,
            announceId: `native:parent:${id}:${ending}`,
            status:
              ending === "handled failure"
                ? "failed"
                : ending === "cancelled" || (ending === "mixed siblings" && id === "child")
                  ? "cancelled"
                  : "succeeded",
            result: "First change checked.",
            isSourceSessionAdmissionAllowed: () => true,
          });

        announce.mockImplementation(
          async ({ directIdempotencyKey: runId, sourceSessionKey, controllerInput }) => {
            const mixed = ending === "mixed siblings" && sourceSessionKey === "native:child";
            const waiting =
              mixed || ["direct", "failed delivery", "cancelled", "uncaptured"].includes(ending)
                ? claimSessionControllerTask(controllerInput!, () => {})
                : undefined;
            if (mixed || (ending === "siblings" && sourceSessionKey === "native:child")) {
              expect((await deliver("sibling")).delivered).toBe(true);
              expect(enqueue).not.toHaveBeenCalled();
            } else if (ending !== "no displaced turn") {
              await enqueueGoalContinuation({
                base,
                result,
                operation,
                sessionKey,
                storePath,
                queueKey: sessionKey,
                settings: { mode: "followup" },
                initialGoalId: goalId,
                expectedSession: sessionEntry,
                runFollowup: async () => {},
                sourceRunId: "foreground",
              });
              expect(enqueue).not.toHaveBeenCalled();
            }
            operation.complete();
            if (waiting) {
              releaseSessionControllerClaim(await waiting);
            }
            if (ending !== "replay") {
              prepareGoalContinuationContext({ runId, sessionKey, sessionEntry });
              expect(readGoalContinuationContext({ runId, sessionKey })).toBeUndefined();
              recordGoalContinuationSettlement({ runId, sessionKey, result, succeeded: true });
            }
            if (ending === "revoked") {
              caller.abort();
            }
            return { delivered: !mixed && ending !== "failed delivery", path: "direct" };
          },
        );
        try {
          const receipt = await deliver("child");
          expect(receipt.delivered, ending).toBe(
            ending !== "failed delivery" && ending !== "mixed siblings",
          );
          const resumes =
            ending === "direct" || ending === "handled failure" || ending === "siblings";
          expect(enqueue, ending).toHaveBeenCalledTimes(Number(resumes));
          if (resumes) {
            const queued = enqueue.mock.calls[0]![1];
            expect(queued.goalContinuation).toMatchObject({
              goalId,
              localCodexGoal: true,
              sessionId,
            });
            expect(queued.operatorAuthority).toBe(base.operatorAuthority);
          }
        } finally {
          operation.complete();
        }
      }
    } finally {
      custody.release();
      announce.mockRestore();
      enqueue.mockRestore();
      registered.mockRestore();
    }
  }));
