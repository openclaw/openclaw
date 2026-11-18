import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createMemorySessionActorOwner } from "../config/sessions/session-actor-memory.js";
import { runWithSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import { captureGatewayOperatorRunAuthority } from "../gateway/operator-run-authority.js";
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
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as profileReader from "../state/user-profile-list.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import { runWithAgentHarnessCompletionCustody as runWithCustody } from "./agent-harness-completion-custody.js";
import { createAgentHarnessCompletionScope as makeScope } from "./agent-harness-completion-scope.js";
import { buildAnnounceIdempotencyKey } from "./announce-idempotency.js";
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
  "retains the original operator ceiling until %s",
  (ending) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { context, resolver, client, scope, capture } = operatorFixture("completion-owner");
      const revoked = new AbortController();
      const source = (await captureGatewayOperatorRunAuthority({
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
        expect(source.authority.assertCurrent).not.toThrow();
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
            receiptAuthority: () => !retired,
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
          expect(outcome, JSON.stringify(outcome)).toMatchObject(
            callerState === "uncaptured"
              ? {
                  delivered: false,
                  error: expect.stringContaining("authority is no longer active"),
                }
              : { delivered: true, path: "direct" },
          );
        }
      } finally {
        custody?.release();
      }
    }),
);
