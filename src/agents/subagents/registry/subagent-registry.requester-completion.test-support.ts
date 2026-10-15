import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import * as config from "../../../config/config.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import * as operatorCapture from "../../../gateway/operator-run-authority.js";
import {
  resolveGatewayChatCronCreatorAuthorityAdmission,
  resolveGatewayCronCreatorAuthorityAdmission,
} from "../../../gateway/server-methods/cron-creator-authority-admission.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../cron-creator-authority-context.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import * as delivery from "../announce/subagent-announce-delivery.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { revokeRequesterCronAuthority } from "../requester-cron-authority.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { settleRequesterTurnAfterSessionSpawns } from "./subagent-registry-requester-yield.js";
import {
  createRequesterInitialTransferFixture,
  markRequesterTurnYieldedWithAuthority,
} from "./subagent-registry-requester-yield.test-support.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerRequesterCompletionCustodyTests({
  registration,
  updateRun,
}: {
  registration: (
    runId: string,
    overrides?: Partial<Parameters<typeof registerSubagentRun>[0]>,
  ) => Parameters<typeof registerSubagentRun>[0];
  updateRun: (runId: string, update: (draft: SubagentRunRecord) => void) => Promise<void>;
}) {
  it.each(["current", "revoked"] as const)(
    "keeps %s original completion custody after a same-human chat admission revokes automation",
    async (authority) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = { session: { store: state.path("sessions.json") } };
        vi.mocked(config.getRuntimeConfig).mockReturnValue(cfg);
        const requesterSessionKey = "agent:main:main";
        const sessionId = "yielded-requester";
        const requesterTurnRunId = "original-requester";
        const runId = "yielded-child";
        await upsertSessionEntryCore(
          { storePath: cfg.session.store, sessionKey: requesterSessionKey, agentId: "main" },
          { sessionId, updatedAt: 1 },
        );
        const context = createContext();
        context.getRuntimeConfig = () => cfg;
        context.resolveGatewayContext = () => context;
        const client = createOperatorClient({
          profileName: "original-requester",
          scopes: ["operator.admin"],
        });
        const revoked = new AbortController();
        const source = expectDefined(
          await operatorCapture.captureGatewayOperatorRunAuthority({
            client,
            context,
            sourceAuthority: {
              signal: revoked.signal,
              assertCurrent: () => revoked.signal.throwIfAborted(),
            },
          }),
          "original requester source",
        );
        client.internal = { operatorRunAuthority: source.authority };
        const { operationalRunInstance } = createTestAdmittedRunContext(requesterTurnRunId);
        const delegated = claimAgentRunDelegatedAuthority(operationalRunInstance);
        registerAgentRunContext(requesterTurnRunId, {
          agentId: "main",
          sessionKey: requesterSessionKey,
          sessionId,
        });
        const capability = expectDefined(
          createCronCreatorAuthorityCapability(
            requesterTurnRunId,
            { kind: "unknown" },
            { source: "control-ui-admin" },
          ),
          "original automation management capability",
        );
        const transfer = createRequesterInitialTransferFixture(subagentRuns);
        const requester = { requesterSessionKey, requesterAgentId: "main", requesterTurnRunId };
        const deliver = vi.spyOn(delivery, "deliverSubagentAnnouncement");
        try {
          await withPluginRuntimeGatewayRequestScope(
            {
              client,
              context,
              resolveGatewayContext: () => context,
              isWebchatConnect: () => false,
            },
            () =>
              runWithCronCreatorAuthorityCapability(capability, () =>
                withGatewayToolCallerIdentity(
                  {
                    agentId: "main",
                    sessionKey: requesterSessionKey,
                    operationalRunInstance,
                    approvalAuthority: delegated,
                    operatorAuthority: source.authority,
                    receiptAuthority: () => validateAgentRunDelegatedAuthority(delegated),
                  },
                  async () => {
                    await registerSubagentRun(
                      registration(runId, { ...requester, gatewayContextResolver: () => context }),
                    );
                    expect(
                      await markRequesterTurnYieldedWithAuthority({
                        ...requester,
                        runs: subagentRuns,
                        transfer,
                      }),
                    ).toBe(1);
                    expect(
                      await settleRequesterTurnAfterSessionSpawns({
                        ...requester,
                        requesterYielded: true,
                        acceptedSessionSpawns: [
                          {
                            runId,
                            childSessionKey: subagentRuns.get(runId)!.childSessionKey,
                            expectsCompletionMessage: true,
                          },
                        ],
                        runs: subagentRuns,
                        transfer,
                        schedule: () => {},
                      }),
                    ).toBe(true);
                  },
                ),
              ),
          );
          releaseAgentRunDelegatedAuthority(delegated);
          clearAgentRunContext(requesterTurnRunId);
          source.release();
          expect(capability.active).toBe(false);
          expect(source.authority.assertCurrent).not.toThrow();

          // A fresh connection for the same human may manage automations; the old batch may not.
          const freshClient = createOperatorClient({
            profileId: source.authority.profileId,
            scopes: ["operator.admin", "operator.approvals"],
          });
          freshClient.internal = { controlUiAdmin: true };
          expect(
            resolveGatewayChatCronCreatorAuthorityAdmission({
              runId: "same-human-next-message",
              resolvedSessionKey: requesterSessionKey,
              client: freshClient,
              hasExplicitOrigin: false,
              hasRestoredCronContinuation: false,
              isIncognito: false,
              isReconnectResume: false,
              isSystemGenerated: false,
              turnKind: "main",
              isDirectExternalUser: true,
            }),
          ).toMatchObject({ managementEntitlement: { source: "control-ui-admin" } });
          await updateRun(runId, (draft) => {
            draft.execution = {
              status: "terminal",
              endedAt: Date.now(),
              outcome: { status: "ok" },
            };
            draft.completion = { required: true, resultText: "Original child result" };
            draft.delivery = { status: "delivered" };
          });
          if (authority === "revoked") {
            revoked.abort(new Error("original operator source revoked"));
          }
          deliver.mockImplementation(async (params) => {
            const retained =
              getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
            expect(retained?.source).toBe(source.authority.source);
            expect(retained?.scopes).toEqual(["operator.admin"]);
            expect(params.triggerMessage).toContain("Original child result");
            expect(
              resolveGatewayCronCreatorAuthorityAdmission({
                runId: params.directIdempotencyKey!,
                resolvedSessionKey: requesterSessionKey,
                sessionId,
                client: createSyntheticPluginRuntimeClient(),
                request: {
                  message: params.triggerMessage,
                  idempotencyKey: params.directIdempotencyKey!,
                },
                inputProvenance: {
                  kind: "inter_session",
                  sourceSessionKey: subagentRuns.get(runId)!.childSessionKey,
                  sourceTool: "subagent_settle",
                },
                hasRestoredCronContinuation: false,
                isOneShotModelRun: false,
                isRestartRecoveryResumeRun: false,
              }),
            ).toBeUndefined();
            return { delivered: true, path: "direct" };
          });
          const completeBatch = vi.fn();
          const unrelatedClient = createOperatorClient({
            profileName: "unrelated-ambient-operator",
            scopes: ["operator.admin", "operator.pairing"],
          });
          // Exercise the real settle dispatcher, including its canonical registry authority wrapper.
          const delivered = await withPluginRuntimeGatewayRequestScope(
            { client: unrelatedClient, context, isWebchatConnect: () => false },
            () =>
              maybeWakeRequesterAfterAllChildrenSettled({
                requesterSessionKey,
                settledEntry: subagentRuns.get(runId)!,
                isSourceCurrent: () => true,
                transitionBatch: async (_batch, wake, onPublished) => {
                  await updateRun(runId, (draft) => {
                    draft.requesterSettleWake = wake;
                  });
                  onPublished([subagentRuns.get(runId)!]);
                },
                completeBatch,
              }),
          );
          expect(delivered).toBe(authority === "current");
          if (authority === "current") {
            expect(deliver).toHaveBeenCalledOnce();
            expect(completeBatch).toHaveBeenCalledWith(
              expect.any(Array),
              expect.any(Number),
              { delivered: true, path: "direct" },
              expect.any(Function),
            );
          } else {
            expect(deliver).not.toHaveBeenCalled();
            expect(subagentRuns.get(runId)?.requesterSettleWake?.lastError).toBe(
              "Subagent completion authority is no longer active",
            );
          }
        } finally {
          deliver.mockRestore();
          releaseAgentRunDelegatedAuthority(delegated);
          clearAgentRunContext(requesterTurnRunId);
          revokeRequesterCronAuthority(requesterSessionKey);
          source.release();
          await resetSubagentRegistryForTests({ persist: false });
        }
      });
    },
  );
}
