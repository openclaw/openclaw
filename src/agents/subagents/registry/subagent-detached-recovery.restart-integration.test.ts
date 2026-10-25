import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, onTestFinished, vi } from "vitest";
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
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../../../gateway/methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "../../../gateway/operator-run-authority.js";
import { launchSessionRecoveryContinuation } from "../../../gateway/server-methods/session-recovery-continuation.js";
import { sessionRecoverHandlers } from "../../../gateway/server-methods/sessions-recover.js";
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
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../../infra/agent-run-registry.js";
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
import { subagentRegistryLog } from "./subagent-registry-lifecycle-log.js";
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

// Replace provider execution with native registry admission; keep recovery policy real.
vi.mock(
  "../../../gateway/server-methods/session-recovery-continuation.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../gateway/server-methods/session-recovery-continuation.js")
    >()),
    launchSessionRecoveryContinuation:
      vi.fn<
        typeof import("../../../gateway/server-methods/session-recovery-continuation.js").launchSessionRecoveryContinuation
      >(),
  }),
);

describe("detached subagent restart recovery", () => {
  const fixture = useSubagentRestartRecoveryFixture({ reuseDatabaseWorkers: true });
  const { dispatchAgent, gatewayRuntime } = fixture;
  it.each([
    { verified: false, transcript: true, sourceKind: "operator" },
    { verified: true, transcript: true, sourceKind: "operator" },
    { verified: true, transcript: true, sourceKind: "operator-drain" },
    { verified: true, transcript: true, sourceKind: "operator-followup" },
    { verified: true, transcript: true, sourceKind: "operator-followup-mismatched" },
    { verified: true, transcript: false, sourceKind: "operator" },
    { verified: true, transcript: true, sourceKind: "session-operator" },
    { verified: true, transcript: true, sourceKind: "channel" },
    { verified: true, transcript: true, sourceKind: "channel-cross-agent-drain" },
    { verified: true, transcript: true, sourceKind: "channel-reset" },
    { verified: true, transcript: true, sourceKind: "channel-collector" },
    { verified: true, transcript: true, sourceKind: "operator-collector" },
    { verified: true, transcript: true, sourceKind: "missing-channel" },
    { verified: true, transcript: true, sourceKind: "mismatched-channel" },
  ])(
    "restores detached child restart custody (verified: $verified, transcript: $transcript, source: $sourceKind)",
    async ({ verified, transcript, sourceKind }) => {
      const launch = vi.mocked(launchSessionRecoveryContinuation);
      launch.mockReset();
      const activeRunIds = new Set<string>();
      onTestFinished(() => {
        for (const id of activeRunIds) {
          clearAgentRunContext(id);
        }
      });
      const recoveryWarnings = vi.spyOn(subagentRegistryLog, "warn");
      const channelSource = sourceKind.includes("channel");
      const drain = sourceKind.endsWith("-drain");
      const requesterAgentId = sourceKind === "channel-cross-agent-drain" ? "requester" : "main";
      const requesterSessionKey = channelSource
        ? `agent:${requesterAgentId}:discord:channel:original-requester`
        : "agent:main:main";
      const collect = sourceKind.endsWith("-collector");
      const mismatchedFollowup = sourceKind === "operator-followup-mismatched";
      const missingSource =
        sourceKind === "missing-channel" ||
        sourceKind === "mismatched-channel" ||
        mismatchedFollowup;
      const scopes = [
        sourceKind === "session-operator" ? "operator.sessions.write" : "operator.write",
      ];
      const requesterOrigin = {
        sessionKey: requesterSessionKey,
        messageProvider: "discord",
        senderId: "original-channel-requester",
      };
      await resetSubagentRegistryForTests({ persist: false });
      const events = await vi.importActual<typeof import("../../../infra/agent-events.js")>(
        "../../../infra/agent-events.js",
      );
      vi.mocked(onAgentEvent).mockImplementation(events.onAgentEvent);
      const client = channelSource
        ? createSyntheticPluginRuntimeClient({ operatorRoleActor: { kind: "system" }, scopes })
        : createOperatorClient({ profileName: "restart-child-owner", scopes });
      const now = Date.now();
      let runId = "warm-restart-child";
      const humanFollowup = sourceKind.startsWith("operator-followup");
      const childSessionKey = `agent:main:${humanFollowup || sourceKind === "channel" || drain || missingSource ? "dashboard" : "subagent"}:warm-restart-child`;
      const requesterSessionId = "warm-restart-parent-session";
      const requesterLifecycleRevision = "warm-restart-parent-lifecycle";
      await replaceSessionEntry(
        { agentId: requesterAgentId, sessionKey: requesterSessionKey },
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
          ...(!channelSource
            ? {
                createdActor: {
                  type: "agent" as const,
                  id: "main",
                  delegatedBy: {
                    type: "human" as const,
                    source: "profile" as const,
                    id: client.authenticatedUserProfile!.profileId,
                  },
                },
              }
            : {}),
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
        requesterAgentId,
        requesterStorePath: resolveSessionStorePathCore(undefined, { agentId: requesterAgentId }),
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
      await activateSubagentRegistry(() => previousContext).settled;
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
      if (humanFollowup) {
        const completed = subagentRuns.get(runId)!;
        await addSubagentRunForTests({
          ...completed,
          execution: {
            ...completed.execution,
            status: "terminal",
            endedAt: now,
            outcome: { status: "ok" },
          },
          delivery: { status: "delivered", deliveredAt: now },
          cleanupHandled: true,
          cleanupCompletedAt: now,
        });
        runId = "human-child-followup";
        await withPluginRuntimeGatewayRequestScope(
          {
            client,
            context: previousContext,
            resolveGatewayContext: previousContext.resolveGatewayContext,
            isWebchatConnect: () => false,
          },
          () =>
            reactivateCompletedSubagentSession({
              sessionKey: childSessionKey,
              runId,
              task: "Verify the retained result.",
              gatewayContextResolver: previousContext.resolveGatewayContext,
            }),
        );
        await replaceSessionEntry(
          { agentId: "main", sessionKey: childSessionKey },
          {
            ...loadSessionEntry({ agentId: "main", sessionKey: childSessionKey })!,
            status: "interrupted",
            lastRunId: runId,
          },
        );
        expect(loadSubagentRegistryFromSqlite().get(runId)?.operatorRecoverySource).toMatchObject({
          agentId: "main",
          sessionKey: childSessionKey,
          sessionId: "warm-restart-child-session",
          lifecycleRevision: "child-revision",
          sourceRunId: runId,
          snapshot: { scopes },
        });
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
      if (verified && !drain) {
        expect(
          await preserveSubagentRunForRestart({
            entry: registeredPredecessor,
            terminal: buildAgentRunTerminalOutcome({ status: "error", stopReason: "restart" }),
            runs: subagentRuns,
          }),
        ).toMatchObject({ preserved: true });
      }
      expect(subagentRuns.get(runId)?.execution.status).toBe(drain ? "running" : "interrupted");
      previousOpen = false;
      if (source) {
        expect(source.authority.assertCurrent).toThrow();
      }
      rotateAgentEventLifecycleGeneration();
      if (humanFollowup) {
        if (mismatchedFollowup) {
          const interrupted = subagentRuns.get(runId)!;
          await addSubagentRunForTests({
            ...interrupted,
            operatorRecoverySource: {
              ...interrupted.operatorRecoverySource!,
              sourceRunId: "another-human-followup",
            },
          });
        }
        // Lose all in-process custody, just as a process restart does.
        await resetSubagentRegistryForTests({ persist: false });
        await initSubagentRegistry();
      }

      let replacementOpen = true;
      const replacementRuntime = { ...gatewayRuntime };
      const methods = createGatewayMethodRegistry(
        createCoreGatewayMethodDescriptors(sessionRecoverHandlers),
      );
      const replacementContext = Object.assign(createContext(), {
        recoveryRuntime: replacementRuntime,
        getGatewayMethodRegistry: () => methods,
        getSessionEventSubscriberConnIds: () => [],
        resolveGatewayContext: () => (replacementOpen ? replacementContext : undefined),
      });
      bindGatewayContextResolver(replacementRuntime, replacementContext.resolveGatewayContext);
      let resumeRunId = runId;
      let recoveryResolver = replacementContext.resolveGatewayContext;
      let closeSecondGateway: (() => void) | undefined;
      if (verified && !missingSource) {
        launch.mockImplementation(async (request) => {
          request.commitGuard?.();
          expect(request.client?.internal?.operatorRunAuthority?.profileId).toBe(
            source?.authority.profileId,
          );
          expect(request.client?.connect.scopes).toEqual(scopes);
          if (channelSource) {
            expect(request.client?.internal?.agentToolCaller).toMatchObject({
              agentId: "main",
              sessionKey: childSessionKey,
              requesterOrigin,
            });
            expect(() =>
              request.client?.internal?.agentToolCaller?.assertCurrent?.(),
            ).not.toThrow();
          }
          expect(request).toMatchObject({
            sessionId: "warm-restart-child-session",
            sessionKey: childSessionKey,
            idempotencyKey: `subagent-restart-recovery:${resumeRunId}`,
            resume: {
              sessionId: "warm-restart-child-session",
              lifecycleRevision: "child-revision",
            },
          });
          expect(
            await reactivateCompletedSubagentSession({
              sessionKey: request.sessionKey,
              runId: request.idempotencyKey,
              gatewayContextResolver: recoveryResolver,
              assertCurrent: request.assertAdmittedSourceCurrent,
            }),
          ).toBe(true);
          // Keep the fixed model I/O active until the test emits its terminal event.
          registerAgentRunContext(request.idempotencyKey, {
            sessionKey: childSessionKey,
            sessionId: request.sessionId,
          });
          activeRunIds.add(request.idempotencyKey);
          // Native admission clears the persisted terminal status before model execution.
          await replaceSessionEntry(
            { agentId: "main", sessionKey: childSessionKey },
            {
              ...loadSessionEntry({ agentId: "main", sessionKey: childSessionKey })!,
              status: undefined,
              abortedLastRun: false,
              lifecycleRunId: request.idempotencyKey,
              lastRunId: request.idempotencyKey,
            },
          );
          request.assertAdmittedSourceCurrent?.();
          return { status: "started", runId: request.idempotencyKey };
        });
      }
      await activateSubagentRegistry(() => replacementContext).settled;
      await fixture.settle();
      await testing.sweepOnceForTests();
      await fixture.settle();

      let successor = await getSubagentRunByChildSessionKey(childSessionKey);
      if (missingSource) {
        expect(launch).not.toHaveBeenCalled();
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
        expect(launch).not.toHaveBeenCalled();
        expect(successor).toMatchObject({
          runId,
          execution: {
            status: "terminal",
            interruptionReason: "gateway-restart",
            outcome: {
              status: "error",
              error: expect.stringContaining("Child transcript is missing"),
            },
          },
        });
        expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
        expect(vi.mocked(runSubagentAnnounceFlow).mock.calls[0]![0]).toMatchObject({
          requesterSessionKey,
          completionRequesterSessionId: requesterSessionId,
          completionRequesterLifecycleRevision: requesterLifecycleRevision,
          childRunId: runId,
          outcome: {
            status: "error",
            error: expect.stringContaining("Child transcript is missing"),
          },
        });
        await testing.sweepOnceForTests();
        await fixture.settle();
        expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
        replacementOpen = false;
        return;
      }
      if (verified) {
        expect(
          launch,
          JSON.stringify(recoveryWarnings.mock.calls, (_key, value) =>
            value instanceof Error ? value.message : value,
          ),
        ).toHaveBeenCalledOnce();
        const assertAdmittedSourceCurrent = launch.mock.calls[0]![0].assertAdmittedSourceCurrent;
        expect(assertAdmittedSourceCurrent).toBeTypeOf("function");
        // The request hold ends after dispatch; verify retained registry custody below.
        expect(dispatchAgent).not.toHaveBeenCalled();
        expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
        expect(successor).toMatchObject({
          runId: `subagent-restart-recovery:${runId}`,
          taskRunId: runId,
          task: humanFollowup ? "Verify the retained result." : predecessor.task,
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
        expect(launch).not.toHaveBeenCalled();
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
      if (humanFollowup) {
        resumeRunId = successor!.runId;
        await replaceSessionEntry(
          { agentId: "main", sessionKey: childSessionKey },
          {
            ...loadSessionEntry({ agentId: "main", sessionKey: childSessionKey })!,
            status: "interrupted",
            abortedLastRun: true,
            lifecycleRunId: undefined,
            lastRunId: resumeRunId,
          },
        );
        expect(
          await preserveSubagentRunForRestart({
            entry: successor!,
            terminal: buildAgentRunTerminalOutcome({ status: "error", stopReason: "restart" }),
            runs: subagentRuns,
          }),
        ).toMatchObject({ preserved: true });
        clearAgentRunContext(resumeRunId);
        activeRunIds.delete(resumeRunId);
        replacementOpen = false;
        rotateAgentEventLifecycleGeneration();
        await resetSubagentRegistryForTests({ persist: false });
        await initSubagentRegistry();
        let secondOpen = true;
        const secondRuntime = { ...gatewayRuntime };
        const secondContext = Object.assign(createContext(), {
          recoveryRuntime: secondRuntime,
          getGatewayMethodRegistry: () => methods,
          getSessionEventSubscriberConnIds: () => [],
          resolveGatewayContext: () => (secondOpen ? secondContext : undefined),
        });
        recoveryResolver = secondContext.resolveGatewayContext;
        closeSecondGateway = () => {
          secondOpen = false;
        };
        bindGatewayContextResolver(secondRuntime, recoveryResolver);
        await activateSubagentRegistry(recoveryResolver).settled;
        await fixture.settle();
        await testing.sweepOnceForTests();
        await fixture.settle();
        successor = await getSubagentRunByChildSessionKey(childSessionKey);
        expect(launch).toHaveBeenCalledTimes(2);
        expect(successor).toMatchObject({
          runId: `subagent-restart-recovery:${resumeRunId}`,
          taskRunId: runId,
          task: "Verify the retained result.",
          operatorRecoverySource: { sourceRunId: runId, sessionKey: childSessionKey },
          execution: { status: "running" },
        });
        expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
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
        clearAgentRunContext(successor!.runId);
        activeRunIds.delete(successor!.runId);
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
          await testing.sweepOnceForTests();
          await fixture.settle();
          expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
        }
      }
      replacementOpen = false;
      closeSecondGateway?.();
      expect(resolveWakeGateway?.()).toBeUndefined();
      expect(getGatewayContextResolver(predecessor)?.()).toBeUndefined();
    },
  );
});
