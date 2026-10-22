import { describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  makeRestartRecoveryRun as makeRunRecord,
  useSubagentRestartRecoveryFixture,
} from "./subagent-restart-recovery.test-support.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { captureGatewayAuthPolicy } from "../../../gateway/auth-policy.js";
import { captureGatewayOperatorRunAuthority } from "../../../gateway/operator-run-authority.js";
import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { reactivateCompletedSubagentSession } from "../../../gateway/session-subagent-reactivation.js";
import {
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  getSharedGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { buildAgentRunTerminalOutcome } from "../../agent-run-terminal-outcome.js";
import { createAgentCommandLifecycle } from "../../command/lifecycle.js";
import { createRestartRecoveryOperatorSource } from "../../operator-run-recovery-source.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { preserveSubagentRunForRestart } from "./subagent-registry-run-pause.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import {
  addSubagentRunForTests,
  activateSubagentRegistry,
  getSubagentRunByChildSessionKey,
  initSubagentRegistry,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";

describe("detached subagent restart recovery", () => {
  const fixture = useSubagentRestartRecoveryFixture({ reuseDatabaseWorkers: true });
  const { dispatchAgent, gatewayRuntime } = fixture;
  it.each([
    { verified: false, transcript: true },
    { verified: true, transcript: true },
    { verified: true, transcript: false },
  ])(
    "restores detached child restart custody (verified: $verified, transcript: $transcript)",
    async ({ verified, transcript }) => {
      await resetSubagentRegistryForTests({ persist: false });
      const events = await vi.importActual<typeof import("../../../infra/agent-events.js")>(
        "../../../infra/agent-events.js",
      );
      vi.mocked(onAgentEvent).mockImplementation(events.onAgentEvent);
      const now = Date.now();
      const runId = "warm-restart-child";
      const childSessionKey = "agent:main:subagent:warm-restart-child";
      const requesterSessionKey = "agent:main:main";
      const requesterSessionId = "warm-restart-parent-session";
      const requesterLifecycleRevision = "warm-restart-parent-lifecycle";
      await replaceSessionEntry(
        { agentId: "main", sessionKey: requesterSessionKey },
        {
          sessionId: requesterSessionId,
          lifecycleRevision: requesterLifecycleRevision,
          updatedAt: now,
          status: "done",
          endedAt: now - 500,
        },
      );
      await replaceSessionEntry(
        { agentId: "main", sessionKey: childSessionKey },
        {
          sessionId: "warm-restart-child-session",
          updatedAt: now,
          abortedLastRun: true,
          ...(verified
            ? {
                lifecycleRevision: "child-revision",
                status: "interrupted" as const,
                lastRunId: runId,
              }
            : {}),
        },
      );
      if (transcript) {
        await appendTranscriptMessage(
          { agentId: "main", sessionKey: childSessionKey, sessionId: "warm-restart-child-session" },
          {
            cwd: fixture.stateDir,
            message: { role: "user", content: "Finish the detached task." },
          },
        );
      }
      const predecessor = makeRunRecord({
        runId,
        childSessionKey,
        childSessionIdentity: {
          sessionId: "warm-restart-child-session",
          ...(verified ? { lifecycleRevision: "child-revision" } : {}),
        },
        requesterSessionKey,
        requesterAgentId: "main",
        completionTarget: "parent",
        completionRequesterSessionId: requesterSessionId,
        completionRequesterLifecycleRevision: requesterLifecycleRevision,
        expectsCompletionMessage: true,
        execution: {
          status: verified ? "running" : "interrupted",
          startedAt: now - 1_000,
          ...(verified
            ? {}
            : { interruptedAt: now, interruptionReason: "gateway-restart" as const }),
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        },
        requesterSettleWake: verified
          ? undefined
          : {
              status: "pending",
              attemptCount: 0,
              requesterYieldBatch: true,
              rearmGeneration: 1,
              batchRunIds: [runId],
            },
      });
      let previousOpen = true;
      const previousContext = Object.assign(createContext(), {
        recoveryRuntime: gatewayRuntime,
        resolveGatewayContext: () => (previousOpen ? previousContext : undefined),
      });
      const client = createOperatorClient({
        profileName: "restart-child-owner",
        scopes: ["operator.write"],
      });
      client.internal = { authenticatedOperator: true };
      client.authPolicy = captureGatewayAuthPolicy(previousContext.getRuntimeConfig(), {
        role: "operator",
        authMethod: "token",
      });
      const source = (await captureGatewayOperatorRunAuthority({
        client,
        context: previousContext,
        sourceAuthority: null,
      }))!;
      expect(source.authority.recoverySnapshot).toBeDefined();
      predecessor.operatorRecoverySource = createRestartRecoveryOperatorSource({
        authority: source.authority,
        agentId: "main",
        sessionKey: requesterSessionKey,
        entry: {
          sessionId: requesterSessionId,
          lifecycleRevision: requesterLifecycleRevision,
          updatedAt: now,
        },
        sourceRunId: "warm-restart-parent-turn",
      });
      await initSubagentRegistry();
      await activateSubagentRegistry(() => previousContext);
      bindGatewayContextResolver(predecessor, previousContext.resolveGatewayContext);
      await addSubagentRunForTests(predecessor);
      const registeredPredecessor = (await getSubagentRunByChildSessionKey(childSessionKey))!;
      bindGatewayContextResolver(registeredPredecessor, previousContext.resolveGatewayContext);
      client.internal = { ...client.internal, operatorRunAuthority: source.authority };
      const continuation = await withPluginRuntimeGatewayRequestScope(
        {
          client,
          context: previousContext,
          resolveGatewayContext: previousContext.resolveGatewayContext,
          isWebchatConnect: () => false,
        },
        () => captureOperatorToolGatewayContinuationContext(),
      );
      expect(continuation?.operatorAuthority).toBe(source.authority);
      subagentRuns.bindCompletionAuthority(registeredPredecessor, continuation!);
      source.release();
      expect(() =>
        subagentRuns.runWithCompletionAuthority(registeredPredecessor, () => {}),
      ).not.toThrow();
      if (verified) {
        expect(
          await preserveSubagentRunForRestart({
            entry: registeredPredecessor,
            terminal: buildAgentRunTerminalOutcome({ status: "error", stopReason: "restart" }),
            runs: subagentRuns,
          }),
        ).toMatchObject({ preserved: true });
      }
      expect(subagentRuns.get(runId)?.execution.status).toBe("interrupted");
      previousOpen = false;
      expect(source.authority.assertCurrent).toThrow(
        "operator source authority is no longer active",
      );
      rotateAgentEventLifecycleGeneration();

      let replacementOpen = true;
      const replacementRuntime = { ...gatewayRuntime };
      const replacementContext = Object.assign(createContext(), {
        recoveryRuntime: replacementRuntime,
        resolveGatewayContext: () => (replacementOpen ? replacementContext : undefined),
      });
      bindGatewayContextResolver(replacementRuntime, replacementContext.resolveGatewayContext);
      if (verified) {
        dispatchAgent.mockImplementationOnce(async (request, _timeout, options) => {
          await options.prepareDispatchCurrent();
          expect(options.operatorRunAuthority.profileId).toBe(source.authority.profileId);
          expect(request).toMatchObject({
            expectedExistingSessionId: "warm-restart-child-session",
            expectedExistingSessionLifecycleRevision: "child-revision",
          });
          expect(
            await reactivateCompletedSubagentSession({
              sessionKey: request.sessionKey,
              runId: request.idempotencyKey,
              gatewayContextResolver: replacementContext.resolveGatewayContext,
              assertCurrent: options.assertAdmissionCurrent,
            }),
          ).toBe(true);
          options.assertAdmissionCurrent();
          return { status: "accepted", runId: request.idempotencyKey };
        });
      }
      await activateSubagentRegistry(() => replacementContext);
      await fixture.settle();
      await testing.sweepOnceForTests();

      const successor = await getSubagentRunByChildSessionKey(childSessionKey);
      if (!transcript) {
        expect(dispatchAgent).not.toHaveBeenCalled();
        expect(successor).toMatchObject({
          runId,
          execution: { status: "interrupted", interruptionReason: "gateway-restart" },
        });
        expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
        replacementOpen = false;
        return;
      }
      if (verified) {
        expect(dispatchAgent).toHaveBeenCalledOnce();
        expect(successor).toMatchObject({
          runId: `subagent-restart:${runId}`,
          taskRunId: runId,
          task: predecessor.task,
          requesterSessionKey,
          completionRequesterSessionId: requesterSessionId,
          execution: { status: "running" },
        });
        expect(subagentRuns.has(runId)).toBe(false);
        expect(loadSubagentRegistryFromSqlite().get(successor!.runId)?.execution.status).toBe(
          "running",
        );
      } else {
        expect(dispatchAgent).not.toHaveBeenCalled();
        expect(successor).toMatchObject({
          runId: predecessor.runId,
          childSessionKey: predecessor.childSessionKey,
          createdAt: predecessor.createdAt,
          execution: { status: "terminal", outcome: { status: "error" } },
        });
        expect(successor?.generation).toBe(predecessor.generation);
      }
      expect(() =>
        subagentRuns.runWithCompletionAuthority(registeredPredecessor, () => {}),
      ).toThrow();
      const restoredAuthority = subagentRuns.runWithCompletionAuthority(
        successor!,
        () => getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
      );
      expect(restoredAuthority?.profileId).toBe(source.authority.profileId);
      expect(restoredAuthority?.scopes).toEqual(["operator.write"]);
      expect(() => restoredAuthority?.assertCurrent()).not.toThrow();
      const resolveWakeGateway = getSharedGatewayContextResolver([successor!]);
      expect(resolveWakeGateway?.()).toBe(replacementContext);
      if (verified) {
        createAgentCommandLifecycle({
          runId: successor!.runId,
          startedAt: now,
          lifecycleGeneration: getAgentEventLifecycleGeneration,
          state: { lifecycleEnded: false, lifecycleFinishing: false },
        }).emitEnd({
          metadata: {
            terminalReply: { disposition: "visible", text: "Detached task completed." },
          },
          outcome: buildAgentRunTerminalOutcome({
            status: "ok",
            startedAt: now,
            endedAt: Date.now(),
          }),
        });
        await fixture.settle();
        expect(
          loadSubagentRegistryFromSqlite().get(successor!.runId)?.execution.outcome,
        ).toMatchObject({
          status: "ok",
        });
        expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
          expect.objectContaining({ requesterSessionKey }),
        );
      }
      replacementOpen = false;
      expect(resolveWakeGateway?.()).toBeUndefined();
      expect(getGatewayContextResolver(predecessor)?.()).toBeUndefined();
    },
  );
});
