import "./subagent-announce.requester-settle-dispatch-mocks.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { authorizeGatewayMethod } from "../../../gateway/server-methods/method-authorization.js";
import { resolveInProcessGatewayDispatch } from "../../../gateway/server-plugin-in-process-authority.js";
import { withOperatorToolGatewayAuthority } from "../../../gateway/server-plugin-in-process-dispatch.js";
import * as deliveryRuntime from "./subagent-announce-delivery.runtime.js";
import {
  registryRead,
  startTurn,
  loadRequester,
  settledChild,
  requesterSnapshot,
  useDirectDelivery,
  withGateway,
  wakeParams,
  useRequesterSettleDispatchFixture,
  createRequesterSettleContext as createContext,
} from "./subagent-announce.requester-settle-dispatch.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";

describe("requester settle routing and session authority", () => {
  useRequesterSettleDispatchFixture();
  beforeEach(() => setRuntimeConfigSnapshot({}));
  afterEach(() => clearRuntimeConfigSnapshot());

  it.each([
    "WebChat settle",
    "WebChat pause",
    "external",
    "saved-route",
    "current",
    "reset",
    "replaced",
    "mixed",
    "legacy",
  ])("keeps %s on its owning route despite external session history", async (mode) => {
    const external = mode === "external" || mode === "saved-route";
    const narrow = ["current", "reset", "replaced", "mixed", "legacy"].includes(mode);
    const channel = mode === "saved-route" ? undefined : external ? "telegram" : "webchat";
    const requesterSessionKey = "agent:main:dashboard:completion-route";
    const requesterIdentity = {
      sessionId: mode === "replaced" ? "replacement-session" : "requester-session",
      lifecycleRevision: narrow
        ? mode === "reset"
          ? "reset-revision"
          : "requester-revision"
        : undefined,
    };
    const child = settledChild();
    child.requesterSessionKey = requesterSessionKey;
    child.completionRequesterSessionId = "requester-session";
    if (narrow) {
      child.completionRequesterLifecycleRevision =
        mode === "mixed" ? "older-revision" : "requester-revision";
      vi.mocked(deliveryRuntime.captureRequesterSessionEntryCurrent).mockResolvedValue({
        readCurrent: () => requesterIdentity,
        release() {},
      });
      child.execution.outcome = { status: "error", error: "Child preparation failed" };
      child.completion = { required: true, resultText: "Child preparation failed" };
      child.delivery = { status: "pending" };
    }
    if (mode === "legacy") {
      child.completionRequesterSessionId = undefined;
      child.completionRequesterLifecycleRevision = undefined;
    }
    child.requesterOrigin = channel ? { channel } : undefined;
    if (mode === "WebChat pause") {
      child.pauseReason = "sessions_yield";
      child.execution.outcome = undefined;
      child.requesterSettleWake!.pauseNotice = { acknowledgment: "Need direction." };
    }
    const cohort = [child];
    if (mode === "mixed") {
      cohort.push({
        ...child,
        runId: "current-sibling",
        childSessionKey: "agent:main:subagent:current-sibling",
        completionRequesterLifecycleRevision: requesterIdentity.lifecycleRevision,
      });
    }
    registryRead.listSubagentRunsForRequester.mockReturnValue(cohort);
    const requester = requesterSnapshot(
      {},
      {
        ...requesterIdentity,
        updatedAt: 1,
        delivery: {
          kind: "external",
          route: { channel: "telegram", target: { to: "12345" } },
          context: { channel: "telegram", to: "12345", accountId: "bot-1", threadId: 42 },
          origin: { provider: "webchat", to: requesterSessionKey, surface: "webchat" },
        },
      },
      { sessionKey: requesterSessionKey, storePath: "/synthetic/requester-settle.sqlite" },
    );
    loadRequester.mockResolvedValue(requester);
    useDirectDelivery(requester);
    startTurn.mockImplementation(async ({ preflight, io }) => {
      io.emitAcceptance([true, { runId: preflight.request.idempotencyKey, status: "accepted" }]);
      io.emitFinal([
        true,
        {
          status: "ok",
          result: {
            payloads: [{ text: "Completed." }],
            ...(external
              ? { deliveryStatus: { status: "sent", succeeded: true, resultCount: 1 } }
              : {}),
          },
        },
      ]);
    });
    const context = createContext();
    const completeBatch = vi.fn();
    const delivered = await withGateway(context, () =>
      maybeWakeRequesterAfterAllChildrenSettled(wakeParams(child, completeBatch)),
    );
    expect(startTurn).toHaveBeenCalledOnce();
    expect(startTurn.mock.calls[0]![0].preflight.request).toMatchObject({
      sessionKey: requesterSessionKey,
      deliver: external,
      channel: external ? "telegram" : "webchat",
      to: external ? "12345" : undefined,
      accountId: external ? "bot-1" : undefined,
      threadId: external ? "42" : undefined,
    });
    expect(delivered).toBe(true);
    expect(completeBatch).toHaveBeenCalledOnce();
    if (narrow) {
      const request = startTurn.mock.calls[0]![0].preflight.request;
      const { client } = await withOperatorToolGatewayAuthority(
        {
          operatorRoleActor: { kind: "system" },
          scopes: ["operator.sessions.read", "operator.sessions.write"],
        },
        async () =>
          resolveInProcessGatewayDispatch("agent", request, {
            forceSyntheticClient: true,
            resolveGatewayContext: () => context,
          }),
      );
      const unbound = mode !== "current";
      expect(client.connect.scopes).toEqual(unbound ? [] : ["operator.sessions.write"]);
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
