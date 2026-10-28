import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
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
import { isMissingPathError } from "../../../infra/errors.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  getSharedGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { setUserProfileRole } from "../../../state/user-profile-writes.worker.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { buildAgentRunTerminalOutcome } from "../../agent-run-terminal-outcome.js";
import { createAgentCommandLifecycle } from "../../command/lifecycle.js";
import { createAgentHarnessHostCapabilities } from "../../harness/host-capability.js";
import { createRestartRecoveryOperatorSource } from "../../operator-run-recovery-source.js";
import { createRestartRecoveryRequesterSource } from "../../requester-run-recovery-source.js";
import { readPersistedFileStat } from "../../sessions/tools/file-write-verification.js";
import { createWriteTool } from "../../sessions/tools/write.js";
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
    { verified: true, transcript: true, sourceKind: "operator-independent-drain" },
    { verified: true, transcript: true, sourceKind: "operator-independent-role-revoked-drain" },
    { verified: true, transcript: true, sourceKind: "operator-independent-session-replaced-drain" },
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
      const channelSource = sourceKind.includes("channel");
      const drain = sourceKind.endsWith("-drain");
      const independent = sourceKind.startsWith("operator-independent-");
      const finalEffectChange = sourceKind.includes("role-revoked")
        ? "role"
        : sourceKind.includes("session-replaced")
          ? "session"
          : undefined;
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
        : createOperatorClient({
            profileName: finalEffectChange
              ? `restart-child-owner-${finalEffectChange}`
              : "restart-child-owner",
            scopes,
          });
      const now = Date.now();
      let runId = "warm-restart-child";
      const humanFollowup = sourceKind.startsWith("operator-followup");
      const childSessionKey = `agent:main:${humanFollowup || sourceKind === "channel" || drain || missingSource ? "dashboard" : "subagent"}:warm-restart-child`;
      const childScope = { agentId: "main", sessionKey: childSessionKey };
      const childIdentity = {
        sessionId: "warm-restart-child-session",
        lifecycleRevision: "child-revision",
      };
      const requesterIdentity = {
        sessionId: "warm-restart-parent-session",
        lifecycleRevision: "warm-restart-parent-lifecycle",
      };
      const transcriptScope = { ...childScope, sessionId: childIdentity.sessionId };
      const updateChild = (update: Partial<Parameters<typeof replaceSessionEntry>[1]>) =>
        replaceSessionEntry(childScope, { ...loadSessionEntry(childScope)!, ...update });
      const inPreviousGateway = <T>(work: () => T) =>
        withPluginRuntimeGatewayRequestScope(
          {
            client,
            context: previousContext,
            resolveGatewayContext: previousContext.resolveGatewayContext,
            isWebchatConnect: () => false,
          },
          work,
        );
      const settleRecovery = async () => {
        await fixture.settle();
        await testing.sweepOnceForTests();
        await fixture.settle();
      };
      const preserveForRestart = (
        entry: Parameters<typeof preserveSubagentRunForRestart>[0]["entry"],
      ) =>
        preserveSubagentRunForRestart({
          entry,
          terminal: buildAgentRunTerminalOutcome({ status: "error", stopReason: "restart" }),
          runs: subagentRuns,
        });
      await replaceSessionEntry(
        { agentId: requesterAgentId, sessionKey: requesterSessionKey },
        {
          ...requesterIdentity,
          updatedAt: now,
          status: "done",
          endedAt: now - 500,
        },
      );
      const childEntry: Parameters<typeof replaceSessionEntry>[1] = {
        sessionId: childIdentity.sessionId,
        updatedAt: now,
        abortedLastRun: true,
        createdVia: "spawn",
        spawnedBy: requesterSessionKey,
        parentSessionKey: requesterSessionKey,
        spawnDepth: 1,
      };
      if (!channelSource) {
        childEntry.createdActor = {
          type: "agent",
          id: "main",
          delegatedBy: {
            type: "human",
            source: "profile",
            id: client.authenticatedUserProfile!.profileId,
          },
        };
      }
      if (verified) {
        childEntry.lifecycleRevision = childIdentity.lifecycleRevision;
        childEntry.status = "interrupted";
        childEntry.lastRunId = runId;
      }
      if (channelSource && sourceKind !== "channel" && sourceKind !== "missing-channel") {
        childEntry.restartRecoveryRequesterSource = createRestartRecoveryRequesterSource({
          ...childScope,
          entry: { ...childIdentity, updatedAt: now },
          sourceRunId: sourceKind === "mismatched-channel" ? "another-child-run" : runId,
          requesterOrigin,
        });
      }
      await replaceSessionEntry(childScope, childEntry);
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
        await appendTranscriptMessage(transcriptScope, {
          cwd: fixture.stateDir,
          message: { role: "user", content: "Finish the detached task." },
        });
      }
      const predecessor = makeRunRecord({
        runId,
        childSessionKey,
        childSessionIdentity: {
          sessionId: childIdentity.sessionId,
          ...(verified ? { lifecycleRevision: childIdentity.lifecycleRevision } : {}),
        },
        requesterSessionKey,
        requesterAgentId,
        requesterStorePath: resolveSessionStorePathCore(undefined, { agentId: requesterAgentId }),
        completionTarget: "parent",
        completionRequesterSessionId: requesterIdentity.sessionId,
        completionRequesterLifecycleRevision: requesterIdentity.lifecycleRevision,
        expectsCompletionMessage: !collect,
        execution: {
          status: verified ? "running" : "interrupted",
          startedAt: now - 1_000,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        },
      });
      if (collect) {
        predecessor.collect = true;
        predecessor.groupId = "restart-group";
        predecessor.swarmRequesterSessionKey = requesterSessionKey;
      }
      if (!verified) {
        predecessor.execution.interruptedAt = now;
        predecessor.execution.interruptionReason = "gateway-restart";
        predecessor.requesterSettleWake = {
          status: "pending",
          attemptCount: 0,
          requesterYieldBatch: true,
          rearmGeneration: 1,
          batchRunIds: [runId],
        };
      }
      const methods = createGatewayMethodRegistry(
        createCoreGatewayMethodDescriptors(sessionRecoverHandlers),
      );
      const makeGateway = (isOpen: () => boolean, recovery = false) => {
        const context = Object.assign(createContext(), {
          recoveryRuntime: recovery ? { ...gatewayRuntime } : gatewayRuntime,
          resolveGatewayContext: () => (isOpen() ? context : undefined),
        });
        if (recovery) {
          context.getGatewayMethodRegistry = () => methods;
          context.getSessionEventSubscriberConnIds = () => new Set();
          bindGatewayContextResolver(context.recoveryRuntime, context.resolveGatewayContext);
        }
        return context;
      };
      let previousOpen = true;
      const previousContext = makeGateway(() => previousOpen);
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
          entry: { ...requesterIdentity, updatedAt: now },
          sourceRunId: "warm-restart-parent-turn",
        });
      }
      await initSubagentRegistry();
      await activateSubagentRegistry(() => previousContext).settled;
      bindGatewayContextResolver(predecessor, previousContext.resolveGatewayContext);
      client.internal = { ...client.internal, operatorRunAuthority: source?.authority };
      if ((collect || independent) && source) {
        await inPreviousGateway(() =>
          registerSubagentRun({
            runId,
            childAgentId: "main",
            childSessionKey,
            sessionEntry: predecessor.childSessionIdentity,
            requesterAgentId: "main",
            requesterSessionKey,
            requesterTurnRunId: independent ? undefined : "warm-restart-parent-turn",
            requesterDisplayKey: requesterSessionKey,
            task: predecessor.task,
            cleanup: "keep",
            collect: collect || undefined,
            groupId: collect ? "restart-group" : undefined,
            swarmRequesterSessionKey: collect ? requesterSessionKey : undefined,
            expectsCompletionMessage: !collect,
            completionTarget: "parent",
            completionRequesterSessionId: requesterIdentity.sessionId,
            completionRequesterLifecycleRevision: requesterIdentity.lifecycleRevision,
            gatewayContextResolver: previousContext.resolveGatewayContext,
          }),
        );
        expect(loadSubagentRegistryFromSqlite().get(runId)?.operatorRecoverySource).toMatchObject({
          sessionKey: independent ? childSessionKey : requesterSessionKey,
          sourceRunId: independent ? runId : "warm-restart-parent-turn",
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
        await inPreviousGateway(() =>
          reactivateCompletedSubagentSession({
            sessionKey: childSessionKey,
            runId,
            task: "Verify the retained result.",
            gatewayContextResolver: previousContext.resolveGatewayContext,
          }),
        );
        await updateChild({ status: "interrupted", lastRunId: runId });
        expect(loadSubagentRegistryFromSqlite().get(runId)?.operatorRecoverySource).toMatchObject({
          agentId: "main",
          sessionKey: childSessionKey,
          ...childIdentity,
          sourceRunId: runId,
          snapshot: { scopes },
        });
      }
      const registeredPredecessor = (await getSubagentRunByChildSessionKey(childSessionKey))!;
      bindGatewayContextResolver(registeredPredecessor, previousContext.resolveGatewayContext);
      const continuation = await inPreviousGateway(captureOperatorToolGatewayContinuationContext);
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
        expect(await preserveForRestart(registeredPredecessor)).toMatchObject({ preserved: true });
      }
      expect(subagentRuns.get(runId)?.execution.status).toBe(drain ? "running" : "interrupted");
      previousOpen = false;
      if (source) {
        expect(source.authority.assertCurrent).toThrow();
      }
      rotateAgentEventLifecycleGeneration();
      if (humanFollowup || independent) {
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
      const replacementContext = makeGateway(() => replacementOpen, true);
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
            sessionId: childIdentity.sessionId,
            sessionKey: childSessionKey,
            idempotencyKey: `subagent-restart-recovery:${resumeRunId}`,
            resume: childIdentity,
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
          await updateChild({
            status: undefined,
            abortedLastRun: false,
            lifecycleRunId: request.idempotencyKey,
            lastRunId: request.idempotencyKey,
          });
          request.assertAdmittedSourceCurrent?.();
          return { status: "started", runId: request.idempotencyKey };
        });
      }
      await activateSubagentRegistry(() => replacementContext).settled;
      await settleRecovery();

      let successor = await getSubagentRunByChildSessionKey(childSessionKey);
      if (missingSource) {
        expect(launch).not.toHaveBeenCalled();
        expect(successor).toMatchObject({
          runId,
          execution: { status: "terminal", outcome: { status: "error" } },
        });
        await testing.sweepOnceForTests();
        const messages = await readSessionMessagesAsync(transcriptScope, {
          mode: "recent",
          maxMessages: 20,
          maxBytes: 256 * 1024,
        });
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
          completionRequesterSessionId: requesterIdentity.sessionId,
          completionRequesterLifecycleRevision: requesterIdentity.lifecycleRevision,
          childRunId: runId,
        });
        await testing.sweepOnceForTests();
        await fixture.settle();
        expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
        replacementOpen = false;
        return;
      }
      if (verified) {
        expect(launch).toHaveBeenCalledOnce();
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
          completionRequesterSessionId: requesterIdentity.sessionId,
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
      if (finalEffectChange) {
        // Launch is stubbed above; the restored principal crosses real admission,
        // harness tool binding, and the write tool's final filesystem effect here.
        const authority = expectDefined(restoredAuthority, "restored child operator authority");
        const recovered = expectDefined(successor, "recovered child");
        const inRecoveredChild = <T>(run: () => T) =>
          subagentRuns.runWithCompletionAuthority(recovered, run);
        const admission = prepareAgentRunAdmission({
          cfg: replacementContext.getRuntimeConfig(),
          facts: {
            runId: recovered.runId,
            agentId: "main",
            ingress: { kind: "system", boundary: "recovered-child-test", state: "present" },
          },
          operationalRunInstance: createOperationalRunInstanceRef(recovered.runId),
          operatorAuthority: authority,
        });
        const admittedRunContext = await inRecoveredChild(() =>
          admission.admit("plugin-harness", `harness-${recovered.runId}`),
        );
        bindGatewayContextResolver(admittedRunContext, recoveryResolver);
        const host = inRecoveredChild(() =>
          createAgentHarnessHostCapabilities({
            attempt: {
              runId: recovered.runId,
              agentId: "main",
              sessionKey: childSessionKey,
              sessionId: childIdentity.sessionId,
              admittedRunContext,
            },
            pluginId: "codex",
          }),
        );
        const beforeWrite = createDeferredCore();
        const releaseWrite = createDeferredCore();
        let pauseWrite = false;
        let writes = 0;
        let pendingWrite: Promise<unknown> | undefined;
        try {
          const tool = expectDefined(
            host.capabilities.bindToolSurface([
              createWriteTool(fixture.stateDir, {
                operations: {
                  mkdir: async (dir) => {
                    await mkdir(dir, { recursive: true });
                    if (pauseWrite) {
                      beforeWrite.resolve();
                      await releaseWrite.promise;
                    }
                  },
                  readFile,
                  statFile: (file) => readPersistedFileStat(file, isMissingPathError),
                  writeFile: async (file, content) => {
                    writes += 1;
                    await writeFile(file, content, "utf8");
                  },
                },
              }),
            ])[0],
            "restored child write tool",
          );
          const file = `recovered-child-effect-${finalEffectChange}.txt`;
          await inRecoveredChild(() =>
            tool.execute("allowed", { path: file, content: "allowed\n" }),
          );
          expect(await readFile(path.join(fixture.stateDir, file), "utf8")).toBe("allowed\n");
          pauseWrite = true;
          pendingWrite = inRecoveredChild(() =>
            tool.execute("revoked", { path: file, content: "forbidden\n" }),
          );
          void pendingWrite.catch(beforeWrite.reject);
          await beforeWrite.promise;
          if (finalEffectChange === "role") {
            setUserProfileRole(authority.profileId, "revoked-child-role");
          } else {
            await updateChild({ sessionId: "replacement-child-session" });
          }
          releaseWrite.resolve();
          await expect(pendingWrite).rejects.toThrow();
          expect(writes).toBe(1);
          expect(await readFile(path.join(fixture.stateDir, file), "utf8")).toBe("allowed\n");
        } finally {
          releaseWrite.resolve();
          await pendingWrite?.catch(() => undefined);
          host.close();
          admission.close();
          replacementOpen = false;
        }
        return;
      }
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
      if (humanFollowup || independent) {
        resumeRunId = successor!.runId;
        await updateChild({
          status: "interrupted",
          abortedLastRun: true,
          lifecycleRunId: undefined,
          lastRunId: resumeRunId,
        });
        expect(await preserveForRestart(successor!)).toMatchObject({ preserved: true });
        clearAgentRunContext(resumeRunId);
        activeRunIds.delete(resumeRunId);
        replacementOpen = false;
        rotateAgentEventLifecycleGeneration();
        await resetSubagentRegistryForTests({ persist: false });
        await initSubagentRegistry();
        let secondOpen = true;
        const secondContext = makeGateway(() => secondOpen, true);
        recoveryResolver = secondContext.resolveGatewayContext;
        closeSecondGateway = () => {
          secondOpen = false;
        };
        await activateSubagentRegistry(recoveryResolver).settled;
        await settleRecovery();
        successor = await getSubagentRunByChildSessionKey(childSessionKey);
        expect(launch).toHaveBeenCalledTimes(2);
        expect(successor).toMatchObject({
          runId: `subagent-restart-recovery:${resumeRunId}`,
          taskRunId: runId,
          task: humanFollowup ? "Verify the retained result." : predecessor.task,
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
