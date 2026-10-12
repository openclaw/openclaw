import { isDeepStrictEqual } from "node:util";
import { buildActiveNodeContextText } from "../../infra/active-node-context.js";
import { emitAgentRunOutputTokens } from "../../infra/agent-events.js";
import { getActiveDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import {
  getInstallationTarget,
  withInstallationTarget,
} from "../../infra/installation-target-context.js";
import { registerMcpToolApprovalBinding } from "../../infra/mcp-tool-approval-binding.js";
import { prepareSystemRunMutableFileApproval } from "../../infra/system-run-approval-binding.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import {
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { bindUserTurnTranscriptAnnotation } from "../../sessions/user-turn-transcript-annotation.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { loadSkillLibrarySelection } from "../../skills/library/selection.js";
import { resolveSkillResourceCandidates } from "../../skills/runtime/resource-candidates.js";
import type { SkillEntry } from "../../skills/types.js";
import {
  getAdmittedRunDelegatedAuthority,
  readAdmittedRunOperatorAuthority,
  retainAdmittedRunBeforeToolCallRecovery,
} from "../admitted-run-context.js";
import { bindAgentToolSourceExecutionGuard } from "../agent-tool-source-execution-guard.js";
import { wrapToolWithAbortSignal } from "../agent-tools.abort.js";
import {
  rewrapToolWithBeforeToolCallHook,
  runBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import {
  createOpenClawCodingToolsInternal,
  createOpenClawCodingToolsInternalAsync,
} from "../agent-tools.js";
import { log } from "../embedded-agent-runner/logger.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { runBestEffortCallback } from "../embedded-agent-subscribe.callback.js";
import { createCronScheduledToolProjection } from "../exec-tool-target-pinning.js";
import { throwAgentRunRestartAbortReason } from "../run-termination.js";
import { resolveToolLoopDetectionConfig } from "../tool-loop-detection-config.js";
import { isToolExecutionAllowed } from "../tool-policy-shared.js";
import type { AnyAgentTool } from "../tools/common.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  withGatewayToolApprovalOwner,
  withGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { callGatewayTool } from "../tools/gateway.js";
import {
  getCoreTtsToolResultMediaUrls,
  transferCoreTtsToolResultProvenance,
} from "../tools/tts-tool-result-provenance.js";
import { gateBoundTool } from "./host-bound-tool.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import { captureRequiredWorkspaceToolFloor } from "./host-capability-workspace.js";
import { normalizeNativeOperationCwd, prepareAgentHarnessEnvironment } from "./host-environment.js";
import { bindHarnessMedia } from "./host-media.js";
import {
  registerAgentHarnessBeforeToolCallRetention,
  registerAgentHarnessScheduledToolProjectionCapability,
  registerAgentHarnessTtsProvenanceTransferCapability,
  resolveAgentQuestionAnswerAuthority,
  withAgentQuestionAnswerAuthority,
} from "./host-private-capabilities.js";
import { bindHostSkillCatalog, prepareHostSkillLibraryResources } from "./host-skills.js";
import { cloneHostSnapshot as cloneSnapshot } from "./host-snapshot.js";
import {
  bindHarnessHostSourceAuthority,
  bindHarnessModelExecution,
  bindHarnessNativeSpawnAuthority,
  retainHarnessSource,
} from "./host-source-authority.js";
import { bindHarnessTrajectory } from "./host-trajectory.js";
import { formatHarnessApprovalPresentation } from "./native-hook-relay-approval-presentation.js";
import { createSessionNodeAuthorities } from "./node-execution-authority.js";

type AgentHarnessHostAttempt = Partial<EmbeddedRunAttemptParams> &
  Pick<EmbeddedRunAttemptParams, "admittedRunContext" | "runId">;
type AgentHarnessHostApprovalResult = NonNullable<
  Awaited<ReturnType<AgentHarnessHostCapabilities["waitForApproval"]>>
>;
type HostToolSurfaceOptions = Parameters<
  NonNullable<AgentHarnessHostCapabilities["createToolSurfaceAsync"]>
>[0];

/** Creates a closure-bound capability before plugin invocation. */
export function createAgentHarnessHostCapabilities(params: {
  attempt: AgentHarnessHostAttempt;
  pluginId: string;
  requiredNodeCommands?: readonly string[];
  nativeModelPolicySupport?: "exact";
}): {
  capabilities: AgentHarnessHostCapabilities;
  close: () => void;
  setInputAttachmentReadAllowed: (allowed: boolean) => void;
  runWithScope: <T>(run: () => Promise<T>) => Promise<T>;
} {
  const attempt = params.attempt;
  // Capture authority by value before any plugin handoff can mutate the attempt.
  const runtimePluginToolGrant = attempt.runtimePluginToolGrant
    ? Object.freeze({
        pluginId: attempt.runtimePluginToolGrant.pluginId,
        toolNames: Object.freeze([...attempt.runtimePluginToolGrant.toolNames]),
      })
    : undefined;
  const githubPublicationAvailable = attempt.githubPublicationAvailable;
  const workSignal = getAsyncWorkSignal();
  const attemptSignal = attempt.abortSignal;
  const installationTarget = getInstallationTarget();
  const { sessionKey, onAgentEvent } = attempt;
  // Capture the selected harness declaration before plugin code can mutate it.
  // Full must not cover other commands merely because the same plugin owns them.
  const requiredNodeCommands = new Set(params.requiredNodeCommands);
  const nativeModelPolicySupported = params.nativeModelPolicySupport === "exact";
  const operationalRunInstance = attempt.admittedRunContext.operationalRunInstance;
  const delegatedAuthority = getAdmittedRunDelegatedAuthority(attempt.admittedRunContext);
  const requesterProfileId = readAdmittedRunOperatorAuthority(
    attempt.admittedRunContext,
  )?.profileId;
  if (!delegatedAuthority) {
    throw new Error("agent harness host capability requires active admitted run authority");
  }
  const { lifecycleGeneration } = delegatedAuthority;
  const { runId } = delegatedAuthority.operationalRunInstance;
  const coreTtsToolResults = new WeakSet<object>();
  let active = true;
  // Lexical closure must also fence work already past its entry guard. The
  // result guards below cover exact authority loss that does not use close().
  const capabilityAbortController = new AbortController();
  const bindAbortSignal = (signal: AbortSignal | undefined) =>
    signal
      ? AbortSignal.any([signal, capabilityAbortController.signal])
      : capabilityAbortController.signal;
  const inheritedCaller = getGatewayToolCallerIdentity();
  const sourceCaller =
    inheritedCaller?.operationalRunInstance === operationalRunInstance
      ? inheritedCaller
      : undefined;
  let personalToolParticipants = sourceCaller?.personalToolParticipants;
  const inactiveError = (message: string) => {
    // Gateway closure can precede the run's abort marker. Keep its captured
    // reason without replacing an earlier user cancellation or deadline.
    throwAgentRunRestartAbortReason(
      attemptSignal?.aborted ? attemptSignal.reason : workSignal?.reason,
    );
    return new Error(message);
  };
  // Only a Gateway captured at admission participates in host liveness.
  // A supplied resolver that currently returns no context is a retired binding;
  // only a genuinely absent resolver is exempt from the Gateway liveness fence.
  const boundGatewayContext = getGatewayContextResolver(attempt.admittedRunContext);
  const assertActive = bindHarnessHostSourceAuthority({
    attempt,
    delegatedAuthority,
    sourceCaller,
    isActive: () => active,
    isGatewayCurrent: () =>
      !boundGatewayContext || callerIdentity?.gatewayContextResolver?.() !== undefined,
    inactiveError,
  });
  const callerIdentity = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: attempt.admittedRunContext,
    receiptAuthority: assertActive,
    approvalSignals: [capabilityAbortController.signal, ...(attemptSignal ? [attemptSignal] : [])],
    agentId: attempt.agentId,
    sessionKey: attempt.sessionKey,
    turnSourceChannel: attempt.messageChannel ?? attempt.messageProvider,
    turnSourceTo: attempt.currentMessagingTarget ?? attempt.currentChannelId,
    turnSourceAccountId: attempt.agentAccountId,
    turnSourceThreadId: attempt.currentThreadTs,
  });
  const observeCoreTtsToolResult = (result: unknown) => {
    if (typeof result === "object" && result !== null && getCoreTtsToolResultMediaUrls(result)) {
      coreTtsToolResults.add(result);
    }
  };
  const requester = {
    ...((attempt.messageChannel ?? attempt.messageProvider)
      ? { channel: attempt.messageChannel ?? attempt.messageProvider ?? undefined }
      : {}),
    ...(attempt.agentAccountId ? { accountId: attempt.agentAccountId } : {}),
    ...(attempt.senderId ? { senderId: attempt.senderId } : {}),
    ...(attempt.senderIsOwner !== undefined ? { senderIsOwner: attempt.senderIsOwner } : {}),
    ...(attempt.memberRoleIds?.length
      ? { roleIds: Object.freeze([...attempt.memberRoleIds]) }
      : {}),
  };
  const config = attempt.config ? cloneSnapshot(attempt.config) : undefined;
  const hostSandboxEnabled = attempt.sandbox?.enabled === true;
  const requiredWorkspace = captureRequiredWorkspaceToolFloor(attempt, params.pluginId, config);
  const capturedWorkspaceOptions = requiredWorkspace?.apply();
  const media = bindHarnessMedia({
    attempt,
    config,
    assertActive,
    signal: capabilityAbortController.signal,
  });
  const recorder = attempt.userTurnTranscriptRecorder;
  const sessionTarget = attempt.sessionTarget ? cloneSnapshot(attempt.sessionTarget) : undefined;
  const annotateCurrentUserTurn =
    attempt.userTurnTranscriptRecorder &&
    attempt.sessionTarget &&
    attempt.agentId &&
    attempt.sessionId &&
    attempt.sessionKey &&
    attempt.sessionTarget.storePath &&
    !attempt.suppressNextUserMessagePersistence &&
    attempt.trigger !== "memory"
      ? bindUserTurnTranscriptAnnotation({
          recorder: attempt.userTurnTranscriptRecorder,
          target: {
            ...attempt.sessionTarget,
            agentId: attempt.agentId,
            sessionId: attempt.sessionId,
            sessionKey: attempt.sessionKey,
            storePath: attempt.sessionTarget.storePath,
          },
          runId: attempt.runId,
          config,
          abortSignal: bindAbortSignal(attempt.abortSignal),
          assertCurrent: () => {
            assertActive();
            if (
              attempt.userTurnTranscriptRecorder !== recorder ||
              !isDeepStrictEqual(attempt.sessionTarget, sessionTarget) ||
              (sessionTarget?.agentId !== undefined && sessionTarget.agentId !== attempt.agentId) ||
              (sessionTarget?.sessionId !== undefined &&
                sessionTarget.sessionId !== attempt.sessionId) ||
              (sessionTarget?.sessionKey !== undefined &&
                sessionTarget.sessionKey !== attempt.sessionKey)
            ) {
              throw new Error("native prompt annotation lost its source execution claim");
            }
          },
        })
      : undefined;
  const skillsSnapshot = attempt.skillsSnapshot ? cloneSnapshot(attempt.skillsSnapshot) : undefined;
  const getInstalledSkills = bindHostSkillCatalog({
    snapshot: skillsSnapshot,
    workspaceDir:
      capturedWorkspaceOptions?.workspaceDir ??
      attempt.bootstrapWorkspaceDir ??
      attempt.workspaceDir ??
      attempt.cwd ??
      process.cwd(),
    sandbox: requiredWorkspace ? capturedWorkspaceOptions?.sandbox : attempt.sandbox,
    requiredRoot: requiredWorkspace?.root,
    readable:
      attempt.operation !== "settled-tool-finalization" &&
      (!attempt.toolExecutionAllow || isToolExecutionAllowed(attempt.toolExecutionAllow, "read")),
    assertCurrent: assertActive,
  });
  const preparedRunEnvironment = prepareAgentHarnessEnvironment({
    config,
    agentId: attempt.agentId,
    sessionKey: attempt.sessionKey,
    sandboxAgentId: attempt.sandboxAgentId,
    installationTarget,
  });
  const skillUsagePaths = attempt.sandbox?.skillUsagePaths
    ? cloneSnapshot(attempt.sandbox.skillUsagePaths)
    : undefined;
  const hookContext = Object.freeze({
    ...(attempt.agentId ? { agentId: attempt.agentId } : {}),
    ...(config ? { config } : {}),
    ...(attempt.cwd ? { cwd: attempt.cwd } : {}),
    ...(attempt.workspaceDir ? { workspaceDir: attempt.workspaceDir } : {}),
    ...(attempt.sessionKey ? { sessionKey: attempt.sessionKey } : {}),
    ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
    runId: attempt.runId,
    ...buildAgentHookContextChannelFields(attempt),
    ...(Object.keys(requester).length > 0 ? { requester: Object.freeze(requester) } : {}),
    ...(getActiveDiagnosticTraceContext() ? { trace: getActiveDiagnosticTraceContext() } : {}),
    ...(skillsSnapshot ? { skillsSnapshot } : {}),
    ...(skillUsagePaths ? { skillUsagePaths } : {}),
    ...(attempt.onToolOutcome ? { onToolOutcome: attempt.onToolOutcome } : {}),
    ...(attempt.allocateToolOutcomeOrdinal
      ? { allocateToolOutcomeOrdinal: attempt.allocateToolOutcomeOrdinal }
      : {}),
    ...(attempt.sandbox?.enabled &&
    attempt.sandbox.workspaceAccess === "rw" &&
    attempt.sandbox.fsBridge
      ? {
          sandbox: Object.freeze({
            root: attempt.sandbox.workspaceDir,
            bridge: attempt.sandbox.fsBridge,
          }),
        }
      : {}),
    loopDetection: cloneSnapshot(
      resolveToolLoopDetectionConfig({
        cfg: config,
        agentId: attempt.agentId,
      }),
    ),
    trigger: attempt.trigger,
    approvalReviewerDeviceId: attempt.approvalReviewerDeviceId,
    turnSourceChannel: attempt.messageChannel ?? attempt.messageProvider,
    turnSourceTo: attempt.currentMessagingTarget ?? attempt.currentChannelId,
    turnSourceAccountId: attempt.agentAccountId,
    turnSourceThreadId: attempt.currentThreadTs,
  });
  const withCaller = async <T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> =>
    await withGatewayToolCallerIdentity(
      callerIdentity && signal
        ? {
            ...callerIdentity,
            approvalSignals: [...(callerIdentity.approvalSignals ?? []), signal],
          }
        : callerIdentity,
      run,
    );
  const hookContextForOperation = (operation?: Readonly<{ cwd?: string }>) => {
    const cwd =
      operation?.cwd !== undefined
        ? normalizeNativeOperationCwd(operation.cwd, hookContext.cwd)
        : undefined;
    return cwd ? Object.freeze({ ...hookContext, cwd }) : hookContext;
  };
  const runBeforeToolCallWithAssertion = async (
    assertCurrent: () => void,
    {
      nativeOperation,
      approvalMode,
      ...request
    }: Parameters<AgentHarnessHostCapabilities["runBeforeToolCall"]>[0],
  ) => {
    assertCurrent();
    const hostApprovalMode = approvalMode === "defer" ? "defer" : "request";
    const actionHookContext = hookContextForOperation(nativeOperation);
    const result = await runBeforeToolCallHook({
      ...request,
      approvalMode: hostApprovalMode,
      ctx: actionHookContext,
    });
    assertCurrent();
    return result;
  };
  const runBeforeToolCall: AgentHarnessHostCapabilities["runBeforeToolCall"] = async (request) =>
    await withCaller(
      async () => await runBeforeToolCallWithAssertion(assertActive, request),
      request.signal,
    );
  registerAgentHarnessBeforeToolCallRetention(runBeforeToolCall, () => {
    const recovery = retainAdmittedRunBeforeToolCallRecovery(attempt.admittedRunContext);
    if (!recovery) {
      return undefined;
    }
    const assertRecoveryActive = () => {
      if (
        attempt.abortSignal?.aborted ||
        attempt.admittedRunContext.operationalRunInstance !== operationalRunInstance ||
        (boundGatewayContext && callerIdentity?.gatewayContextResolver?.() === undefined)
      ) {
        throw inactiveError("agent harness retained host policy is no longer active");
      }
      recovery.assertActive();
    };
    return Object.freeze({
      assertActive: assertRecoveryActive,
      release: recovery.release,
      runBeforeToolCall: async (request) =>
        await runBeforeToolCallWithAssertion(assertRecoveryActive, request),
    });
  });

  const trajectoryRecorder = attempt.trajectoryRecorder;
  const scheduledToolSources = new WeakMap<
    AnyAgentTool,
    Readonly<{ targetTool: "exec" | "process"; execute: AnyAgentTool["execute"] }>
  >();
  const bindTools = (
    tools: AnyAgentTool[],
    options: Readonly<{ cwd?: string }> | undefined,
    observeResult: (result: unknown) => void,
  ) => {
    assertActive();
    const boundAbortSignal = bindAbortSignal(attempt.abortSignal);
    const bindingHookContext = hookContextForOperation(options);
    return tools
      .map((tool) => bindAgentToolSourceExecutionGuard(tool, assertActive))
      .map((tool) => rewrapToolWithBeforeToolCallHook(tool, bindingHookContext))
      .map((tool) =>
        callerIdentity ? wrapToolWithGatewayCallerIdentity(tool, callerIdentity) : tool,
      )
      .map((tool) => wrapToolWithAbortSignal(tool, boundAbortSignal))
      .map((tool) => gateBoundTool(tool, assertActive, observeResult));
  };
  const bindToolSurface: AgentHarnessHostCapabilities["bindToolSurface"] = (tools, options) =>
    bindTools(tools, options, () => {});
  const bindModelExecution: AgentHarnessHostCapabilities["bindModelExecution"] =
    nativeModelPolicySupported
      ? (model) => bindHarnessModelExecution(attempt.admittedRunContext, model, assertActive)
      : undefined;
  // Sandboxes use their materialized snapshot paths, never host library pins.
  const skillResourceSnapshot = (options: HostToolSurfaceOptions) =>
    !requiredWorkspace &&
    !hostSandboxEnabled &&
    !options?.sandbox?.enabled &&
    options?.includeCoreTools !== false &&
    options?.toolConstructionPlan?.includeBaseCodingTools !== false
      ? skillsSnapshot
      : undefined;
  const toolConstructionInputs = (
    options: HostToolSurfaceOptions,
    libraryEntries: readonly SkillEntry[],
    assertCurrent: () => void = assertActive,
  ) => {
    assertCurrent();
    const effectiveOptions = { ...options, ...requiredWorkspace?.apply(options) };
    return {
      options: {
        ...effectiveOptions,
        // Availability belongs to this prepared host, not mutable plugin inputs.
        githubPublicationAvailable,
        runtimePluginToolGrant,
        skillsSnapshot: options?.skillsSnapshot ?? skillsSnapshot,
        installedSkills: getInstalledSkills(
          effectiveOptions.sandbox,
          effectiveOptions.sessionPermissionPolicy?.root,
        ),
        skillUsagePaths: options?.skillUsagePaths ?? skillUsagePaths,
        operationalRunInstance,
      },
      skillReadResources: resolveSkillResourceCandidates(
        skillResourceSnapshot(options),
        libraryEntries,
      ),
    };
  };
  const bindCreatedTools = (
    sourceTools: AnyAgentTool[],
    bindingOptions?: Readonly<{ cwd?: string }>,
  ) => {
    // Only host-created core tools can seed TTS provenance. Plugin-bound tools
    // must not replay a retained core result into this attempt's authority set.
    const tools = bindTools(sourceTools, bindingOptions, observeCoreTtsToolResult);
    for (const tool of tools) {
      if (tool.name === "exec" || tool.name === "process") {
        scheduledToolSources.set(
          tool,
          Object.freeze({ targetTool: tool.name, execute: tool.execute }),
        );
      }
    }
    return tools;
  };
  const withToolConstructionScope = <T>(run: () => T): T =>
    withAgentQuestionAnswerAuthority(resolveAgentQuestionAnswerAuthority(capabilities), () =>
      withInstallationTarget(installationTarget, run),
    );
  const capabilities: AgentHarnessHostCapabilities = Object.freeze({
    kind: "agent-harness-host-capability" as const,
    version: 1 as const,
    assertActive,
    get assertNativeSubagentSpawnAllowed() {
      return bindHarnessNativeSpawnAuthority(personalToolParticipants, assertActive);
    },
    ...(bindModelExecution ? { bindModelExecution } : {}),
    retainSourceAuthority: () =>
      retainHarnessSource(attempt.admittedRunContext, assertActive, nativeModelPolicySupported),
    reportOutputTokens: (outputTokens) => {
      assertActive();
      const data = emitAgentRunOutputTokens({
        runId,
        lifecycleGeneration,
        sessionKey,
        outputTokens,
      });
      if (data && onAgentEvent) {
        runBestEffortCallback({
          label: "usage agent event",
          log,
          callback: () => onAgentEvent({ stream: "usage", data }),
        });
      }
    },
    ...(annotateCurrentUserTurn ? { annotateCurrentUserTurn } : {}),
    ...media.capabilities,
    ...(trajectoryRecorder
      ? {
          trajectory: bindHarnessTrajectory(trajectoryRecorder, assertActive),
        }
      : {}),
    preparedEnvironment: () => {
      assertActive();
      return preparedRunEnvironment;
    },
    activeComputerContext: () => {
      assertActive();
      return buildActiveNodeContextText(requesterProfileId);
    },
    bindToolSurface,
    createToolSurface: (options, bindingOptions) => {
      warnPluginSdkDeprecation({
        family: "agent-harness-host",
        method: "createToolSurface",
        replacement: "createToolSurfaceAsync",
        compatibility: "Synchronous tool construction retains its pinned skill resources.",
      });
      const inputs = toolConstructionInputs(
        options,
        loadSkillLibrarySelection(skillResourceSnapshot(options)?.librarySelections ?? []),
      );
      return bindCreatedTools(
        withToolConstructionScope(() =>
          createOpenClawCodingToolsInternal(inputs.options, inputs.skillReadResources),
        ),
        bindingOptions,
      );
    },
    createToolSurfaceAsync: async (options, bindingOptions) => {
      const librarySelections = skillResourceSnapshot(options)?.librarySelections ?? [];
      const library = librarySelections.length
        ? await prepareHostSkillLibraryResources(librarySelections, assertActive)
        : undefined;
      const inputs = toolConstructionInputs(
        options,
        library?.entries ?? [],
        library?.assertCurrent,
      );
      const sourceTools = await withToolConstructionScope(() =>
        createOpenClawCodingToolsInternalAsync(
          inputs.options,
          inputs.skillReadResources,
          undefined,
          undefined,
          {
            assertCurrent: library?.assertCurrent ?? assertActive,
            signal: bindAbortSignal(attemptSignal),
          },
        ),
      );
      library?.assertPublicationCurrent();
      return bindCreatedTools(sourceTools, bindingOptions);
    },
    prepareMutableFileApproval: async (request) => {
      assertActive();
      const prepared = await prepareSystemRunMutableFileApproval(request);
      assertActive();
      if (!prepared.ok) {
        return prepared;
      }
      return Object.freeze({
        ok: true,
        requiresOneShot: prepared.requiresOneShot,
        revalidate: async () => {
          assertActive();
          const current = await prepared.revalidate();
          assertActive();
          return current;
        },
      });
    },
    runBeforeToolCall,
    requestApproval: async (request) => {
      assertActive();
      request.signal?.throwIfAborted();
      const releaseMcpBinding =
        request.mcpTool && request.toolCallId && request.isMcpToolApprovalActive && attempt.agentId
          ? registerMcpToolApprovalBinding({
              authority: delegatedAuthority,
              agentId: attempt.agentId,
              toolCallId: request.toolCallId,
              ...request.mcpTool,
              isActive: () => {
                assertActive();
                return !request.signal?.aborted && request.isMcpToolApprovalActive!();
              },
            })
          : undefined;
      try {
        const result = await withCaller(
          async () =>
            await withGatewayToolApprovalOwner(
              params.pluginId,
              async () =>
                await callGatewayTool(
                  "plugin.approval.request",
                  { timeoutMs: request.transportTimeoutMs ?? request.timeoutMs },
                  {
                    ...formatHarnessApprovalPresentation(request),
                    ...(request.detail !== undefined ? { detail: request.detail } : {}),
                    severity: request.severity,
                    toolName: request.toolName,
                    toolCallId: request.toolCallId,
                    ...(request.mcpTool ? { mcpTool: request.mcpTool } : {}),
                    timeoutMs: request.timeoutMs,
                    twoPhase: true,
                    ...(request.allowedDecisions
                      ? { allowedDecisions: request.allowedDecisions }
                      : {}),
                  },
                  { expectFinal: false, requireAgentRuntimeIdentity: true, signal: request.signal },
                ),
            ),
          request.signal,
        );
        // Gateway approval calls may outlive their owning attempt. A late
        // request result must not escape after exact authority has closed.
        assertActive();
        request.signal?.throwIfAborted();
        return result;
      } finally {
        releaseMcpBinding?.();
      }
    },
    waitForApproval: async (request) => {
      assertActive();
      const result = await withCaller(
        async () =>
          await callGatewayTool<{ id?: string } & Partial<AgentHarnessHostApprovalResult>>(
            "plugin.approval.waitDecision",
            { timeoutMs: request.transportTimeoutMs ?? request.timeoutMs },
            { id: request.approvalId },
            { signal: request.signal },
          ),
        request.signal,
      );
      // An allowed decision is useful only while this exact admitted owner is
      // still live; fail closed if closure raced the awaited Gateway result.
      assertActive();
      if (result?.id !== request.approvalId) {
        return undefined;
      }
      return {
        decision: result.decision,
        terminalReason: result.terminalReason,
      };
    },
  });
  registerAgentHarnessScheduledToolProjectionCapability({
    hostCapabilities: capabilities,
    ownerPluginId: params.pluginId,
    create: (sourceTool, projection) => {
      assertActive();
      const source = scheduledToolSources.get(sourceTool);
      if (
        !source ||
        sourceTool.name !== source.targetTool ||
        sourceTool.execute !== source.execute
      ) {
        throw new Error("scheduled tool projection source was not created by this host capability");
      }
      return createCronScheduledToolProjection(
        sourceTool,
        assertActive,
        source.targetTool,
        projection,
      );
    },
  });
  registerAgentHarnessTtsProvenanceTransferCapability({
    hostCapabilities: capabilities,
    ownerPluginId: params.pluginId,
    transfer: (toolResult, attemptResult, eligibleMediaUrls) => {
      assertActive();
      if (
        typeof toolResult !== "object" ||
        toolResult === null ||
        !coreTtsToolResults.has(toolResult)
      ) {
        return attemptResult;
      }
      return transferCoreTtsToolResultProvenance(
        toolResult,
        attemptResult,
        eligibleMediaUrls,
        operationalRunInstance,
      );
    },
  });
  return {
    capabilities,
    setInputAttachmentReadAllowed: media.setInputAttachmentReadAllowed,
    runWithScope: (run) => {
      const preparedCaller = getGatewayToolCallerIdentity();
      if (preparedCaller?.operationalRunInstance === operationalRunInstance) {
        personalToolParticipants ??= preparedCaller.personalToolParticipants;
        if (callerIdentity && personalToolParticipants) {
          callerIdentity.personalToolParticipants = personalToolParticipants;
        }
      }
      const nodeAuthorities = createSessionNodeAuthorities(
        attempt,
        params.pluginId,
        requiredNodeCommands,
        assertActive,
        bindAbortSignal(attempt.abortSignal),
      );
      return withPluginRuntimeGatewayRequestScope(
        {
          isWebchatConnect: () => false,
          ...getPluginRuntimeGatewayRequestScope(),
          ...nodeAuthorities,
        },
        run,
      );
    },
    close: () => {
      if (!active) {
        return;
      }
      active = false;
      capabilityAbortController.abort();
    },
  };
}
