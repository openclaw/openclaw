import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import * as operatorCapture from "../../../gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
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
import { createDeferredCore } from "../../../shared/deferred.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  mergeAcceptedSessionSpawnsForRun,
  retireAcceptedSessionSpawnCompletionForRun,
} from "../../accepted-session-spawn.js";
import { createOperationalRunInstanceRef } from "../../operational-run-instance.js";
import { requesterCreatorProfileId } from "../../requester-origin.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { settleRequesterTurnAfterSessionSpawns } from "./subagent-registry-requester-yield.js";
import {
  createRequesterInitialTransferFixture,
  markRequesterTurnYieldedWithAuthority,
} from "./subagent-registry-requester-yield.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { registerSubagentRun, replaceSubagentRunAfterSteerCore } from "./subagent-registry.js";
import type { RegistryRegistrationFixture } from "./subagent-registry.requester-completion.fixture.test-support.js";
import {
  releaseSubagentRun,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function operatorFixture(
  profileName: string,
  attachAccess = true,
  context = createContext(),
  resolveGatewayContext = () => context,
) {
  context.resolveGatewayContext = resolveGatewayContext;
  const client = createOperatorClient({ profileName, scopes: ["operator.write"] });
  const revoked = new AbortController();
  const sourceAuthority = {
    signal: revoked.signal,
    assertCurrent: () => revoked.signal.throwIfAborted(),
  };
  if (attachAccess) {
    client.internal = { operatorAccessAuthority: sourceAuthority };
  }
  return { context, resolveGatewayContext, client, revoked, sourceAuthority };
}

export async function retainedOperatorFixture(
  profileName: string,
  context?: ReturnType<typeof createContext>,
  resolveGatewayContext?: () => ReturnType<typeof createContext>,
) {
  const fixture = operatorFixture(profileName, false, context, resolveGatewayContext);
  const source = expectDefined(
    await operatorCapture.captureGatewayOperatorRunAuthority(fixture),
    "operator registration source",
  );
  fixture.client.internal = { operatorRunAuthority: source.authority };
  return { ...fixture, source };
}

export function registerCompletedFollowupAuthorityTests({
  registration,
  updateRun,
}: RegistryRegistrationFixture) {
  it.each(["original", "successor"] as const)(
    "keeps completed-result and followup custody independent when the %s source is revoked",
    (revokedOwner) =>
      withOpenClawTestState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot({});
        const context = createContext();
        const resolveGatewayContext = () => context;
        const captureSource = async (profileName: string) => {
          const { source, revoked, client } = await retainedOperatorFixture(
            profileName,
            context,
            resolveGatewayContext,
          );
          return {
            ...source,
            revoked,
            run: <T>(work: () => T) =>
              withPluginRuntimeGatewayRequestScope(
                { client, context, resolveGatewayContext, isWebchatConnect: () => false },
                work,
              ),
          };
        };
        const original = await captureSource("completion-owner");
        let followup: Awaited<ReturnType<typeof captureSource>> | undefined;
        try {
          await original.run(() =>
            registerSubagentRun(
              registration("child", { requesterAgentId: "main", requesterTurnRunId: "parent" }),
            ),
          );
          original.release();
          expect(original.authority.assertCurrent).not.toThrow();
          const entry = expectDefined(subagentRuns.get("child"), "completed child");
          await updateRun(entry.runId, (draft) => {
            draft.execution = { status: "terminal", endedAt: 1, outcome: { status: "ok" } };
            draft.delivery = { status: "pending" };
            draft.cleanupHandled = true; // Delivery is outside this custody proof.
          });
          followup = await captureSource("followup-owner");
          expect(
            await followup.run(() =>
              replaceSubagentRunAfterSteerCore({
                previousRunId: entry.runId,
                nextRunId: "successor",
                expected: subagentRuns.get(entry.runId),
                allowEndedSource: true,
                preserveCompletedRun: true,
                task: "second turn",
              }),
            ),
          ).toBe(true);
          followup.release();
          const retained = expectDefined(subagentRuns.get(entry.runId), "pending completed result");
          const successor = expectDefined(subagentRuns.get("successor"), "followup child");
          const stored = loadSubagentRegistryFromSqlite();
          expect(stored.get(entry.runId)).toMatchObject({
            execution: { status: "terminal", suppressSessionEffects: true },
            delivery: { status: "pending" },
            requesterTurnRunId: "parent",
          });
          expect(stored.get(successor.runId)).toMatchObject({
            taskRunId: successor.runId,
            task: "second turn",
            execution: { status: "running" },
          });
          expect(successor.requesterTurnRunId).toBeUndefined();
          expect(successor.requesterTurnYielded).toBeUndefined();
          const completionSource = (run: SubagentRunRecord) =>
            subagentRuns.runWithCompletionAuthority(
              run,
              () =>
                getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority
                  ?.source,
            );
          // Suppressing old session effects must not retire its pending result's custody.
          expect(completionSource(retained)).toBe(original.authority.source);
          expect(completionSource(successor)).toBe(followup.authority.source);
          const revokeOriginal = revokedOwner === "original";
          (revokeOriginal ? original.revoked : followup.revoked).abort(
            new Error("operator revoked"),
          );
          expect(() => completionSource(revokeOriginal ? retained : successor)).toThrow(
            /authority/,
          );
          expect(completionSource(revokeOriginal ? successor : retained)).toBe(
            revokeOriginal ? followup.authority.source : original.authority.source,
          );
          await releaseSubagentRun(entry.runId);
          await releaseSubagentRun(successor.runId);
          expect(original.authority.assertCurrent).toThrow();
          expect(() => subagentRuns.runWithCompletionAuthority(entry, () => "stale")).toThrow(
            /authority/,
          );
        } finally {
          original.release();
          followup?.release();
          await resetSubagentRegistryForTests({ persist: false });
        }
      }),
  );
}

export function registerSingletonRequesterAuthorityTests({
  registration,
  updateRun,
}: RegistryRegistrationFixture) {
  async function fixture(
    options: { original?: boolean; principal?: boolean; accounting?: boolean } = {},
  ) {
    const owner = await retainedOperatorFixture("selected-requester");
    const requesterSessionKey = "agent:main:main";
    const requesterTurnRunId = "singleton-parent";
    const sessionId = "singleton-requester";
    const lifecycleRevision = "singleton-incarnation";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: requesterSessionKey },
      { sessionId, lifecycleRevision, updatedAt: 1 },
    );
    const instance = createOperationalRunInstanceRef(requesterTurnRunId);
    const delegated = claimAgentRunDelegatedAuthority(instance);
    registerAgentRunContext(requesterTurnRunId, {
      agentId: "main",
      sessionKey: requesterSessionKey,
      sessionId,
    });
    const selectedOrigin = {
      sessionKey: requesterSessionKey,
      ...(options.principal === false
        ? {}
        : { operatorProfileId: owner.source.authority.profileId }),
      delegatedCreatorProfileId: "delegating-creator",
    };
    const requester = { requesterSessionKey, requesterAgentId: "main", requesterTurnRunId };
    const receipt = {
      runId: "singleton-child",
      childSessionKey: "agent:main:subagent:singleton-child",
      expectsCompletionMessage: true,
    };
    try {
      await withPluginRuntimeGatewayRequestScope({ ...owner, isWebchatConnect: () => false }, () =>
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: requesterSessionKey,
            ...(options.original === false ? {} : { operationalRunInstance: instance }),
            operatorAuthority: owner.source.authority,
            approvalAuthority: delegated,
            receiptAuthority: () => validateAgentRunDelegatedAuthority(delegated),
            requesterOrigin: {
              sessionKey: requesterSessionKey,
              operatorProfileId: "delegating-creator",
            },
            personalToolIdentityScoped: true,
            personalToolSelection: Object.freeze({
              operatorAuthority: owner.source.authority,
              requesterOrigin: selectedOrigin,
              assertCurrent: owner.source.authority.assertCurrent,
            }),
            gatewayContextResolver: owner.resolveGatewayContext,
          },
          async () => {
            await registerSubagentRun(
              registration(receipt.runId, {
                ...requester,
                completionRequesterSessionId: sessionId,
                completionRequesterLifecycleRevision: lifecycleRevision,
                gatewayContextResolver: owner.resolveGatewayContext,
              }),
            );
            if (options.accounting !== false) {
              mergeAcceptedSessionSpawnsForRun(instance, [receipt]);
            }
            const settlement = {
              ...requester,
              runs: subagentRuns,
              transfer: createRequesterInitialTransferFixture(subagentRuns),
            };
            expect(await markRequesterTurnYieldedWithAuthority(settlement)).toBe(1);
            expect(
              await settleRequesterTurnAfterSessionSpawns({
                ...settlement,
                requesterYielded: true,
                acceptedSessionSpawns: [receipt],
                schedule: () => {},
              }),
            ).toBe(true);
          },
        ),
      );
      releaseAgentRunDelegatedAuthority(delegated);
      clearAgentRunContext(requesterTurnRunId);
      owner.source.release();
      expect(validateAgentRunDelegatedAuthority(delegated)).toBe(false);
      await updateRun(receipt.runId, (draft) => {
        draft.execution = { status: "terminal", endedAt: 1, outcome: { status: "ok" } };
        draft.delivery = { status: "pending" };
      });
      return { ...owner, instance, receipt, selectedOrigin };
    } catch (error) {
      releaseAgentRunDelegatedAuthority(delegated);
      clearAgentRunContext(requesterTurnRunId);
      owner.source.release();
      throw error;
    }
  }

  it.each([false, true])("retains the original singleton requester after cleanup: %s", (cleaned) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const owner = await fixture();
      try {
        if (cleaned) {
          await updateRun(owner.receipt.runId, (draft) => {
            draft.cleanupHandled = true;
            draft.cleanupCompletedAt = 1;
          });
        }
        const entry = expectDefined(subagentRuns.get(owner.receipt.runId), "yielded child");
        subagentRuns.runWithCompletionBatchAuthority([entry], () =>
          expect(getGatewayToolCallerIdentity()).toBeUndefined(),
        );
        await subagentRuns.runWithCompletionBatchRequester([entry], async (caller) => {
          expect(caller?.requesterOrigin).toEqual(owner.selectedOrigin);
          expect(requesterCreatorProfileId(caller?.requesterOrigin)).toBe("delegating-creator");
          expect(caller).not.toHaveProperty("operationalRunInstance");
          expect(caller).not.toHaveProperty("approvalAuthority");
          expect(getGatewayToolCallerIdentity()?.operationalRunInstance).toBeUndefined();
          expect(caller?.assertCurrent).not.toThrow();
        });
      } finally {
        owner.source.release();
      }
    }),
  );

  it.each([
    "missing original",
    "missing principal",
    "missing accounting",
    "another receipt",
    "cancelled receipt",
    "unfrozen",
    "pause",
    "retirement",
    "parent incarnation",
    "child generation",
  ] as const)("does not select a requester for an incomplete or changed singleton (%s)", (change) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const owner = await fixture({
        original: change !== "missing original",
        principal: change !== "missing principal",
        accounting: change !== "missing accounting",
      });
      try {
        if (change === "another receipt" || change === "cancelled receipt") {
          const sibling = {
            runId: "original-sibling",
            childSessionKey: "agent:main:subagent:original-sibling",
            expectsCompletionMessage: true,
          };
          mergeAcceptedSessionSpawnsForRun(owner.instance, [sibling]);
          if (change === "cancelled receipt") {
            retireAcceptedSessionSpawnCompletionForRun(owner.instance, sibling);
          }
        } else if (
          change !== "missing original" &&
          change !== "missing principal" &&
          change !== "missing accounting"
        ) {
          await updateRun(owner.receipt.runId, (draft) => {
            if (change === "unfrozen") {
              draft.requesterSettleWake!.batchRunIds = undefined;
            }
            if (change === "pause") {
              draft.requesterSettleWake!.pauseNotice = { acknowledgment: "Waiting" };
            }
            if (change === "retirement") {
              draft.requesterSettleWake!.retireAfterSettle = true;
            }
            if (change === "parent incarnation") {
              draft.completionRequesterLifecycleRevision = "replacement";
            }
            if (change === "child generation") {
              draft.generation = (draft.generation ?? 0) + 1;
            }
          });
        }
        const entry = expectDefined(subagentRuns.get(owner.receipt.runId), "surviving child");
        await subagentRuns.runWithCompletionBatchRequester([entry], async (caller) => {
          expect(caller).toBeUndefined();
          expect(getGatewayToolCallerIdentity()).toBeUndefined();
        });
      } finally {
        owner.source.release();
      }
    }),
  );

  it.each(["late receipt", "release", "parent incarnation", "replacement"] as const)(
    "refuses a selected singleton effect when %s changes after an await",
    (change) =>
      withOpenClawTestState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot({});
        const owner = await fixture();
        const entered = createDeferredCore();
        const resume = createDeferredCore();
        const entry = expectDefined(subagentRuns.get(owner.receipt.runId), "yielded child");
        const effect = subagentRuns.runWithCompletionBatchRequester([entry], async (caller) => {
          expect(caller?.requesterOrigin).toEqual(owner.selectedOrigin);
          entered.resolve();
          await resume.promise;
          caller?.assertCurrent?.();
          return "effect";
        });
        const outcome = effect.then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        try {
          await awaitGateBeforeSettlement(
            entered.promise,
            effect,
            "Singleton did not admit its selected requester",
          );
          if (change === "late receipt") {
            mergeAcceptedSessionSpawnsForRun(owner.instance, [
              {
                runId: "late-child",
                childSessionKey: "agent:main:subagent:late-child",
                expectsCompletionMessage: true,
              },
            ]);
          } else if (change === "release") {
            subagentRuns.releaseCompletionAuthority(entry);
          } else {
            await updateRun(entry.runId, (draft) => {
              if (change === "parent incarnation") {
                draft.completionRequesterLifecycleRevision = "replacement";
              } else {
                draft.generation = (draft.generation ?? 0) + 1;
              }
            });
          }
          resume.resolve();
          await expect(outcome).resolves.toMatchObject({ error: expect.any(Error) });
        } finally {
          resume.resolve();
          await outcome;
          owner.source.release();
        }
      }),
  );
}
