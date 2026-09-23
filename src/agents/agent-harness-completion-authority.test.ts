import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { captureGatewayOperatorRunAuthority } from "../gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  captureAgentHarnessCompletionCustody,
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
  type AgentHarnessCompletionDelivery,
  type AgentHarnessCompletionCustody,
} from "../plugin-sdk/agent-harness-task-runtime.js";
import {
  getGatewayContextLifetime,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runWithAgentHarnessCompletionCustody } from "../tasks/agent-harness-completion-custody.js";
import { createAgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import { buildAnnounceIdempotencyKey } from "./announce-idempotency.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

afterEach(() => resetGatewayWorkAdmission());

describe("harness completion caller lifetime", () => {
  it.each(["release", "revoke", "gateway-close"] as const)(
    "retains the original operator ceiling until %s",
    async (ending) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const context = createContext();
        const resolver = () => context;
        context.resolveGatewayContext = resolver;
        const client = createOperatorClient({
          profileId: "completion-owner",
          scopes: ["operator.write"],
        });
        const revoked = new AbortController();
        const source = captureGatewayOperatorRunAuthority({
          client,
          context,
          sourceAuthority: {
            signal: revoked.signal,
            assertCurrent: () => revoked.signal.throwIfAborted(),
          },
        })!;
        client.internal = { operatorRunAuthority: source.authority };
        const scope = createAgentHarnessTaskRuntimeScope({
          requesterSessionKey: "agent:main:main",
          gatewayContextResolver: resolver,
        });
        const custody = withPluginRuntimeGatewayRequestScope(
          { client, context, resolveGatewayContext: resolver, isWebchatConnect: () => false },
          () => captureAgentHarnessCompletionCustody(scope),
        )!;
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
            const foreignScope = createAgentHarnessTaskRuntimeScope({
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
        resetTaskRegistryForTests();
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
        const scope = createAgentHarnessTaskRuntimeScope({
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
            () => {
              const parentCustody = captureAgentHarnessCompletionCustody(scope);
              custody = parentCustody?.retain();
              parentCustody?.release();
              const runtime = createAgentHarnessTaskRuntime({
                scope,
                runtime: "subagent",
                taskKind: "native-child",
                runIdPrefix: "native:",
              });
              runtime.createRunningTaskRun({
                runId: childSessionKey,
                sourceId: childSessionKey,
                task: "Produce a result for the requester",
                requesterAgentId: "main",
                notifyPolicy: "silent",
              });
              runtime.finalizeTaskRunByRunId({
                runId: childSessionKey,
                status: "succeeded",
                endedAt: Date.now(),
                terminalSummary: "Child result",
              });
              runtime.setDetachedTaskDeliveryStatusByRunId({
                runId: childSessionKey,
                deliveryStatus: "pending",
              });
              // Native monitor callbacks retain this async context after the parent yields.
              delivery = (async () => {
                await ready.promise;
                return await deliverAgentHarnessTaskCompletion({
                  scope,
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
