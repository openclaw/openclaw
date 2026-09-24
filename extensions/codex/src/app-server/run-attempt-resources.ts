import {
  embeddedAgentLog,
  formatErrorMessage,
  runAgentCleanupStep,
  type AgentHarnessRuntimeArtifactBinding,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { isIncognitoSessionKey } from "../incognito-session.js";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import { resolveCodexStartupTimeoutMs } from "./attempt-timeouts.js";
import { protectCodexAppServerLiveThread } from "./client-runtime.js";
import { resolveCodexAppServerClientInstanceId, type CodexAppServerClient } from "./client.js";
import { shouldAutoApproveCodexAppServerApprovals } from "./config.js";
import { resolveCodexToolAbortTerminalReason } from "./dynamic-tool-execution.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import { buildCodexHookRequester } from "./hook-requester.js";
import { getCodexInferenceThreadQualification } from "./inference-routing.js";
import {
  buildCodexNativeHookRelayDisabledConfig,
  buildCodexNativeHookRelayConfig,
  CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS,
  createCodexNativeHookRelay,
  emitCodexNativePreToolUseFailureDiagnostic,
  type CodexNativePreToolUseFailure,
  type CodexNativeHookRelay,
} from "./native-hook-relay.js";
import {
  CodexNativeProcessAuthority,
  hasCodexNativeBackgroundProcesses,
} from "./native-process-authority.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import type { CodexNativeSubagentSubmissionStore } from "./native-subagent-submission.js";
import type { CodexSandboxPolicy, CodexTurnEnvironmentParams } from "./protocol.js";
import { emitCodexAppServerEvent } from "./run-attempt-lifecycle.js";
import type { CodexAttemptPrompt } from "./run-attempt-prompt.js";
import {
  releaseCodexSandboxExecServerEnvironment,
  type CodexSandboxExecEnvironment,
} from "./sandbox-exec-server.js";
import { matchesCodexNativeSubagentSubmissionBinding } from "./session-binding-record.js";
import {
  clearSharedCodexAppServerClientIfCurrentAndUnclaimed,
  createIsolatedCodexAppServerClient,
  retainSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import type {
  CodexStartOrResumeThreadParams,
  CodexThreadFinalConfigPatchDecision,
} from "./thread-lifecycle-types.js";
import type { CodexAppServerThreadLifecycleBinding } from "./thread-lifecycle.js";
import {
  isSameCodexAppServerThreadOwner,
  retainCodexAppServerBindingSubscription,
} from "./thread-ownership.js";
import { createCodexTrajectoryRecorder } from "./trajectory.js";
import type { CodexAppServerTurnRouter, CodexThreadRouteReservation } from "./turn-router.js";

export function prepareCodexAttemptResources(prompt: CodexAttemptPrompt) {
  const { context, turnState, buildRenderedCodexDeveloperInstructions } = prompt;
  const { runtime, attemptTools } = context;
  const { connection, hookChannelId } = runtime;
  const {
    appServer,
    params,
    effectiveCwd,
    sessionAgentId,
    contextSessionKey,
    runAbortController,
    sandbox,
    options,
    nativeHookRelayEvents,
  } = connection;
  const { toolBridge } = attemptTools;
  const modelAdmissionSource = runtime.nativeToolSurfaceEnabled
    ? params.hostCapabilities.retainSourceAuthority?.()
    : undefined;
  let nativeModelAdmission: CodexStartOrResumeThreadParams["nativeModelAdmission"];
  try {
    nativeModelAdmission = modelAdmissionSource
      ? modelAdmissionSource.modelPolicyRequired !== false
        ? "required"
        : options.nativeHookRelay?.enabled === false
          ? "disabled"
          : "optional"
      : undefined;
  } finally {
    modelAdmissionSource?.release();
  }
  let nativeProcessAuthorityReleased = false;
  const releaseNativeProcessAuthority = () => {
    if (!nativeProcessAuthorityReleased) {
      nativeProcessAuthorityReleased = true;
      nativeProcessAuthority?.release();
    }
  };
  const trajectoryRecorder = createCodexTrajectoryRecorder({
    attempt: params,
    cwd: effectiveCwd,
    developerInstructions: buildRenderedCodexDeveloperInstructions(),
    prompt: turnState.codexTurnPromptText,
    trajectory: params.hostCapabilities.trajectory,
    tools: toolBridge.availableSpecs,
  });
  const initialResourceState: {
    sandboxExecEnvironment: CodexSandboxExecEnvironment | undefined;
    executionDisconnectError: Error | undefined;
    releaseInferenceContext: (() => void) | undefined;
  } = {
    sandboxExecEnvironment: undefined,
    executionDisconnectError: undefined,
    releaseInferenceContext: undefined,
  };
  const state = {
    client: undefined as unknown as CodexAppServerClient,
    thread: undefined as unknown as CodexAppServerThreadLifecycleBinding,
    runtimeArtifact: undefined as AgentHarnessRuntimeArtifactBinding | undefined,
    turnRouter: undefined as unknown as CodexAppServerTurnRouter,
    turnRoute: undefined as CodexThreadRouteReservation | undefined,
    routeActivated: false,
    detachRouteAbort: (() => undefined) as () => void,
    trajectoryEndRecorded: false,
    nativeHookRelay: undefined as CodexNativeHookRelay | undefined,
    nativeSubagentMonitor: undefined as
      | ReturnType<typeof codexNativeSubagentMonitorRuntime.register>
      | undefined,
    runtimeContinuationStarted: false,
    nativePreToolUseFailureFallbackActive: false,
    nativePreToolUseFailureFallbackTerminalReason: undefined as
      | CodexNativePreToolUseFailure["disposition"]
      | undefined,
    releaseSharedClientLease: undefined as (() => void) | undefined,
    startupClientUnsafe: false,
    turnStartAttempted: false,
    sharedCodexClientRetiredForOneShotCleanup: false,
    ...initialResourceState,
    codexEnvironmentSelection: undefined as CodexTurnEnvironmentParams[] | undefined,
    codexExecutionCwd: effectiveCwd,
    codexSandboxPolicy: undefined as CodexSandboxPolicy | undefined,
    restartContextEngineCodexThread: undefined as
      | (() => Promise<CodexAppServerThreadLifecycleBinding>)
      | undefined,
  };
  const pendingNativePreToolUseFailures: CodexNativePreToolUseFailure[] = [];
  const projectorRef: { current?: CodexAppServerEventProjector } = {};
  const emitNativePreToolUseFailure = (failure: CodexNativePreToolUseFailure) => {
    emitCodexNativePreToolUseFailureDiagnostic({
      agentId: sessionAgentId,
      sessionId: params.sessionId,
      sessionKey: contextSessionKey,
      runId: params.runId,
      signal: runAbortController.signal,
      failure,
      ...(state.nativePreToolUseFailureFallbackActive
        ? {
            terminalReason:
              state.nativePreToolUseFailureFallbackTerminalReason ?? failure.disposition,
          }
        : {}),
    });
  };
  const flushPendingNativePreToolUseFailures = () => {
    for (const failure of pendingNativePreToolUseFailures.splice(0)) {
      emitNativePreToolUseFailure(failure);
    }
  };
  const activateNativePreToolUseFailureFallback = () => {
    if (!state.nativePreToolUseFailureFallbackActive) {
      state.nativePreToolUseFailureFallbackTerminalReason = runAbortController.signal.aborted
        ? resolveCodexToolAbortTerminalReason(runAbortController.signal)
        : undefined;
      state.nativePreToolUseFailureFallbackActive = true;
    }
    flushPendingNativePreToolUseFailures();
  };
  const releaseSharedClientLeaseOnce = () => {
    const release = state.releaseSharedClientLease;
    if (!release) {
      return;
    }
    state.releaseSharedClientLease = undefined;
    release();
  };
  const retireSharedCodexClientForOneShotCleanup = async () => {
    if (
      params.cleanupBundleMcpOnRunEnd !== true ||
      state.sharedCodexClientRetiredForOneShotCleanup
    ) {
      return;
    }
    state.sharedCodexClientRetiredForOneShotCleanup = true;
    const retired = clearSharedCodexAppServerClientIfCurrentAndUnclaimed(state.client);
    // Runs on every one-shot attempt teardown; routine retirement checks are
    // diagnostic detail, not operator-facing info.
    embeddedAgentLog.debug("codex app-server one-shot cleanup checked shared client retirement", {
      runId: params.runId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      activeLeases: retired.activeLeases,
      pendingAcquires: retired.pendingAcquires,
      closed: retired.closed,
      matchedSharedClient: retired.found,
    });
    // Retained peers prevent retirement; preserve their client without treating
    // missing close evidence as a completed one-shot cleanup.
    const result = retired.closed
      ? await state.client.closeAndWait({ exitTimeoutMs: 2_000, forceKillDelayMs: 250 })
      : undefined;
    if (params.oneShotCliRun && result?.cleanup !== "closed") {
      throw new Error("Codex one-shot client cleanup could not be confirmed");
    }
  };
  const releaseSandboxExecEnvironment = async () => {
    if (state.sandboxExecEnvironment) {
      const environment = state.sandboxExecEnvironment;
      state.sandboxExecEnvironment = undefined;
      await releaseCodexSandboxExecServerEnvironment(sandbox, environment);
    }
  };
  const releaseSharedClientLeaseAndRetireOneShotClient = async () => {
    if (connection.attemptClientFactory === createIsolatedCodexAppServerClient) {
      // Close the authorized node lease first; losing its socket first is a real disconnect.
      await releaseSandboxExecEnvironment();
      const ownedClient = state.releaseSharedClientLease ? state.client : undefined;
      releaseSharedClientLeaseOnce();
      if (ownedClient) {
        const result = await ownedClient.closeAndWait({
          exitTimeoutMs: 2_000,
          forceKillDelayMs: 250,
        });
        if (params.oneShotCliRun && result.cleanup !== "closed") {
          throw new Error("Codex isolated client cleanup could not be confirmed");
        }
      }
      return;
    }
    releaseSharedClientLeaseOnce();
    await retireSharedCodexClientForOneShotCleanup();
  };
  const runCleanupStep = (step: string, operation: () => Promise<void> | void | undefined) =>
    runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step,
      log: embeddedAgentLog,
      cleanup: async () => {
        await operation();
      },
    });
  let nativeSubagentMonitorSettlement: Promise<void> | undefined;
  const unregisterNativeSubagentMonitor = async () => {
    const registration = state.nativeSubagentMonitor;
    state.nativeSubagentMonitor = undefined;
    if (registration) {
      nativeSubagentMonitorSettlement = registration.unregister();
    }
    await nativeSubagentMonitorSettlement;
  };
  const registerNativeSubagentMonitor = async (parentThreadId: string) => {
    await unregisterNativeSubagentMonitor();
    connection.assertCurrent();
    const sessionKey = params.sessionKey;
    const storePath = params.sessionTarget?.storePath;
    const parentSession =
      sessionKey && storePath
        ? getSessionEntry({
            agentId: sessionAgentId,
            sessionKey,
            storePath,
            readConsistency: "latest",
            hydrateSkillPromptRefs: false,
          })
        : undefined;
    const historyOwner = createCodexNativeSubagentHistoryOwner({
      parentThreadId,
      sessionId: params.sessionId,
      ...(parentSession?.sessionId === params.sessionId
        ? { lifecycleRevision: parentSession.lifecycleRevision }
        : {}),
      binding: state.thread,
    });
    const { bindingStore, bindingIdentity } = connection;
    const submissionStore: CodexNativeSubagentSubmissionStore | undefined = historyOwner
      ? {
          assertCurrent: () => {
            const current = bindingStore.read(bindingIdentity);
            if (!current || !matchesCodexNativeSubagentSubmissionBinding(current, historyOwner)) {
              throw new Error("Native submission binding is no longer current.");
            }
            if (historyOwner.lifecycleRevision && sessionKey && storePath) {
              const currentSession = getSessionEntry({
                agentId: sessionAgentId,
                sessionKey,
                storePath,
                readConsistency: "latest",
                hydrateSkillPromptRefs: false,
              });
              if (currentSession?.lifecycleRevision !== historyOwner.lifecycleRevision) {
                throw new Error("Native submission session lifecycle is no longer current.");
              }
            }
          },
          read: () => bindingStore.readNativeSubagentSubmissions(bindingIdentity, historyOwner),
          record: (receipt, assertCurrent) =>
            bindingStore.mutate(
              bindingIdentity,
              { kind: "record-native-subagent-submission", owner: historyOwner, receipt },
              assertCurrent,
            ),
          consume: (receipt, assertCurrent) =>
            bindingStore.mutate(
              bindingIdentity,
              { kind: "consume-native-subagent-submission", owner: historyOwner, receipt },
              assertCurrent,
            ),
        }
      : undefined;
    const retainModelSource = params.hostCapabilities.retainSourceAuthority;
    const modelSource = retainModelSource?.();
    try {
      const configurationQualification = getCodexInferenceThreadQualification(
        state.client,
        parentThreadId,
      );
      state.nativeSubagentMonitor = codexNativeSubagentMonitorRuntime.register({
        client: state.client,
        parentThreadId,
        ...(retainModelSource ? { modelSource } : {}),
        configurationQualification,
        unqualifiedModelExecution: modelSource && !configurationQualification ? true : undefined,
        onUnqualifiedModelCancelled: connection.abortExplicitly,
        requesterSessionKey: params.sessionKey,
        taskRuntimeScope: params.agentHarnessTaskRuntimeScope,
        historyOwner,
        submissionStore,
        agentId: sessionAgentId,
        retainClient: () => retainSharedCodexAppServerClientIfCurrent(state.client),
        retainParentThread: (protectedThreadId) =>
          protectCodexAppServerLiveThread(state.client, protectedThreadId),
        claimDirectChild: (childThreadId) => state.nativeHookRelay?.claimDirectChild(childThreadId),
        rejectPendingDirectChild: (childThreadId, reason) =>
          state.nativeHookRelay?.rejectPendingDirectChild(childThreadId, reason),
        ...(params.sessionKey && params.agentHarnessTaskRuntimeScope
          ? {
              onDirectChildAccepted: () => {
                state.runtimeContinuationStarted = true;
              },
            }
          : {}),
      });
    } catch (error) {
      modelSource?.release();
      throw error;
    }
  };
  const releaseCurrentRoute = async () => {
    state.releaseInferenceContext?.();
    state.releaseInferenceContext = undefined;
    state.detachRouteAbort();
    state.detachRouteAbort = () => undefined;
    state.turnRoute?.release();
    state.turnRoute = undefined;
    state.routeActivated = false;
    await unregisterNativeSubagentMonitor();
  };
  // Startup transfers the claim with state.thread. Both pre-turn failure and
  // active-turn cleanup settle it here; neither may unsubscribe a successor.
  let subscriptionSettlement:
    | { thread: CodexAppServerThreadLifecycleBinding; retained: boolean }
    | undefined;
  const retainThreadSubscription = async (): Promise<boolean> => {
    const { client, thread } = state;
    if (subscriptionSettlement?.thread === thread) {
      return subscriptionSettlement.retained;
    }
    if (!thread || thread.clientId !== resolveCodexAppServerClientInstanceId(client)) {
      return false;
    }
    const { bindingStore, bindingIdentity } = connection;
    const retained = await bindingStore.withLease(bindingIdentity, async () => {
      if (!isSameCodexAppServerThreadOwner(bindingStore.read(bindingIdentity), thread)) {
        return false;
      }
      try {
        if (!state.turnStartAttempted) {
          runAbortController.signal.throwIfAborted();
        }
        // Retaining the existing subscription is cleanup custody for concrete
        // background work; revoking this foreground source cannot evict a peer.
        if (!hasCodexNativeBackgroundProcesses(client, thread.threadId)) {
          params.hostCapabilities.assertActive();
          connection.assertCurrent();
        }
        thread.liveThreadOwnership?.assertCurrent();
      } catch {
        return false;
      }
      return await retainCodexAppServerBindingSubscription(client, thread.threadId, {
        release: thread.liveThreadOwnership?.release,
        configFingerprint: thread.liveThreadConfigFingerprint,
        serviceTier: state.turnStartAttempted
          ? connection.mutable.pluginAppServer.serviceTier
          : thread.liveThreadOwnership?.serviceTier,
        ephemeralPolicy: thread.liveThreadEphemeralPolicy,
      });
    });
    if (retained) {
      subscriptionSettlement = { thread, retained: true };
    }
    return retained;
  };
  const releaseThreadSubscription = async (assertCurrent?: () => void): Promise<boolean> => {
    const { client, thread } = state;
    if (!thread || subscriptionSettlement?.thread === thread) {
      return true;
    }
    // Record the attempted settlement before awaiting; failed acknowledgments
    // retire the client, not a second unsubscribe from a competing cleanup path.
    subscriptionSettlement = { thread, retained: false };
    if (thread.liveThreadOwnership) {
      try {
        await thread.liveThreadOwnership.release(thread.threadId, assertCurrent);
        return true;
      } catch (error) {
        await closeCodexStartupClientBestEffort(client);
        throw error;
      }
    }
    const released = await unsubscribeCodexThreadBestEffort(client, {
      threadId: thread.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
      assertCurrent,
    });
    if (!released) {
      await closeCodexStartupClientBestEffort(client);
    }
    return released;
  };
  const cleanupBeforeActiveTurn = async () => {
    await runCleanupStep("codex-pre-turn-hook-fallback", activateNativePreToolUseFailureFallback);
    await runCleanupStep("codex-pre-turn-subscription", async () => {
      const { thread } = state;
      if (!thread || subscriptionSettlement?.thread === thread || state.startupClientUnsafe) {
        return;
      }
      let retained = false;
      try {
        // Only a pre-write failure may restore an unchanged warm claim. A
        // rejected/ambiguous turn start keeps its existing release semantics.
        retained = Boolean(
          !state.turnStartAttempted &&
          !runAbortController.signal.aborted &&
          params.cleanupBundleMcpOnRunEnd !== true &&
          thread.liveThreadOwnership &&
          (await retainThreadSubscription()),
        );
      } finally {
        if (!retained) {
          const bindingReleased =
            !isIncognitoSessionKey(params.sessionKey) ||
            (await connection.bindingStore.mutate(connection.bindingIdentity, {
              kind: "clear",
              threadId: thread.threadId,
            }));
          if (bindingReleased) {
            await releaseThreadSubscription();
          }
        }
      }
    });
    await runCleanupStep("codex-pre-turn-route-release", releaseCurrentRoute);
    const relay = state.nativeHookRelay;
    state.nativeHookRelay = undefined;
    await runCleanupStep("codex-pre-turn-native-hook-relay", async () => {
      relay?.unregister();
      await relay?.drain();
    });
    await runCleanupStep("codex-pre-turn-sandbox-release", releaseSandboxExecEnvironment);
    await runCleanupStep("codex-pre-turn-source-release", releaseNativeProcessAuthority);
    await runCleanupStep("codex-pre-turn-trajectory-flush", () => trajectoryRecorder?.flush());
    await runCleanupStep(
      "codex-pre-turn-shared-client-release",
      releaseSharedClientLeaseAndRetireOneShotClient,
    );
  };
  const startupTimeoutMs = resolveCodexStartupTimeoutMs({
    timeoutMs: params.timeoutMs,
    timeoutFloorMs: options.startupTimeoutFloorMs,
  });
  const requesterChannel = params.messageChannel ?? params.messageProvider;
  const requester = buildCodexHookRequester(params);
  const buildNativeHookRelayFinalConfigPatch = async (
    decision: CodexThreadFinalConfigPatchDecision,
  ) => {
    const previousRelay = state.nativeHookRelay;
    previousRelay?.unregister();
    await previousRelay?.drain();
    connection.assertCurrent();
    const requiresProcessAdmission = nativeProcessAuthority && runtime.nativeToolSurfaceEnabled;
    const requiresModelAdmission =
      nativeModelAdmission !== undefined && decision.nativeModelInputTools !== undefined;
    const requiresExecutionAdmission = requiresProcessAdmission || requiresModelAdmission;
    const relayEvents =
      requiresExecutionAdmission && !nativeHookRelayEvents.includes("pre_tool_use")
        ? [...nativeHookRelayEvents, "pre_tool_use" as const]
        : nativeHookRelayEvents;
    if (params.pluginHarnessToolPolicyRestricted === true) {
      state.nativeHookRelay = undefined;
      return {
        configPatch: buildCodexNativeHookRelayDisabledConfig(),
        nativeHookRelayGeneration: undefined,
      };
    }
    state.nativeHookRelay = createCodexNativeHookRelay({
      options: requiresExecutionAdmission
        ? { ...options.nativeHookRelay, enabled: true }
        : options.nativeHookRelay,
      generation:
        decision.action === "resume" ? decision.binding.nativeHookRelayGeneration : undefined,
      generationMismatchGraceMs:
        decision.action === "resume" && !decision.binding.nativeHookRelayGeneration
          ? CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS
          : undefined,
      events: relayEvents,
      agentId: sessionAgentId,
      sessionId: params.sessionId,
      sessionKey: contextSessionKey,
      config: params.config,
      autoApproveMcpTools: shouldAutoApproveCodexAppServerApprovals(appServer),
      projectedMcpServers: runtime.bundleMcpThreadConfig.configPatch?.mcp_servers,
      runId: params.runId,
      channelId: hookChannelId,
      ...(requester ? { requester } : {}),
      approvalContext: {
        trigger: params.trigger,
        approvalReviewerDeviceId: params.approvalReviewerDeviceId,
        turnSourceChannel: requesterChannel,
        turnSourceTo: params.currentMessagingTarget ?? params.currentChannelId,
        turnSourceAccountId: params.agentAccountId,
        turnSourceThreadId: params.currentThreadTs,
      },
      attemptTimeoutMs: params.timeoutMs,
      startupTimeoutMs,
      turnStartTimeoutMs: params.timeoutMs,
      loopDetectionPreToolUseRelay: appServer.loopDetectionPreToolUseRelay,
      signal: runAbortController.signal,
      hostCapabilities: params.hostCapabilities,
      nativeProcessAuthority: requiresProcessAdmission
        ? { owner: nativeProcessAuthority, client: () => state.client }
        : undefined,
      nativeModelAdmission: requiresModelAdmission
        ? {
            client: () => state.client,
            threadId: () => state.thread?.threadId,
            tools: decision.nativeModelInputTools,
            readQualification: (threadId) =>
              getCodexInferenceThreadQualification(state.client, threadId),
          }
        : undefined,
      assertCurrent: connection.assertCurrent,
      onPreToolUseFailure: (failure) => {
        const projector = projectorRef.current;
        if (projector) {
          projector.recordNativeToolPreToolUseFailure(failure);
        } else if (state.nativePreToolUseFailureFallbackActive) {
          emitNativePreToolUseFailure(failure);
        } else {
          pendingNativePreToolUseFailures.push(failure);
        }
      },
    });
    await state.nativeHookRelay?.prepareInvocation();
    connection.assertCurrent();
    return {
      configPatch: state.nativeHookRelay
        ? buildCodexNativeHookRelayConfig({
            relay: state.nativeHookRelay,
            events: relayEvents,
            hookTimeoutSec: options.nativeHookRelay?.hookTimeoutSec,
          })
        : options.nativeHookRelay?.enabled === false
          ? buildCodexNativeHookRelayDisabledConfig()
          : undefined,
      nativeHookRelayGeneration: state.nativeHookRelay?.generation,
    };
  };
  const nativeProcessAuthority =
    sandbox?.enabled && sandbox.backend && params.hostCapabilities.retainSourceAuthority
      ? new CodexNativeProcessAuthority(params.hostCapabilities, (error) => {
          const message = formatErrorMessage(error);
          embeddedAgentLog.warn("codex native background work remains unsettled", {
            runId: params.runId,
            sessionId: params.sessionId,
            error: message,
          });
          void emitCodexAppServerEvent(params, {
            stream: "codex_app_server.lifecycle",
            data: { phase: "background_cleanup_failed", error: message },
          });
        })
      : undefined;
  return {
    prompt,
    trajectoryRecorder,
    state,
    projectorRef,
    pendingNativePreToolUseFailures,
    nativeModelAdmission,
    nativeProcessAuthority,
    releaseNativeProcessAuthority,
    markTrajectoryEndRecorded: () => {
      state.trajectoryEndRecorded = true;
    },
    activateNativePreToolUseFailureFallback,
    releaseSharedClientLeaseOnce,
    releaseSharedClientLeaseAndRetireOneShotClient,
    releaseSandboxExecEnvironment,
    runCleanupStep,
    registerNativeSubagentMonitor,
    releaseCurrentRoute,
    retainThreadSubscription,
    releaseThreadSubscription,
    cleanupBeforeActiveTurn,
    startupTimeoutMs,
    buildNativeHookRelayFinalConfigPatch,
  };
}

export type CodexAttemptResources = ReturnType<typeof prepareCodexAttemptResources>;
