import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import * as config from "../../../config/config.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { createAgentTurnTestContext } from "../../../gateway/agent-turn/agent-run-dispatch.test-support.js";
import {
  prepareAgentRunUserTurn,
  releasePreparedAgentRunUserTurn,
} from "../../../gateway/agent-turn/agent-run-user-turn.js";
import { decideTurnGrant } from "../../../gateway/operator-admission.js";
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
import {
  readRetainedRequesterToolCaller,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import * as delivery from "../announce/subagent-announce-delivery.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import { revokeRequesterCronAuthority } from "../requester-cron-authority.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { settleRequesterTurnAfterSessionSpawns } from "./subagent-registry-requester-yield.js";
import {
  createRequesterInitialTransferFixture,
  markRequesterTurnYieldedWithAuthority,
} from "./subagent-registry-requester-yield.test-support.js";
import { retainedOperatorFixture } from "./subagent-registry.completed-followup-authority.test-support.js";
import { registerSubagentRun } from "./subagent-registry.js";
import type { RegistryRegistrationFixture } from "./subagent-registry.requester-completion.fixture.test-support.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.test-helpers.js";

export function registerRequesterAutomationCustodyTests({
  registration,
  updateRun,
}: RegistryRegistrationFixture) {
  it("settles with original completion custody after a same-human chat admission revokes automation", async () => {
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
      const context = createContext([], () => cfg);
      context.resolveGatewayContext = () => context;
      const client = createOperatorClient({
        profileName: "original-requester",
        scopes: ["operator.admin"],
      });
      const revoked = new AbortController();
      const source = expectDefined(
        await operatorCapture.prepareGatewayOperatorRunAuthority({
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
          { source: "operator" },
        ),
        "original automation management capability",
      );
      const transfer = createRequesterInitialTransferFixture(subagentRuns);
      const requester = { requesterSessionKey, requesterAgentId: "main", requesterTurnRunId };
      const settlement = { ...requester, runs: subagentRuns, transfer };
      const scope = { context, isWebchatConnect: () => false };
      const deliver = vi.spyOn(delivery, "deliverSubagentAnnouncement");
      try {
        await withPluginRuntimeGatewayRequestScope(
          { ...scope, client, resolveGatewayContext: () => context },
          () =>
            runWithCronCreatorAuthorityCapability(capability, () =>
              withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey: requesterSessionKey,
                  operationalRunInstance,
                  approvalAuthority: delegated,
                  operatorAuthority: source.authority,
                  receiptAuthority: () => {
                    if (!validateAgentRunDelegatedAuthority(delegated)) {
                      throw new Error("agent tool caller authority is no longer active");
                    }
                  },
                },
                async () => {
                  await registerSubagentRun(
                    registration(runId, { ...requester, gatewayContextResolver: () => context }),
                  );
                  expect(await markRequesterTurnYieldedWithAuthority(settlement)).toBe(1);
                  expect(
                    await settleRequesterTurnAfterSessionSpawns({
                      ...settlement,
                      requesterYielded: true,
                      acceptedSessionSpawns: [
                        {
                          runId,
                          childSessionKey: subagentRuns.get(runId)!.childSessionKey,
                          expectsCompletionMessage: true,
                        },
                      ],
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
            grant: decideTurnGrant(freshClient.connect.scopes ?? []),
            hasExplicitOrigin: false,
            hasRestoredCronContinuation: false,
            isIncognito: false,
            isSystemGenerated: false,
            turnKind: "main",
            isDirectExternalUser: true,
          }),
        ).toMatchObject({ managementEntitlement: { source: "operator" } });
        const resultText = "Original child result";
        await updateRun(runId, (draft) => {
          draft.execution = {
            status: "terminal",
            endedAt: Date.now(),
            outcome: { status: "ok" },
          };
          draft.completion = {
            required: true,
            resultText,
            terminalReply: { disposition: "visible", text: resultText },
          };
          draft.delivery = { status: "pending" };
        });
        deliver.mockImplementation(async (params) => {
          const retained =
            getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
          expect(retained?.source).toBe(source.authority.source);
          expect(retained?.scopes).toEqual(["operator.admin"]);
          expect(params.triggerMessage).toContain(resultText);
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
              isOneShotModelRun: false,
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
        const deliveryAttempt = withPluginRuntimeGatewayRequestScope(
          { ...scope, client: unrelatedClient },
          () =>
            maybeWakeRequesterAfterAllChildrenSettled({
              requesterSessionKey,
              settledEntry: subagentRuns.get(runId)!,
              isSourceCurrent: () => true,
              transitionBatch: async (_batch, wake, onPublished) => {
                await updateRun(runId, (draft) => {
                  draft.requesterSettleWake = wake;
                });
                onPublished?.([subagentRuns.get(runId)!]);
              },
              completeBatch,
            }),
        );
        await expect(deliveryAttempt).resolves.toBe(true);
        expect(deliver).toHaveBeenCalledOnce();
        expect(completeBatch).toHaveBeenCalledWith(
          expect.any(Array),
          expect.any(Number),
          { delivered: true, path: "direct" },
          expect.any(Function),
        );
      } finally {
        deliver.mockRestore();
        releaseAgentRunDelegatedAuthority(delegated);
        clearAgentRunContext(requesterTurnRunId);
        revokeRequesterCronAuthority(requesterSessionKey);
        source.release();
        await resetSubagentRegistryForTests({ persist: false });
      }
    });
  });

  // OA2 matrix cell: asserted-identity channel owner x sessions_yield resume (E12).
  it("resumes an asserted channel owner's yielded turn as owner with its channel identity", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        session: { store: state.path("sessions.json") },
        commands: { ownerAllowFrom: ["imessage:+15550001111"] },
      };
      config.setRuntimeConfigSnapshot(cfg);
      vi.mocked(config.getRuntimeConfig).mockReturnValue(cfg);
      const requesterSessionKey = "agent:main:main";
      const sessionId = "yielded-channel-requester";
      const requesterTurnRunId = "channel-requester";
      const runId = "yielded-channel-child";
      await upsertSessionEntryCore(
        { storePath: cfg.session.store, sessionKey: requesterSessionKey, agentId: "main" },
        { sessionId, updatedAt: 1 },
      );
      const context = createContext([], () => cfg);
      const { client, source } = await retainedOperatorFixture("channel-source", context);
      const origin = {
        sessionKey: requesterSessionKey,
        messageProvider: "imessage",
        accountId: "default",
        senderId: "+15550001111",
        senderE164: "+15550001111",
      };
      const { operationalRunInstance } = createTestAdmittedRunContext(requesterTurnRunId);
      registerAgentRunContext(requesterTurnRunId, {
        agentId: "main",
        sessionKey: requesterSessionKey,
        sessionId,
      });
      const capability = expectDefined(
        createCronCreatorAuthorityCapability(
          requesterTurnRunId,
          { kind: "unknown" },
          { source: "channel-owner" },
        ),
        "channel owner automation capability",
      );
      const transfer = createRequesterInitialTransferFixture(subagentRuns);
      const requester = { requesterSessionKey, requesterAgentId: "main", requesterTurnRunId };
      const settlement = { ...requester, runs: subagentRuns, transfer };
      const scope = { context, isWebchatConnect: () => false };
      const deliver = vi.spyOn(delivery, "deliverSubagentAnnouncement");
      try {
        await withPluginRuntimeGatewayRequestScope(
          { ...scope, client, resolveGatewayContext: () => context },
          () =>
            runWithCronCreatorAuthorityCapability(capability, () =>
              withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey: requesterSessionKey,
                  operationalRunInstance,
                  requesterOrigin: origin,
                  operatorAuthority: source.authority,
                  gatewayContextResolver: () => context,
                },
                async () => {
                  await registerSubagentRun(
                    registration(runId, { ...requester, gatewayContextResolver: () => context }),
                  );
                  expect(await markRequesterTurnYieldedWithAuthority(settlement)).toBe(1);
                  expect(
                    await settleRequesterTurnAfterSessionSpawns({
                      ...settlement,
                      requesterYielded: true,
                      acceptedSessionSpawns: [
                        {
                          runId,
                          childSessionKey: subagentRuns.get(runId)!.childSessionKey,
                          expectsCompletionMessage: true,
                        },
                      ],
                      schedule: () => {},
                    }),
                  ).toBe(true);
                },
              ),
            ),
        );
        clearAgentRunContext(requesterTurnRunId);
        await updateRun(runId, (draft) => {
          draft.execution = { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } };
          draft.completion = {
            required: true,
            resultText: "child result",
            terminalReply: { disposition: "visible", text: "child result" },
          };
          draft.delivery = { status: "pending" };
        });
        let resumed: { senderIsOwner: boolean; senderId?: string | null } | undefined;
        deliver.mockImplementation(async (params) => {
          // Direct delivery passes this retained requester as the resume's `agentToolCaller`.
          const turn = await prepareAgentRunUserTurn({
            cfg,
            context: { ...createAgentTurnTestContext(), getRuntimeConfig: () => cfg },
            client: createSyntheticPluginRuntimeClient({
              agentToolCaller: readRetainedRequesterToolCaller(),
            }),
            // An asserted channel identity carries no operator grant.
            senderIsOwner: false,
            request: { message: params.triggerMessage, idempotencyKey: "yield-resume" },
            runId: "yield-resume",
            admittedSessionId: sessionId,
            resolvedSessionKey: requesterSessionKey,
            activeSessionAgentId: "main",
            suppressVisibleSessionEffects: true,
            requestedPromptPersistenceSuppression: true,
            canUseInternalRuntimeHandoff: false,
            message: params.triggerMessage,
            effectiveTranscriptInputText: params.triggerMessage,
            images: [],
            offloadedRefs: [],
            assertCurrent: () => {},
            onUserTurnMediaPersisted: () => {},
          });
          try {
            resumed = {
              senderIsOwner: turn.senderIsOwner,
              senderId: turn.requesterOrigin?.senderId,
            };
          } finally {
            await releasePreparedAgentRunUserTurn(turn);
          }
          return { delivered: true, path: "direct" };
        });
        await expect(
          maybeWakeRequesterAfterAllChildrenSettled({
            requesterSessionKey,
            settledEntry: subagentRuns.get(runId)!,
            isSourceCurrent: () => true,
            transitionBatch: async (_batch, wake, onPublished) => {
              await updateRun(runId, (draft) => {
                draft.requesterSettleWake = wake;
              });
              onPublished?.([subagentRuns.get(runId)!]);
            },
            completeBatch: vi.fn(),
          }),
        ).resolves.toBe(true);
        expect(resumed).toEqual({ senderIsOwner: true, senderId: origin.senderId });
      } finally {
        deliver.mockRestore();
        clearAgentRunContext(requesterTurnRunId);
        revokeRequesterCronAuthority(requesterSessionKey);
        source.release();
        await resetSubagentRegistryForTests({ persist: false });
      }
    });
  });
}
