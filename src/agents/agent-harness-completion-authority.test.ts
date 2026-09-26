import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { captureGatewayOperatorRunAuthority } from "../gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  captureAgentHarnessCompletionCustody,
  deliverAgentHarnessCompletion,
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
import { createDeferredCore } from "../shared/deferred.js";
import * as profileReader from "../state/user-profile-list.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import { runWithAgentHarnessCompletionCustody } from "./agent-harness-completion-custody.js";
import { createAgentHarnessCompletionScope } from "./agent-harness-completion-scope.js";
import { buildAnnounceIdempotencyKey } from "./announce-idempotency.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

afterEach(() => resetGatewayWorkAdmission());

describe("harness completion caller lifetime", () => {
  it.each(["current", "requester-replaced", "preparation-failed"] as const)(
    "settles retained root work when pending custody preparation is %s",
    async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const context = createContext();
        const resolver = () => context;
        context.resolveGatewayContext = resolver;
        const client = createOperatorClient({
          profileName: "preparing-completion-owner",
          scopes: ["operator.write"],
        });
        const target = {
          agentId: "main",
          sessionKey: "agent:main:main",
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        };
        await replaceSessionEntry(target, { sessionId: "original", updatedAt: Date.now() });
        const scope = createAgentHarnessCompletionScope({
          requesterSessionKey: target.sessionKey,
          gatewayContextResolver: resolver,
        });
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
        let custody: AgentHarnessCompletionCustody | undefined;
        const pending = root.run(async () =>
          withPluginRuntimeGatewayRequestScope(
            { client, context, resolveGatewayContext: resolver, isWebchatConnect: () => false },
            () => captureAgentHarnessCompletionCustody(scope),
          ),
        );
        const checked = pending.then(
          (value) => ({ custody: value }),
          (error: unknown) => ({ error }),
        );
        try {
          await Promise.race([entered.promise, checked]);
          expect(preparation).toHaveBeenCalledOnce();
          root.release();
          expect(getActiveGatewayRootWorkCount()).toBe(1);
          if (outcome === "requester-replaced") {
            await replaceSessionEntry(target, { sessionId: "replacement", updatedAt: Date.now() });
          }
          resume.resolve();
          const result = await checked;
          if (outcome === "current") {
            expect(result).not.toHaveProperty("error");
            custody = "custody" in result ? result.custody : undefined;
            expect(custody?.isCurrent()).toBe(true);
            custody?.release();
          } else {
            expect(result).toHaveProperty("error");
            expect("error" in result && String(result.error)).toContain(
              outcome === "requester-replaced"
                ? "requester lifecycle was replaced"
                : "profile preparation failed",
            );
          }
          expect(getActiveGatewayRootWorkCount()).toBe(0);
        } finally {
          resume.resolve();
          const result = await checked;
          if ("custody" in result) {
            result.custody?.release();
          }
          root.release();
          preparation.mockRestore();
        }
      });
    },
  );

  it.each(["release", "revoke", "gateway-close"] as const)(
    "retains the original operator ceiling until %s",
    async (ending) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const context = createContext();
        const resolver = () => context;
        context.resolveGatewayContext = resolver;
        const client = createOperatorClient({
          profileName: "completion-owner",
          scopes: ["operator.write"],
        });
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
        const scope = createAgentHarnessCompletionScope({
          requesterSessionKey: "agent:main:main",
          gatewayContextResolver: resolver,
        });
        const custody = (await withPluginRuntimeGatewayRequestScope(
          { client, context, resolveGatewayContext: resolver, isWebchatConnect: () => false },
          () => captureAgentHarnessCompletionCustody(scope),
        ))!;
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
              runWithAgentHarnessCompletionCustody(custody, scope, () => {
                const authority =
                  getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
                expect(authority?.source).toBe(source.authority.source);
                expect(authority?.scopes).toEqual(["operator.write"]);
              }),
          );
          for (const gatewayContextResolver of [undefined, () => createContext()]) {
            const foreignScope = createAgentHarnessCompletionScope({
              requesterSessionKey: scope.requesterSessionKey,
              gatewayContextResolver,
            });
            expect(() =>
              runWithAgentHarnessCompletionCustody(custody, foreignScope, () => {}),
            ).toThrow("custody does not own this requester");
          }
          if (ending === "release") {
            custody.release();
          } else if (ending === "revoke") {
            revoked.abort(new Error("operator revoked"));
          } else {
            getGatewayContextLifetime(resolver).abort();
          }
          expect(() => runWithAgentHarnessCompletionCustody(custody, scope, () => {})).toThrow();
        } finally {
          custody.release();
          source.release();
        }
      });
    },
  );
  it.each([
    "active",
    "retired",
    "retired-draining",
    "released",
    "requester-replaced",
    "uncaptured",
  ] as const)(
    "delivers an owned child result when its spawning caller is %s",
    async (callerState) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const requesterSessionKey = "agent:main:main";
        const childSessionKey = "native:child";
        const announceId = "native:parent:child:succeeded";
        const context = createContext();
        const resolveGatewayContext = () => context;
        context.resolveGatewayContext = resolveGatewayContext;
        context.dedupe.set(`agent:${buildAnnounceIdempotencyKey(announceId)}`, {
          ts: Date.now(),
          ok: true,
          payload: {
            runId: "requester-completion",
            status: "ok",
            result: { payloads: [{ text: "The child result was received." }] },
          },
        });
        await replaceSessionEntry(
          {
            agentId: "main",
            sessionKey: requesterSessionKey,
            storePath: path.join(state.sessionsDir(), "sessions.json"),
          },
          { sessionId: "parent-session", updatedAt: Date.now() },
        );
        const scope = createAgentHarnessCompletionScope({
          requesterSessionKey,
          gatewayContextResolver: resolveGatewayContext,
        });
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
              const parentCustody = await captureAgentHarnessCompletionCustody(scope);
              custody = parentCustody?.retain();
              parentCustody?.release();
              // Native monitor callbacks retain this async context after the parent yields.
              delivery = (async () => {
                await ready.promise;
                return await deliverAgentHarnessCompletion({
                  scope,
                  isSourceSessionAdmissionAllowed: () => custody?.isCurrent() ?? !retired,
                  completionCustody: callerState === "uncaptured" ? undefined : custody,
                  childSessionKey,
                  childSessionId: "child-session",
                  announceId,
                  status: "succeeded",
                  result: "Child result",
                });
              })();
            },
          ),
        );
        root.release();
        retired = callerState !== "active";
        if (callerState === "retired-draining") {
          markGatewayRestartDraining();
        }
        if (callerState === "released") {
          custody?.release();
        }
        if (callerState === "requester-replaced") {
          await replaceSessionEntry(
            {
              agentId: "main",
              sessionKey: requesterSessionKey,
              storePath: path.join(state.sessionsDir(), "sessions.json"),
            },
            { sessionId: "replacement-session", updatedAt: Date.now() },
          );
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
      });
    },
  );
});
