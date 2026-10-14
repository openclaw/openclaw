import "./subagent-announce.requester-settle-dispatch-mocks.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { authorizeGatewayMethod } from "../../../gateway/server-methods/method-authorization.js";
import { resolveInProcessGatewaySyntheticScopes } from "../../../gateway/server-plugin-in-process-scopes.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import * as deliveryRuntime from "./subagent-announce-delivery.runtime.js";
import { sendSubagentAnnounceDirectly } from "./subagent-announce-direct-delivery.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "./subagent-announce-overrides.test-support.js";
import {
  deliver,
  registryRead,
  startTurn,
  loadRequester,
  settledChild,
  publishWakeTransition,
  useRequesterSettleDispatchFixture,
  createRequesterSettleContext as createContext,
} from "./subagent-announce.requester-settle-dispatch.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";

describe("requester settle routing and session authority", () => {
  useRequesterSettleDispatchFixture();
  beforeEach(() => {
    setRuntimeConfigSnapshot({});
  });
  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it.each([
    { name: "WebChat settle", channel: "webchat", pause: false, external: false },
    { name: "WebChat pause", channel: "webchat", pause: true, external: false },
    { name: "explicit external completion", channel: "telegram", pause: false, external: true },
    { name: "saved-route completion", channel: undefined, pause: false, external: true },
    {
      name: "visible failed child",
      channel: "webchat",
      pause: false,
      external: false,
      narrow: true,
    },
    {
      name: "reset visible requester",
      channel: "webchat",
      pause: false,
      external: false,
      narrow: true,
      reset: true,
    },
    {
      name: "replaced visible requester",
      channel: "webchat",
      pause: false,
      external: false,
      narrow: true,
      replaced: true,
    },
    {
      name: "mixed visible requester",
      channel: "webchat",
      pause: false,
      external: false,
      narrow: true,
      mixed: true,
    },
    {
      name: "legacy visible requester",
      channel: "webchat",
      pause: false,
      external: false,
      narrow: true,
      legacy: true,
    },
  ])("keeps $name on its owning route despite external session history", async (testCase) => {
    const requesterSessionKey = "agent:main:dashboard:completion-route";
    const requesterIdentity = {
      sessionId: testCase.replaced ? "replacement-session" : "requester-session",
      lifecycleRevision: testCase.narrow
        ? testCase.reset
          ? "reset-revision"
          : "requester-revision"
        : undefined,
    };
    const child = settledChild();
    child.requesterSessionKey = requesterSessionKey;
    child.completionRequesterSessionId = "requester-session";
    if (testCase.narrow) {
      child.completionRequesterLifecycleRevision = testCase.mixed
        ? "older-revision"
        : "requester-revision";
      vi.mocked(deliveryRuntime.captureRequesterSessionEntryCurrent).mockResolvedValue({
        readCurrent: () => requesterIdentity,
        release() {},
      });
      child.execution.outcome = { status: "error", error: "Child preparation failed" };
      child.completion = { required: true, resultText: "Child preparation failed" };
      child.delivery = { status: "pending" };
    }
    if (testCase.legacy) {
      child.completionRequesterSessionId = undefined;
      child.completionRequesterLifecycleRevision = undefined;
    }
    child.requesterOrigin = testCase.channel ? { channel: testCase.channel } : undefined;
    if (testCase.pause) {
      child.pauseReason = "sessions_yield";
      child.execution.outcome = undefined;
      child.requesterSettleWake!.pauseNotice = { acknowledgment: "Need direction." };
    }
    const cohort = [child];
    if (testCase.mixed) {
      cohort.push({
        ...child,
        runId: "current-sibling",
        childSessionKey: "agent:main:subagent:current-sibling",
        completionRequesterLifecycleRevision: requesterIdentity.lifecycleRevision,
      });
    }
    registryRead.listSubagentRunsForRequester.mockReturnValue(cohort);
    loadRequester.mockReturnValue({
      cfg: {},
      canonicalKey: requesterSessionKey,
      agentId: "main",
      entry: {
        ...requesterIdentity,
        updatedAt: 1,
        delivery: {
          kind: "external",
          route: { channel: "telegram", target: { to: "12345" } },
          context: { channel: "telegram", to: "12345", accountId: "bot-1", threadId: 42 },
          origin: { provider: "webchat", to: requesterSessionKey, surface: "webchat" },
        },
      },
    });
    setSubagentAnnounceDeliveryDepsForTest({
      getRuntimeConfig: () => ({}),
      loadRequesterSessionEntry: loadRequester,
      getRequesterSessionActivity: () => ({
        sessionId: requesterIdentity.sessionId,
        isActive: false,
      }),
    });
    deliver.mockImplementation(sendSubagentAnnounceDirectly);
    startTurn.mockImplementation(async ({ preflight, io }) => {
      io.emitAcceptance([true, { runId: preflight.request.idempotencyKey, status: "accepted" }]);
      io.emitFinal([
        true,
        {
          status: "ok",
          result: {
            payloads: [{ text: "Completed." }],
            ...(testCase.external
              ? { deliveryStatus: { status: "sent", succeeded: true, resultCount: 1 } }
              : {}),
          },
        },
      ]);
    });
    const context = createContext();
    const completeBatch = vi.fn();
    const delivered = await withPluginRuntimeGatewayRequestScope(
      { context, client: createSyntheticPluginRuntimeClient(), isWebchatConnect: () => false },
      () =>
        maybeWakeRequesterAfterAllChildrenSettled({
          requesterSessionKey,
          requesterOrigin: child.requesterOrigin,
          isSourceCurrent: () => true,
          settledEntry: child,
          transitionBatch: publishWakeTransition,
          completeBatch,
        }),
    );
    expect(startTurn).toHaveBeenCalledOnce();
    expect(startTurn.mock.calls[0]![0].preflight.request).toMatchObject({
      sessionKey: requesterSessionKey,
      deliver: testCase.external,
      channel: testCase.external ? "telegram" : "webchat",
      to: testCase.external ? "12345" : undefined,
      accountId: testCase.external ? "bot-1" : undefined,
      threadId: testCase.external ? "42" : undefined,
    });
    expect(delivered).toBe(true);
    expect(completeBatch).toHaveBeenCalledOnce();
    if (testCase.narrow) {
      const request = startTurn.mock.calls[0]![0].preflight.request;
      const scopes = resolveInProcessGatewaySyntheticScopes({
        method: "agent",
        requestParams: request,
        operatorScopes: ["operator.sessions.read", "operator.sessions.write"],
      });
      const unbound = testCase.reset || testCase.replaced || testCase.legacy || testCase.mixed;
      expect(scopes).toEqual(unbound ? [] : ["operator.sessions.write"]);
      const client = createSyntheticPluginRuntimeClient({ scopes });
      const registry = context.getGatewayMethodRegistry!();
      const authorization = authorizeGatewayMethod("agent", client, request, registry, context);
      if (unbound) {
        expect(authorization.error).toMatchObject({ message: "missing scope: operator.write" });
      } else {
        expect(authorization).toEqual({ error: null, sessionScope: "operator.sessions.write" });
      }
      expect(
        authorizeGatewayMethod("agent", client, { ...request }, registry, context).error,
      ).toMatchObject({
        message: "missing scope: operator.write",
      });
    }
  });
});
