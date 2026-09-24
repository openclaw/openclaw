import { createHash } from "node:crypto";
import type { AgentReasoningParam } from "openai/resources/beta/agents/agents";
import {
  buildCurrentInboundPrompt,
  createAgentHarnessAttemptCancellation,
  createAgentHarnessAttemptDeadlineController,
  createAgentHarnessAttemptLifecycle,
  emitAgentHarnessAttemptEvent,
  selectSupportedReasoningEffort,
  AgentHarnessProjectionSettlement,
  racePromiseWithAbortSignal,
  type AgentHarnessAttemptTimeout,
} from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import {
  agentHarnessAttemptTerminal,
  awaitAgentEndSideEffects,
  buildAgentHookContextChannelFields,
  buildEmbeddedForegroundPromptContext,
  clearActiveEmbeddedRun,
  embeddedAgentLog,
  formatErrorMessage,
  resolveAgentDir,
  runAgentEndSideEffects,
  runAgentHarnessLlmOutputHook,
  sanitizeToolArgs,
  setActiveEmbeddedRun,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import {
  resolveOpenAIModelReasoningEfforts,
  resolveOpenAIReasoningEffortMap,
  resolveOpenAIReasoningEffortMapping,
} from "openclaw/plugin-sdk/llm";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { AgentsApiClient } from "./agentsapi-client.js";
import { createAgentsApiMessageProjection } from "./agentsapi-messages.js";
import { createAgentsApiSession } from "./agentsapi-session.js";
import { buildAgentsApiToolSurface } from "./agentsapi-tools.js";
import { recordAgentsApiNativeToolTranscript } from "./agentsapi-transcript.js";

export async function runAgentsApiAttempt(
  params: AgentHarnessAttemptParamsV2,
  binding: import("./agentsapi-bindings.js").AgentsApiBinding | undefined,
  bind: (binding: import("./agentsapi-bindings.js").AgentsApiBinding) => Promise<void>,
  assertOwnerCurrent: () => void,
  assertHarnessCurrent: () => void,
  target: NonNullable<AgentHarnessAttemptParamsV2["sessionTarget"]> & {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  },
): Promise<AgentHarnessAttemptResult> {
  const startedAtMs = Date.now();
  const cancellationState = {
    explicitCancellationObserved: false,
    terminalOutcomeFrozen: false,
    sharedAbortAllowedAfterTerminalOutcome: false,
  };
  const cancellation = createAgentHarnessAttemptCancellation({
    upstreamSignal: params.abortSignal,
    onAttemptAbort: params.onAttemptAbort,
    state: cancellationState,
  });
  const { controller } = cancellation;
  const assertCurrent = () => {
    assertOwnerCurrent();
    controller.signal.throwIfAborted();
  };
  let finalizingProjection = false;
  let finalizingProjectionSignal: AbortSignal | undefined;
  const assertProjectionCurrent = () => {
    assertOwnerCurrent();
    if (finalizingProjection) {
      finalizingProjectionSignal?.throwIfAborted();
    } else {
      controller.signal.throwIfAborted();
    }
  };
  let lastToolError: AgentHarnessAttemptResult["lastToolError"];
  let toolTerminalObserved = false;
  const observeToolTerminal = params.observeToolTerminal;
  const runParams: AgentHarnessAttemptParamsV2 = observeToolTerminal
    ? {
        ...params,
        observeToolTerminal: (observation) => {
          assertProjectionCurrent();
          const resolution = observeToolTerminal(observation);
          assertProjectionCurrent();
          toolTerminalObserved = true;
          lastToolError = resolution.lastToolError;
          return resolution;
        },
      }
    : params;
  let timeout: AgentHarnessAttemptTimeout | undefined;
  let settling = false;
  let settlementDeadlineAtMs: number | undefined;
  const deadlines = createAgentHarnessAttemptDeadlineController({
    startedAtMs,
    timeoutMs: params.timeoutMs,
    settlementTimeoutMs: 30_000,
    signal: controller.signal,
    onDeadlineChanged: (deadline) => {
      if (settling && deadline.kind === "bounded") {
        settlementDeadlineAtMs = deadline.deadlineAtMs;
      }
      params.onAttemptDeadlineChanged?.(deadline);
    },
    onTimeout: (expired) => {
      timeout = expired;
      const error = new Error(`Agents API ${expired.kind} timed out`);
      params.onAttemptTimeout?.(error);
      cancellation.abortExplicitly(error);
    },
  });
  const beginSettlement = () => {
    settling = true;
    deadlines.beginSettlement(Date.now());
  };
  const emitEvent = (
    event: Parameters<NonNullable<AgentHarnessAttemptParamsV2["onAgentEvent"]>>[0],
  ) => emitAgentHarnessAttemptEvent(params, event, { label: "Agents API", log: embeddedAgentLog });
  const lifecycle = createAgentHarnessAttemptLifecycle({
    attempt: params,
    backend: "agentsapi",
    startedAtMs,
    state: { lifecycleStarted: false, lifecycleTerminalEmitted: false },
    emitEvent,
  });
  let native: ReturnType<typeof createAgentsApiSession> | undefined;
  let remoteSessionId = binding?.sessionId;
  let terminal: ReturnType<typeof agentHarnessAttemptTerminal.normalize> = { kind: "ok" };
  let reply: ReturnType<typeof createAgentsApiMessageProjection>["reply"] | undefined;
  let projection: ReturnType<typeof createAgentsApiMessageProjection> | undefined;
  let usageRecorded = false;
  let projectionClosed = false;
  const projectionSettlement = new AgentHarnessProjectionSettlement(
    runParams,
    () => {
      if (projectionClosed || controller.signal.aborted) {
        return false;
      }
      try {
        assertOwnerCurrent();
        return true;
      } catch {
        return false;
      }
    },
    { label: "Agents API" },
  );
  let terminalTurnId: string | undefined;
  const toolCleanups: Array<(reason: string) => Promise<void>> = [];
  let toolSurface: ReturnType<typeof buildAgentsApiToolSurface> | undefined;
  let startedToolCount = 0;
  let completedToolCount = 0;
  const handle = {
    kind: "embedded",
    toolAuthorityFingerprint: params.toolAuthorityFingerprint,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
    supportsTranscriptCommitWait: true,
    runId: params.runId,
    startedAtMs,
    queueMessage: async (text, options) => {
      assertCurrent();
      if (!native?.isAvailable()) {
        throw new Error("Agents API turn is not ready for steering");
      }
      if (options?.images?.length) {
        throw new Error("Agents API MVP accepts text steering only");
      }
      await options?.userTurnTranscriptRecorder?.persistApproved();
      assertCurrent();
      await native.queueMessage(
        buildCurrentInboundPrompt({ context: options?.currentInboundContext, prompt: text }),
      );
      options?.userTurnTranscriptRecorder?.markSentToProvider?.();
    },
    isStreaming: () => native?.isAvailable() ?? false,
    isStopped: () => controller.signal.aborted || (native?.isSettled() ?? false),
    isAborted: () => controller.signal.aborted,
    isCompacting: () => false,
    abort: () => cancellation.abortExplicitly(new Error("Agents API turn interrupted")),
    cancel: () => cancellation.abortExplicitly(new Error("Agents API turn interrupted")),
  } satisfies Parameters<typeof setActiveEmbeddedRun>[1];
  try {
    params.replyOperation?.attachBackend(handle);
    setActiveEmbeddedRun(
      params.sessionId,
      handle,
      params.sessionKey,
      params.sessionFile,
      params.agentId,
    );
    assertCurrent();
    const surface = buildAgentsApiToolSurface(
      runParams,
      controller.signal,
      assertCurrent,
      (cleanup) => toolCleanups.push(cleanup),
    );
    toolSurface = surface;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([params.model.id, params.resolvedApiKey, surface.declarations]))
      .digest("hex");
    if (binding && binding.authFingerprint !== fingerprint) {
      throw new Error(
        "Agents API model, credential, or tool surface changed; reset the OpenClaw session before continuing",
      );
    }
    const client = new AgentsApiClient(params.resolvedApiKey!, assertOwnerCurrent);
    const reasoningEffort = resolveAgentsApiReasoningEffort(params);
    if (!remoteSessionId) {
      remoteSessionId = await client.create(
        controller.signal,
        [
          "You are the OpenClaw assistant. Use your hosted Linux workspace for commands and files.",
          "OpenClaw functions run in the Gateway and use its workspace; your hosted VM owns shell commands and VM files.",
          "Apps, connectors, file transfers, and image generation are unavailable.",
          params.extraSystemPrompt,
        ]
          .filter(Boolean)
          .join("\n\n"),
        params.model.id,
        {
          functions: surface.declarations,
          reasoning: {
            effort: reasoningEffort,
            ...(params.reasoningLevel && params.reasoningLevel !== "off"
              ? { summary: "auto" }
              : {}),
          },
        },
      );
      assertCurrent();
      await bind({ sessionId: remoteSessionId, authFingerprint: fingerprint });
    } else {
      await client.setReasoningEffort(remoteSessionId, reasoningEffort, controller.signal);
      assertCurrent();
    }
    projection = createAgentsApiMessageProjection(
      projectionSettlement.params,
      remoteSessionId,
      async (event) => {
        assertCurrent();
        await emitEvent(event);
        assertCurrent();
      },
      assertProjectionCurrent,
    );
    reply = projection.reply;
    native = createAgentsApiSession({
      client,
      // Admitted hosted work must still be retired when host run authority closes.
      cleanupClient: new AgentsApiClient(params.resolvedApiKey!, assertHarnessCurrent),
      sessionId: remoteSessionId,
      signal: controller.signal,
      assertCurrent,
      onSettled: beginSettlement,
      onReconcile: (turn, items) =>
        projection!.reconcile(turn, items, { presentation: !finalizingProjection }),
      onUsageError: (error) =>
        embeddedAgentLog.warn("Agents API token accounting unavailable", { error }),
      onTranscriptOrderingGap: () => projection!.reportTranscriptOrderingGap(),
      onReconcileHistory: async (entries) => {
        for (const { turn, items } of entries) {
          for (const item of items) {
            assertProjectionCurrent();
            await recordAgentsApiNativeToolTranscript(
              runParams,
              remoteSessionId!,
              turn.id,
              item,
              assertProjectionCurrent,
              Date.now,
              { enclosingStatus: turn.status },
            );
            assertProjectionCurrent();
          }
        }
      },
      executeFunction: async (call) => {
        startedToolCount++;
        await emitEvent({
          stream: "tool",
          data: {
            phase: "start",
            name: call.name,
            toolCallId: call.call_id,
            args: asOptionalRecord(sanitizeToolArgs(call.arguments)),
          },
        });
        assertCurrent();
        const result = await surface.execute(call);
        assertCurrent();
        projection!.recordGatewayTranscriptReceipt(call.turn_id, call.call_id);
        return result;
      },
      onFunctionResult: async (call, result) => {
        completedToolCount++;
        await emitEvent({
          stream: "tool",
          data: {
            phase: "result",
            name: call.name,
            toolCallId: call.call_id,
            isError: !result.success,
            result: {
              content: [{ type: "text", text: result.success ? result.output : result.error }],
            },
          },
        });
        assertCurrent();
      },
      onEvent: async (event) => {
        await projection!.observe(event);
        assertCurrent();
        params.onRunProgress?.({
          reason: event.type,
          provider: "openai",
          model: params.model.id,
          backend: "agentsapi",
        });
      },
    });
    lifecycle.emitLifecycleStart({ provider: "openai", model: params.model.id });
    const result = await native.run(
      buildCurrentInboundPrompt({ context: params.currentInboundContext, prompt: params.prompt }),
      async () => {
        await params.userTurnTranscriptRecorder?.persistApproved();
      },
      () => params.userTurnTranscriptRecorder?.markSentToProvider?.(),
    );
    // A terminal root turn is insufficient: run() also waits for native session idle.
    terminalTurnId = result.turn.id;
    const turns = await native.readUsageTurns();
    assertCurrent();
    projection.recordUsage(params.model, turns);
    usageRecorded = true;
    params.hostCapabilities.reportOutputTokens?.(reply.usage?.output ?? 0);
    if (result.cancelled) {
      terminal = { kind: "aborted", source: "runtime" };
    } else if (!result.terminatedByTool) {
      const items = await client.items(remoteSessionId, result.turn.id, controller.signal);
      assertCurrent();
      await projection.commit(result.turn, items);
      assertCurrent();
    }
  } catch (error) {
    terminal = timeout
      ? { kind: "timeout", phase: "prompt", source: "runtime", aborted: true }
      : params.abortSignal?.aborted
        ? { kind: "aborted", source: "external" }
        : cancellationState.explicitCancellationObserved
          ? { kind: "aborted", source: "runtime" }
          : { kind: "failed", source: "prompt", error };
    if (terminal.kind === "failed") {
      embeddedAgentLog.warn("Agents API session failed", { error });
    }
  } finally {
    beginSettlement();
    // Reuse the owner's absolute settlement boundary. After an upstream abort
    // closes that owner, one cleanup budget starts before native retirement.
    const cleanupMs = Math.max(
      0,
      Math.min(30_000, (settlementDeadlineAtMs ?? Date.now() + 30_000) - Date.now()),
    );
    const cleanupSignal =
      cleanupMs > 0
        ? AbortSignal.timeout(cleanupMs)
        : AbortSignal.abort(new Error("Agents API settlement timed out"));
    try {
      // Retirement retains the native binding lease until admitted POST/cancel
      // work settles under its API timeouts; early release could cancel a successor.
      await native?.close();
    } catch (error) {
      terminal = { kind: "failed", source: "prompt", error };
    }
    try {
      if (native && projection && !usageRecorded) {
        const turns = await native.readUsageTurns();
        assertHarnessCurrent();
        projection.recordUsage(params.model, turns);
        usageRecorded = true;
      }
    } catch (error) {
      terminal = { kind: "failed", source: "prompt", error };
    }
    if ((controller.signal.aborted || terminal.kind !== "ok") && native && projection) {
      let ownerCurrent = false;
      try {
        assertOwnerCurrent();
        ownerCurrent = true;
      } catch {
        // Retired authority cannot publish evidence into a successor session.
      }
      if (ownerCurrent) {
        finalizingProjection = true;
        finalizingProjectionSignal = cleanupSignal;
        try {
          await native.reconcileAfterClose(cleanupSignal);
        } catch (error) {
          embeddedAgentLog.warn("Agents API terminal history reconciliation failed", { error });
        } finally {
          finalizingProjection = false;
          finalizingProjectionSignal = undefined;
        }
      }
    }
    try {
      await racePromiseWithAbortSignal(projectionSettlement.drain(), cleanupSignal);
    } catch (error) {
      if (!controller.signal.aborted) {
        terminal = { kind: "failed", source: "prompt", error };
      }
    }
    projectionClosed = true;
    if (timeout) {
      terminal = { kind: "timeout", phase: "prompt", source: "runtime", aborted: true };
    } else if (terminal.kind === "ok" && controller.signal.aborted) {
      terminal = { kind: "aborted", source: params.abortSignal?.aborted ? "external" : "runtime" };
    }
    cancellation.freezeTerminalOutcome();
    deadlines.dispose();
    cancellation.dispose();
    controller.abort();
    for (const cleanup of toolCleanups.toReversed()) {
      try {
        await cleanup("Agents API attempt settled");
      } catch (error) {
        embeddedAgentLog.warn("Agents API tool cleanup failed", { error });
      }
    }
    clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
    lifecycle.emitLifecycleTerminal({ phase: terminal.kind === "failed" ? "error" : "end" });
  }
  const result: AgentHarnessAttemptResult = {
    terminal,
    sessionIdUsed: params.sessionId,
    sessionFileUsed: params.sessionFile,
    agentHarnessId: "agentsapi",
    messagesSnapshot: SessionManager.open(target, params.workspaceDir).buildSessionContext()
      .messages,
    assistantTexts:
      reply?.lastAssistant?.content
        .filter((part) => part.type === "text")
        .map((part) => part.text) ?? [],
    lastAssistant: reply?.lastAssistant,
    currentAttemptAssistant: reply?.lastAssistant,
    currentAttemptCompletedAssistant: reply?.lastAssistant,
    assistantTranscriptOwned: Boolean(reply?.lastAssistant),
    assistantTranscriptIdempotencyKey:
      reply?.lastAssistant && terminalTurnId
        ? `agentsapi:${remoteSessionId}:${terminalTurnId}`
        : undefined,
    toolMetas: [...(projection?.toolMetas ?? []), ...(toolSurface?.toolMetas ?? [])],
    lastToolError: toolTerminalObserved
      ? lastToolError
      : (toolSurface?.lastToolError ?? projection?.lastToolError),
    ...toolSurface?.runtimeFacts,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    ...toolSurface?.delivery,
    cloudCodeAssistFormatError: false,
    attemptUsage: projection?.tokenUsage,
    agentHarnessResultClassification: projection?.resultClassification,
    replayMetadata: {
      hadPotentialSideEffects: native?.wasSubmitted() ?? false,
      replaySafe: !native?.wasSubmitted(),
    },
    itemLifecycle: {
      startedCount: startedToolCount + (projection?.itemLifecycle.startedCount ?? 0),
      completedCount: completedToolCount + (projection?.itemLifecycle.completedCount ?? 0),
      activeCount:
        Math.max(0, startedToolCount - completedToolCount) +
        (projection?.itemLifecycle.activeCount ?? 0),
    },
  };
  assertHarnessCurrent();
  const contextWindow = {
    contextTokenBudget: params.contextWindowInfo?.tokens ?? params.contextTokenBudget,
    contextWindowSource: params.contextWindowInfo?.source,
    contextWindowReferenceTokens: params.contextWindowInfo?.referenceTokens,
  };
  const hookContext = {
    runId: params.runId,
    agentId: target.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    modelProviderId: params.provider,
    modelId: params.model.id,
    trigger: params.trigger,
    inputProvenance: params.inputProvenance,
    ...buildAgentHookContextChannelFields(params),
    channelContext: params.channelContext,
    ...contextWindow,
  };
  runAgentHarnessLlmOutputHook({
    event: {
      runId: params.runId,
      sessionId: params.sessionId,
      provider: params.provider,
      model: params.model.id,
      resolvedRef: `${params.provider}/${params.model.id}`,
      harnessId: "agentsapi",
      prompt: params.prompt,
      ...contextWindow,
      assistantTexts: result.assistantTexts,
      lastAssistant: result.lastAssistant,
      usage: result.attemptUsage,
    },
    ctx: hookContext,
  });
  const agentEnd = {
    event: {
      runId: params.runId,
      messages: result.messagesSnapshot,
      success: terminal.kind === "ok",
      error: terminal.kind === "failed" ? formatErrorMessage(terminal.error) : undefined,
      durationMs: Date.now() - startedAtMs,
    },
    ctx: {
      ...hookContext,
      config: params.config,
      foregroundPromptContext: buildEmbeddedForegroundPromptContext(
        { ...params, agentId: target.agentId },
        params.agentDir ?? resolveAgentDir(params.config ?? {}, target.agentId),
      ),
      skillWorkshopAvailable: false,
      compacted: false,
    },
  };
  if (!params.messageChannel && !params.messageProvider) {
    await awaitAgentEndSideEffects(agentEnd);
  } else {
    runAgentEndSideEffects(agentEnd);
  }
  return result;
}

function resolveAgentsApiReasoningEffort(
  params: Pick<AgentHarnessAttemptParamsV2, "model" | "thinkLevel">,
): AgentReasoningParam["effort"] {
  if (params.thinkLevel === "ultra") {
    throw new Error("Agents API MVP does not support the ultra delegation mode");
  }
  if (params.thinkLevel === "adaptive") {
    return undefined;
  }
  const supportedEfforts = resolveOpenAIModelReasoningEfforts(params.model);
  const modelMapped = params.model.thinkingLevelMap?.[params.thinkLevel];
  if (!params.model.reasoning || supportedEfforts?.length === 0 || modelMapped === null) {
    return undefined;
  }
  const mapped =
    resolveOpenAIReasoningEffortMapping(
      params.thinkLevel,
      resolveOpenAIReasoningEffortMap(params.model),
    ) ?? modelMapped;
  const effort = mapped?.trim() ?? (params.thinkLevel === "off" ? "none" : params.thinkLevel);
  switch (effort) {
    case "none":
      return supportedEfforts?.includes("none") ? effort : undefined;
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return supportedEfforts === undefined
        ? effort
        : selectSupportedReasoningEffort({
            requested: effort,
            supportedEfforts,
            effortOrder: ["minimal", "low", "medium", "high", "xhigh", "max"] as const,
          });
    default:
      throw new Error(`Agents API does not support reasoning effort ${effort}`);
  }
}
