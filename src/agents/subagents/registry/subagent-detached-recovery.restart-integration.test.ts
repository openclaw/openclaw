import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  makeRestartRecoveryRun as makeRunRecord,
  useSubagentRestartRecoveryFixture,
} from "./subagent-restart-recovery.test-support.js";
import { createRecoveryControllerFixture } from "../../../auto-reply/reply/recovery-controller.fixture.test-support.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  loadSessionEntry,
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { captureGatewayAuthPolicy } from "../../../gateway/auth-policy.js";
import { isInProcessSessionRun } from "../../../gateway/in-process-session-run.js";
import { captureGatewayOperatorRunAuthority } from "../../../gateway/operator-run-authority.js";
import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { reactivateCompletedSubagentSession } from "../../../gateway/session-subagent-reactivation.js";
import { readSessionMessagesAsync } from "../../../gateway/session-transcript-readers.js";
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
import { createRestartRecoveryRequesterSource } from "../../requester-run-recovery-source.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { preserveSubagentRunForRestart } from "./subagent-registry-run-pause.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import {
  addSubagentRunForTests,
  activateSubagentRegistry,
  getSubagentRunByChildSessionKey,
  initSubagentRegistry,
  registerSubagentRun,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";

describe("detached subagent restart recovery", () => {
  const fixture = useSubagentRestartRecoveryFixture({ reuseDatabaseWorkers: true });
  const { dispatchAgent, gatewayRuntime } = fixture;
  it.each([
    { verified: false, transcript: true, sourceKind: "operator" },
    { verified: true, transcript: true, sourceKind: "operator" },
    { verified: true, transcript: false, sourceKind: "operator" },
    { verified: true, transcript: true, sourceKind: "session-operator" },
    { verified: true, transcript: true, sourceKind: "channel" },
    { verified: true, transcript: true, sourceKind: "channel-reset" },
    { verified: true, transcript: true, sourceKind: "channel-collector" },
    { verified: true, transcript: true, sourceKind: "operator-collector" },
    { verified: true, transcript: true, sourceKind: "missing-channel" },
    { verified: true, transcript: true, sourceKind: "mismatched-channel" },
  ])(
    "restores detached child restart custody (verified: $verified, transcript: $transcript, source: $sourceKind)",
    async ({ verified, transcript, sourceKind }) => {
      const channelSource = sourceKind.includes("channel");
      const collect = sourceKind.endsWith("-collector");
      const missingSource = sourceKind === "missing-channel" || sourceKind === "mismatched-channel";
      const scopes = [
        sourceKind === "session-operator" ? "operator.sessions.write" : "operator.write",
      ];
      const requesterOrigin = {
        sessionKey: "agent:main:discord:channel:original-requester",
        messageProvider: "discord",
        senderId: "original-channel-requester",
      };
      await resetSubagentRegistryForTests({ persist: false });
      const events = await vi.importActual<typeof import("../../../infra/agent-events.js")>(
        "../../../infra/agent-events.js",
      );
      vi.mocked(onAgentEvent).mockImplementation(events.onAgentEvent);
      const now = Date.now();
      const runId = "warm-restart-child";
      const childSessionKey = `agent:main:${sourceKind === "channel" || missingSource ? "dashboard" : "subagent"}:warm-restart-child`;
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
          createdVia: "spawn",
          spawnedBy: requesterSessionKey,
          parentSessionKey: requesterSessionKey,
          spawnDepth: 1,
          ...(verified
            ? {
                lifecycleRevision: "child-revision",
                status: "interrupted" as const,
                lastRunId: runId,
              }
            : {}),
          ...(channelSource && sourceKind !== "channel" && sourceKind !== "missing-channel"
            ? {
                restartRecoveryRequesterSource: createRestartRecoveryRequesterSource({
                  agentId: "main",
                  sessionKey: childSessionKey,
                  entry: {
                    sessionId: "warm-restart-child-session",
                    lifecycleRevision: "child-revision",
                    updatedAt: now,
                  },
                  sourceRunId: sourceKind === "mismatched-channel" ? "another-child-run" : runId,
                  requesterOrigin,
                }),
              }
            : {}),
        },
      );
      if (sourceKind === "channel") {
        const scope = {
          agentId: "main",
          sessionKey: childSessionKey,
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        };
        await using claim = await createRecoveryControllerFixture(
          scope,
          {
            ...loadSessionEntry(scope)!,
            status: undefined,
            abortedLastRun: false,
            lastRunId: undefined,
          },
          {
            admissionRunId: runId,
            sourceTurnId: runId,
            requesterOrigin,
            inputProvenance: {
              kind: "inter_session",
              sourceSessionKey: requesterSessionKey,
              sourceTool: "sessions_spawn",
            },
          },
        );
        await claim.controller().admitUserTurn();
        await replaceSessionEntry(scope, {
          ...claim.entry,
          status: "interrupted",
          abortedLastRun: true,
          lifecycleRunId: undefined,
          lastRunId: runId,
        });
      }
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
        expectsCompletionMessage: !collect,
        ...(collect
          ? {
              collect: true,
              groupId: "restart-group",
              swarmRequesterSessionKey: requesterSessionKey,
            }
          : {}),
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
      const client = channelSource
        ? createSyntheticPluginRuntimeClient({ operatorRoleActor: { kind: "system" }, scopes })
        : createOperatorClient({ profileName: "restart-child-owner", scopes });
      if (!channelSource) {
        client.internal = { authenticatedOperator: true };
        client.authPolicy = captureGatewayAuthPolicy(previousContext.getRuntimeConfig(), {
          role: "operator",
          authMethod: "token",
        });
      }
      const source = channelSource
        ? undefined
        : (await captureGatewayOperatorRunAuthority({
            client,
            context: previousContext,
            sourceAuthority: null,
          }))!;
      if (source && !collect) {
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
      }
      await initSubagentRegistry();
      await activateSubagentRegistry(() => previousContext);
      bindGatewayContextResolver(predecessor, previousContext.resolveGatewayContext);
      client.internal = { ...client.internal, operatorRunAuthority: source?.authority };
      if (collect && source) {
        await withPluginRuntimeGatewayRequestScope(
          {
            client,
            context: previousContext,
            resolveGatewayContext: previousContext.resolveGatewayContext,
            isWebchatConnect: () => false,
          },
          () =>
            registerSubagentRun({
              runId,
              childAgentId: "main",
              childSessionKey,
              sessionEntry: predecessor.childSessionIdentity,
              requesterAgentId: "main",
              requesterSessionKey,
              requesterTurnRunId: "warm-restart-parent-turn",
              requesterDisplayKey: requesterSessionKey,
              task: predecessor.task,
              cleanup: "keep",
              collect: true,
              groupId: "restart-group",
              swarmRequesterSessionKey: requesterSessionKey,
              expectsCompletionMessage: false,
              completionTarget: "parent",
              completionRequesterSessionId: requesterSessionId,
              completionRequesterLifecycleRevision: requesterLifecycleRevision,
              gatewayContextResolver: previousContext.resolveGatewayContext,
            }),
        );
        expect(loadSubagentRegistryFromSqlite().get(runId)?.operatorRecoverySource).toMatchObject({
          sessionKey: requesterSessionKey,
          sourceRunId: "warm-restart-parent-turn",
          snapshot: { scopes },
        });
      } else {
        await addSubagentRunForTests(predecessor);
      }
      const registeredPredecessor = (await getSubagentRunByChildSessionKey(childSessionKey))!;
      bindGatewayContextResolver(registeredPredecessor, previousContext.resolveGatewayContext);
      const continuation = await withPluginRuntimeGatewayRequestScope(
        {
          client,
          context: previousContext,
          resolveGatewayContext: previousContext.resolveGatewayContext,
          isWebchatConnect: () => false,
        },
        () => captureOperatorToolGatewayContinuationContext(),
      );
      expect(continuation?.operatorAuthority).toBe(source?.authority);
      if (!collect) {
        subagentRuns.bindCompletionAuthority(registeredPredecessor, continuation!);
      } else {
        continuation?.release();
      }
      source?.release();
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
      if (source) {
        expect(source.authority.assertCurrent).toThrow();
      }
      rotateAgentEventLifecycleGeneration();

      let replacementOpen = true;
      const replacementRuntime = { ...gatewayRuntime };
      const replacementContext = Object.assign(createContext(), {
        recoveryRuntime: replacementRuntime,
        resolveGatewayContext: () => (replacementOpen ? replacementContext : undefined),
      });
      bindGatewayContextResolver(replacementRuntime, replacementContext.resolveGatewayContext);
      if (verified && !missingSource) {
        dispatchAgent.mockImplementationOnce(async (request, _timeout, options) => {
          await options.prepareDispatchCurrent();
          expect(options.operatorRunAuthority?.profileId).toBe(source?.authority.profileId);
          expect(isInProcessSessionRun("agent", request)).toBe(true);
          if (channelSource) {
            expect(options.agentToolCaller).toMatchObject({
              agentId: "main",
              sessionKey: childSessionKey,
              requesterOrigin,
            });
            expect(options.scopes).toEqual(scopes);
          }
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
      if (missingSource) {
        expect(dispatchAgent).not.toHaveBeenCalled();
        expect(successor).toMatchObject({
          runId,
          execution: { status: "terminal", outcome: { status: "error" } },
        });
        await testing.sweepOnceForTests();
        const messages = await readSessionMessagesAsync(
          { agentId: "main", sessionKey: childSessionKey, sessionId: "warm-restart-child-session" },
          { mode: "recent", maxMessages: 20, maxBytes: 256 * 1024 },
        );
        expect(
          messages.filter((message) => isRecord(message) && message.role === "assistant"),
        ).toEqual([
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("Send a new authenticated message to continue"),
              }),
            ]),
          }),
        ]);
        replacementOpen = false;
        return;
      }
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
          ...(collect ? { collect: true, groupId: "restart-group" } : {}),
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
      if (!collect) {
        expect(() =>
          subagentRuns.runWithCompletionAuthority(registeredPredecessor, () => {}),
        ).toThrow();
      }
      const restoredAuthority = subagentRuns.runWithCompletionAuthority(
        successor!,
        () => getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
      );
      expect(restoredAuthority?.profileId).toBe(source?.authority.profileId);
      expect(restoredAuthority?.scopes).toEqual(source ? scopes : undefined);
      expect(() => restoredAuthority?.assertCurrent()).not.toThrow();
      const resolveWakeGateway = getSharedGatewayContextResolver([successor!]);
      expect(resolveWakeGateway?.()).toBe(replacementContext);
      if (sourceKind === "channel-reset") {
        const caller = subagentRuns.runWithCompletionAuthority(
          successor!,
          () => getPluginRuntimeGatewayRequestScope()?.client?.internal?.agentToolCaller,
        );
        expect(caller?.assertCurrent).toBeTypeOf("function");
        await replaceSessionEntry(
          { agentId: "main", sessionKey: requesterSessionKey },
          {
            sessionId: "replacement-parent",
            lifecycleRevision: "replacement-parent-lifecycle",
            updatedAt: Date.now(),
          },
        );
        expect(caller?.assertCurrent).toThrow();
        expect(() => subagentRuns.runWithCompletionAuthority(successor!, () => {})).toThrow();
        expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
        replacementOpen = false;
        return;
      }
      if (verified) {
        if (channelSource && !collect) {
          vi.mocked(runSubagentAnnounceFlow).mockImplementation(async () => {
            const completionClient = getPluginRuntimeGatewayRequestScope()?.client;
            expect(completionClient?.internal?.operatorRunAuthority).toBeUndefined();
            expect(completionClient?.internal?.agentToolCaller?.requesterOrigin).toEqual(
              requesterOrigin,
            );
            expect(() =>
              completionClient?.internal?.agentToolCaller?.assertCurrent?.(),
            ).not.toThrow();
            return "delivered";
          });
        }
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
        if (collect) {
          expect(
            loadSubagentRegistryFromSqlite().get(successor!.runId)?.collectorCompletion,
          ).toMatchObject({ status: "done" });
          expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
        } else {
          expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
            expect.objectContaining({ requesterSessionKey }),
          );
        }
      }
      replacementOpen = false;
      expect(resolveWakeGateway?.()).toBeUndefined();
      expect(getGatewayContextResolver(predecessor)?.()).toBeUndefined();
    },
  );
});
