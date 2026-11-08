import { describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { makeRestartRecoveryRun as makeRunRecord, useSubagentRestartRecoveryFixture } from "./subagent-restart-recovery.test-support.js";
import { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import * as replacementWorker from "../../../config/sessions/session-accessor.sqlite-replacement-worker.js";
import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import { createOperatorRecoveryFixture } from "../../../gateway/operator-run-recovery.test-support.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import {
  activateSubagentRegistry,
  addSubagentRunForTests,
  initSubagentRegistry,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";

describe("accepted subagent restart recovery", () => {
  const fixture = useSubagentRestartRecoveryFixture();

  it.each(["current", "replaced before native effect"] as const)(
    "settles an accepted child without a lifecycle run at boot and promptly notifies its requester (%s)",
    async (childOwner) => {
      const childSessionKey = "agent:main:subagent:accepted-before-crash";
      const requesterSessionKey = "agent:main:accepted-requester";
      const runId = "accepted-before-crash";
      const startedAt = Date.now();
      const profile = ensureProfileForEmail("accepted-original@example.test");
      const requester = await createOperatorRecoveryFixture({
        stateDir: fixture.stateDir,
        context: createContext(),
        profileId: profile.id,
        config: {},
        sourceIngress: "internal",
        sessionKey: requesterSessionKey,
        sessionId: "accepted-requester-session",
      });
      requester.context.recoveryRuntime = fixture.gatewayRuntime;
      requester.context.chatAbortControllers = new Map();
      requester.context.resolveGatewayContext = () => requester.context;
      const childScope = { agentId: "main", sessionKey: childSessionKey };
      const claim = {
        restartRecoveryDeliveryRunId: runId,
        restartRecoveryDeliverySourceRunId: runId,
        restartRecoverySourceIngress: "channel",
        restartRecoveryDeliveryContext: {
          channel: "telegram",
          accountId: "accepted-account",
          to: "-1001234567890",
          threadId: "42",
        },
        restartRecoveryRequesterAccountId: "accepted-account",
        restartRecoveryRequesterSenderId: "123456789",
        restartRecoverySameChannelThreadRequired: true,
        restartRecoverySourceReplyDeliveryMode: "automatic",
        restartRecoveryTerminalRunIds: ["previous-child-input"],
        restartRecoveryTerminalDeliveryEvidence: [
          {
            runId: "previous-child-input",
            captured: true,
            deliveryContext: { channel: "telegram", to: "-1001234567890" },
            deliveryStatus: { status: "sent", resultCount: 1 },
            durableFinalReceipt: {
              intentId: "previous-intent",
              deliveryId: "previous-delivery",
              platformMessageId: "previous-message",
            },
          },
        ],
      } satisfies Partial<InternalSessionEntry>;
      // Include every present claim field, not only the fields named in this fixture.
      const claims = (row: InternalSessionEntry | undefined) =>
        Object.fromEntries(
          Object.entries(row ?? {}).filter(([key]) => key.startsWith("restartRecovery")),
        );
      const readChild = () =>
        readSessionEntryReadOnlyInWorker({
          ...childScope,
          projection: "full",
          readConsistency: "latest",
        });
      await replaceSessionEntry(childScope, {
        sessionId: "accepted-child-session",
        lifecycleRevision: "accepted-child-revision",
        updatedAt: startedAt,
        abortedLastRun: false,
        ...claim,
      });
      const entry = makeRunRecord({
        runId,
        childSessionKey,
        requesterSessionKey,
        childSessionIdentity: {
          sessionId: "accepted-child-session",
          lifecycleRevision: "accepted-child-revision",
        },
        completionRequesterSessionId: "accepted-requester-session",
        completionRequesterLifecycleRevision: requester.entry.lifecycleRevision,
        requesterAgentId: "main",
        requesterStorePath: requester.target.storePath,
        requesterTurnRunId: requester.target.sourceRunId,
        operatorRecoverySource: requester.entry.restartRecoveryOperatorSource,
        completionAuthorityRequired: true,
        requesterOrigin: undefined,
        createdAt: startedAt,
        execution: {
          status: "running",
          startedAt,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        },
        expectsCompletionMessage: true,
      });
      await addSubagentRunForTests(entry);
      await fixture.settle();
      expect(loadSubagentRegistryFromSqlite().get(runId)?.execution.status).toBe("running");
      const before = loadExactSessionEntry(childScope)?.entry;
      expect(before?.lifecycleRunId).toBeUndefined();
      expect(before?.lastRunId).toBeUndefined();
      expect(before?.abortedLastRun).toBe(false);
      const persistedBefore = await readChild();
      if (!persistedBefore) {
        throw new Error("Accepted child was not persisted");
      }
      expect(claims(persistedBefore)).toEqual(claim);
      const savedClaims = claims(persistedBefore);
      let marked: InternalSessionEntry | undefined;
      let replacement: InternalSessionEntry | undefined;
      let principalAtHandoff: string | undefined;
      let effectFailure: unknown;
      let effectAttempts = 0;
      const commit = replacementWorker.commitSessionEntryReplacementsInWorker;
      vi.spyOn(replacementWorker, "commitSessionEntryReplacementsInWorker").mockImplementation(
        async (...args) => {
          const candidate = args[2].replacements.find((row) => row.sessionKey === childSessionKey);
          const marking =
            candidate?.entry.abortedLastRun === true && candidate.entry.status === undefined;
          const terminalEffect = candidate?.entry.status === "interrupted";
          if (terminalEffect) {
            effectAttempts += 1;
            if (childOwner === "replaced before native effect") {
              // Timing has its postimage and CAS preimage. Use the real session owner
              // to replace the child, then run the unmodified native worker checks.
              replaceSessionEntrySync(childScope, {
                ...persistedBefore,
                sessionId: "replacement-child-session",
                lifecycleRevision: "replacement-child-revision",
                lifecycleRunId: "replacement-child-run",
                lastRunId: "replacement-child-run",
                updatedAt: startedAt + 1,
                restartRecoveryDeliveryRunId: "replacement-claim",
                restartRecoveryDeliverySourceRunId: "replacement-claim",
              });
              replacement = await readChild();
            }
          }
          try {
            const result = await commit(...args);
            if (marking) {
              marked = await readChild();
            }
            return result;
          } catch (error) {
            if (terminalEffect) {
              effectFailure = error;
            }
            throw error;
          }
        },
      );
      vi.mocked(runSubagentAnnounceFlow).mockImplementation(async () => {
        principalAtHandoff =
          getPluginRuntimeGatewayRequestScope()?.client?.authenticatedUserProfile?.profileId;
        return "delivered";
      });
      // Start the deadline only after asynchronous fixture setup, as in the donor fix.
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const recoveryStartedAt = Date.now();
      try {
        await resetSubagentRegistryForTests({ persist: false });
        await cleanupSessionStateForTest({ stateDir: fixture.stateDir });
        rotateAgentEventLifecycleGeneration();
        await initSubagentRegistry();
        bindGatewayContextResolver(fixture.gatewayRuntime, requester.context.resolveGatewayContext);
        await activateSubagentRegistry(requester.context.resolveGatewayContext);
        await vi.advanceTimersByTimeAsync(1_000);
        await fixture.settle();

        if (childOwner === "current") {
          // Retain the original positive terminalOwner RED assertion unchanged.
          expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
            terminalOwner: "interrupted-recovery",
            execution: {
              status: "terminal",
              interruptionReason: "gateway-restart",
              outcome: { status: "error", error: expect.stringContaining("Gateway restart") },
            },
          });
        } else {
          // Native refusal preserves the terminal result; completed bookkeeping
          // retires only its child-effects owner, not requester delivery authority.
          expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
            terminalOwner: undefined,
            execution: {
              status: "terminal",
              interruptionReason: "gateway-restart",
              outcome: { status: "error", error: expect.stringContaining("Gateway restart") },
              suppressSessionEffects: true,
            },
            cleanupCompletedAt: expect.any(Number),
          });
        }
        expect(marked).toMatchObject({ abortedLastRun: true });
        expect(claims(marked)).toEqual(savedClaims);
        expect(effectAttempts).toBe(1);
        expect(principalAtHandoff).toBe(profile.id);
        const settledChild = await readChild();
        if (childOwner === "current") {
          expect(effectFailure).toBeUndefined();
          expect(settledChild).toMatchObject({
            sessionId: "accepted-child-session",
            lifecycleRevision: "accepted-child-revision",
            status: "interrupted",
            abortedLastRun: true,
          });
          expect(claims(settledChild)).toEqual(savedClaims);
        } else {
          // Require the actual native row-CAS refusal, not an outer mocked isCurrent.
          expect(effectFailure).toMatchObject({
            message: expect.stringContaining("changed before replacement"),
          });
          expect(replacement).toBeDefined();
          expect(settledChild).toEqual(replacement);
          expect(cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
        }
        expect(runSubagentAnnounceFlow).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            childRunId: runId,
            requesterSessionKey,
            suppressChildSessionEffects: childOwner === "replaced before native effect",
            outcome: expect.objectContaining({
              status: "error",
              error: expect.stringContaining("Gateway restart"),
            }),
          }),
        );
        expect(Date.now() - recoveryStartedAt).toBeLessThan(2_000);
        expect(fixture.dispatchAgent).not.toHaveBeenCalled();
        await testing.sweepOnceForTests();
        await fixture.settle();
        expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
        expect(await readChild()).toEqual(settledChild);
        if (childOwner === "replaced before native effect") {
          expect(cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
        }
        expect(loadSubagentRegistryFromSqlite().get(runId)?.execution.interruptionReason).toBe(
          "gateway-restart",
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
