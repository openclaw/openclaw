import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, vi } from "vitest";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { prepareGatewaySubagentRun } from "../../../gateway/agent-turn/agent-run-subagent.js";
import { captureAgentTurnPrincipal } from "../../../gateway/agent-turn/principal.js";
import { captureGatewayAuthPolicy } from "../../../gateway/auth-policy.js";
import type {
  GatewayClient,
  GatewayRequestContext,
} from "../../../gateway/server-methods/shared-types.js";
import { createOperatorClient } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { SharedGatewaySessionGenerationState } from "../../../gateway/server-shared-auth-generation.js";
import { onAgentEvent } from "../../../infra/agent-events.js";
import { getPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { ensureGatewayOwnerProfile } from "../../../state/user-profiles.js";
import type { deliverSubagentAnnouncement } from "../announce/subagent-announce-delivery.js";
import { registerSubagentRun } from "./subagent-registry.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { buildRequesterSettleWakeIdentity } from "./subagent-requester-settle-identity.js";

type Registration = Parameters<typeof registerSubagentRun>[0];
type Delivery = Parameters<typeof deliverSubagentAnnouncement>[0];

export function createRequesterCompletionClient(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  owner: boolean;
  ownerAuthMethod: "password" | "token";
  ownerGeneration: string | undefined;
}) {
  const internal: NonNullable<GatewayClient["internal"]> = {
    authenticatedOperator: true,
    controlUiAdmin: true,
  };
  const client = Object.assign(
    createOperatorClient({
      ...(params.owner
        ? { profileId: ensureGatewayOwnerProfile("Owner").id }
        : { profileName: "restart-requester" }),
      scopes: ["operator.admin"],
    }),
    { internal },
  );
  expectDefined(client.authenticatedUserProfile, "requester profile").displayName =
    "restart-requester";
  client.connect.client.id = "openclaw-control-ui";
  client.connect.client.mode = "webchat";
  if (params.owner) {
    // The shared-secret CLI handshake attests the owner but omits display attribution.
    delete client.authenticatedUserProfile;
    delete client.authenticatedUserId;
    client.connect.client.id = "gateway-client";
    client.connect.client.mode = "backend";
    client.internal = { authenticatedOperator: true, operatorRoleActor: { kind: "system" } };
    client.usesSharedGatewayAuth = true;
    client.sharedGatewaySessionGeneration = params.ownerGeneration;
    params.context.sharedGatewaySessionGenerationState = new SharedGatewaySessionGenerationState({
      current: client.sharedGatewaySessionGeneration,
      required: null,
    });
  }
  client.authPolicy = captureGatewayAuthPolicy(params.cfg, {
    role: "operator",
    authMethod: params.owner ? params.ownerAuthMethod : "token",
  });
  return client;
}

/** The incoming worker cohort owns the lead's saved execution and its outgoing parent result. */
export async function prepareNestedRequesterReplay(params: {
  cfg: OpenClawConfig;
  requesterSessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  runIds: readonly string[];
}) {
  const { cfg, requesterSessionKey, sessionId, lifecycleRevision, runIds } = params;
  const runId = buildRequesterSettleWakeIdentity({
    requesterSessionKey,
    requesterAgentId: "main",
    batchRunIds: runIds,
    rearmGeneration: 1,
  }).runId;
  let lifecycleHandler: Parameters<typeof onAgentEvent>[0] | undefined;
  vi.mocked(onAgentEvent).mockImplementation((handler) => {
    lifecycleHandler = handler;
    return () => {};
  });
  await upsertSessionEntryCore(
    { storePath: cfg.session?.store, sessionKey: "agent:main:main", agentId: "main" },
    { sessionId: "top-parent", lifecycleRevision: "top-lifecycle", updatedAt: 1 },
  );
  return {
    runId,
    async register(
      registration: (runId: string, overrides?: Partial<Registration>) => Registration,
      updateRun: (runId: string, update: (draft: SubagentRunRecord) => void) => Promise<void>,
      context: GatewayRequestContext,
    ) {
      await registerSubagentRun(
        registration(runId, {
          childSessionKey: requesterSessionKey,
          sessionEntry: { sessionId, lifecycleRevision },
          requesterSessionKey: "agent:main:main",
          requesterAgentId: "main",
          requesterTurnRunId: "top-parent-turn",
          completionTarget: "parent",
          completionRequesterSessionId: "top-parent",
          completionRequesterLifecycleRevision: "top-lifecycle",
          gatewayContextResolver: () => context,
        }),
      );
      await updateRun(runId, (draft) => {
        draft.requesterSettleWake = {
          status: "pending",
          attemptCount: 0,
          rearmGeneration: 1,
          batchRunIds: [runId],
          requesterYieldBatch: true,
        };
      });
    },
    async complete(delivery: Delivery) {
      expect(delivery.directIdempotencyKey).toBe(runId);
      const resumed = await prepareGatewaySubagentRun({
        cfg,
        client: captureAgentTurnPrincipal(getPluginRuntimeGatewayRequestScope()?.client ?? null),
        resolvedSessionKey: requesterSessionKey,
        activeSessionAgentId: "main",
        inputProvenance: {
          kind: "inter_session",
          sourceTool: "subagent_settle",
          sourceSessionKey: runIds[0],
        },
        request: { message: delivery.triggerMessage },
        isOneShotModelRun: false,
        runId,
        getAdmittedSessionId: () => sessionId,
        assertResumeAdmissionCurrent: () => ({ sessionId, lifecycleRevision, updatedAt: 1 }),
        context: {
          resolveGatewayContext: () =>
            expectDefined(getPluginRuntimeGatewayRequestScope()?.context, "restored Gateway"),
          logGateway: { warn: vi.fn() },
        },
      });
      expect(resumed).toMatchObject({ pluginSubagent: false, reactivateSubagent: false });
      expectDefined(
        lifecycleHandler,
        "restored lifecycle owner",
      )({
        stream: "lifecycle",
        runId,
        sessionKey: requesterSessionKey,
        seq: 1,
        ts: Date.now(),
        data: {
          phase: "end",
          endedAt: Date.now(),
          terminalReply: { disposition: "visible", text: "Sub-lead integration complete" },
        },
      });
    },
    expectCompleted(settled: ReadonlyMap<string, SubagentRunRecord>, deliveries: Delivery[]) {
      expect(
        deliveries.map((delivery) => ({
          target: delivery.targetRequesterSessionKey,
          runId: delivery.directIdempotencyKey,
          settle: Boolean(delivery.onBeforeDispatch),
        })),
      ).toEqual([
        { target: requesterSessionKey, runId, settle: true },
        { target: "agent:main:main", runId: expect.any(String), settle: true },
      ]);
      expect(settled.get(runId)).toMatchObject({
        execution: { status: "terminal", outcome: { status: "ok" } },
        delivery: { status: "delivered" },
        completion: { resultText: "Sub-lead integration complete" },
      });
      expect(settled.get(runId)?.requesterSettleWake).toBeUndefined();
      expect(deliveries[1]).toMatchObject({ targetRequesterSessionKey: "agent:main:main" });
      expect(deliveries[1]?.triggerMessage).toContain("Sub-lead integration complete");
    },
    dispose() {
      vi.mocked(onAgentEvent).mockReturnValue(() => {});
    },
  };
}
