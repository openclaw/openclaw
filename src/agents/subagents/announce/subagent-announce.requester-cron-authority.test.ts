import { describe, expect, it, onTestFinished } from "vitest";
import type { CronJob } from "../../../cron/types.js";
import type { AgentRuntimeIdentity } from "../../../gateway/agent-runtime-identity-token.js";
import {
  registryRuntimeMock,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import {
  REQUESTER,
  deliverSpy,
  makeSettledChild,
} from "./subagent-announce.requester-settle-wake.test-support.js";

const { maybeWakeRequesterAfterAllChildrenSettled } =
  await import("./subagent-announce.requester-settle-wake.js");

describe("requester continuation automation management", () => {
  it.each([false, true])(
    "keeps automations manageable after yield with retired batch: %s",
    async (retiredBatch) => {
      const { withCronManagementGrant } =
        await import("../../../gateway/cron-creator-authority-grant.js");
      const { cronJobMatchesCallerScope, readCronCallerScope } =
        await import("../../../gateway/server-methods/cron-caller-scope.js");
      const { resolveGatewayCronCreatorAuthorityAdmission } =
        await import("../../../gateway/server-methods/cron-creator-authority-admission.js");
      const { createSyntheticPluginRuntimeClient } =
        await import("../../../gateway/server-plugin-runtime-client.js");
      const {
        claimAgentRunDelegatedAuthority,
        registerAgentRunContext,
        releaseAgentRunDelegatedAuthority,
      } = await import("../../../infra/agent-run-registry.js");
      const { createTestAdmittedRunContext } =
        await import("../../admitted-run-context.test-support.js");
      const {
        bindCronManagementGrant,
        createCronCreatorAuthorityCapability,
        runWithCronCreatorAuthorityCapability,
      } = await import("../../cron-creator-authority-context.js");
      const { withGatewayToolCallerIdentity } =
        await import("../../tools/gateway-caller-context.js");
      const { markRequesterTurnYieldedInRuns, settleRequesterTurnAfterSessionSpawns } =
        await import("../registry/subagent-registry-requester-yield.js");
      const sourceRunId = "admin-requester";
      const child = makeSettledChild({
        runId: "run-b",
        requesterAgentId: "main",
        requesterTurnRunId: sourceRunId,
        requesterSettleWake: undefined,
      });
      const runs = new Map([[child.runId, child]]);
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
      const original = createTestAdmittedRunContext(sourceRunId).operationalRunInstance;
      const originalAuthority = claimAgentRunDelegatedAuthority(original);
      registerAgentRunContext(sourceRunId, {
        sessionKey: REQUESTER,
        sessionId: "sess-main",
        agentId: "main",
      });
      onTestFinished(() => {
        releaseAgentRunDelegatedAuthority(originalAuthority);
      });
      const originalCapability = createCronCreatorAuthorityCapability(
        sourceRunId,
        { kind: "unknown" },
        { source: "control-ui-admin" },
      )!;
      await runWithCronCreatorAuthorityCapability(originalCapability, () =>
        withGatewayToolCallerIdentity(
          { agentId: "main", sessionKey: REQUESTER, approvalAuthority: originalAuthority },
          async () => {
            expect(
              markRequesterTurnYieldedInRuns({
                requesterSessionKey: REQUESTER,
                requesterAgentId: "main",
                requesterTurnRunId: sourceRunId,
                runs,
                persistOrThrow: () => {},
              }),
            ).toBe(1);
            expect(
              settleRequesterTurnAfterSessionSpawns({
                requesterSessionKey: REQUESTER,
                requesterAgentId: "main",
                requesterTurnRunId: sourceRunId,
                requesterYielded: true,
                acceptedSessionSpawns: [
                  {
                    runId: child.runId,
                    childSessionKey: child.childSessionKey,
                    expectsCompletionMessage: true,
                  },
                ],
                runs,
                persistOrThrow: () => {},
                schedule: () => {},
              }),
            ).toBe(true);
          },
        ),
      );
      releaseAgentRunDelegatedAuthority(originalAuthority);
      expect(originalCapability.active).toBe(false);

      const job: CronJob = {
        id: "existing-maintenance-job",
        name: "Maintenance",
        enabled: false,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 1_800_000 },
        sessionTarget: "main",
        agentId: "main",
        sessionKey: REQUESTER,
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "Check service health" },
        scheduledToolPolicy: { version: 1, mode: "trusted" },
        state: {},
      };
      let canManage = false;
      deliverSpy.mockImplementationOnce(async (params) => {
        const runId = String(params.directIdempotencyKey);
        const admission = resolveGatewayCronCreatorAuthorityAdmission({
          runId,
          resolvedSessionKey: REQUESTER,
          sessionId: "sess-main",
          client: createSyntheticPluginRuntimeClient(),
          request: { message: String(params.triggerMessage), idempotencyKey: runId },
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: child.childSessionKey,
            sourceTool: String(params.sourceTool),
          },
          hasRestoredCronContinuation: false,
          isOneShotModelRun: false,
          isRestartRecoveryResumeRun: false,
        });
        if (admission) {
          const operationalRunInstance = createTestAdmittedRunContext(runId).operationalRunInstance;
          const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
          const identity: AgentRuntimeIdentity = {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: REQUESTER,
            operationalRunInstance,
            delegatedAuthority: { kind: "local", ...authority },
          };
          const client = createSyntheticPluginRuntimeClient();
          client.internal!.agentRuntimeIdentity = identity;
          expect(cronJobMatchesCallerScope({ job, callerScope: readCronCallerScope(client) })).toBe(
            false,
          );
          const capability = createCronCreatorAuthorityCapability(
            runId,
            admission.callerOrigin,
            admission.managementEntitlement,
            admission.isCurrent,
          )!;
          admission.bindRunScope?.(capability);
          try {
            await runWithCronCreatorAuthorityCapability(capability, () =>
              withGatewayToolCallerIdentity(
                { agentId: "main", sessionKey: REQUESTER, approvalAuthority: authority },
                async () => {
                  if (retiredBatch) {
                    child.requesterSettleWake = undefined;
                    runs.delete(child.runId);
                  }
                  const management = bindCronManagementGrant(runId)!;
                  expect(management.managementOnly).toBe(true);
                  await withCronManagementGrant(
                    management.mint("cron.update")!,
                    identity,
                    "cron.update",
                    async () => {
                      canManage = cronJobMatchesCallerScope({
                        job,
                        callerScope: readCronCallerScope(client),
                      });
                    },
                  );
                },
              ),
            );
          } finally {
            releaseAgentRunDelegatedAuthority(authority);
          }
        }
        return { delivered: true, path: "direct" };
      });
      expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
      expect(canManage).toBe(true);
    },
  );
});
