import {
  assembleHarnessContextEngine,
  CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
  embeddedAgentLog,
  formatErrorMessage,
  resolveAgentHarnessBeforePromptBuildResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildCodexSystemPromptReport,
  prependCodexOpenClawPromptContext,
  readContextEngineThreadBootstrapProjection,
  resolveCodexDeliveryHintPreservedInputRange,
  resolveContextEngineBootstrapProjectionDecision,
} from "./attempt-context.js";
import { isNonEmptyString } from "./attempt-workspace-context.js";
import {
  CODEX_TURN_START_TEXT_INPUT_MAX_CHARS,
  fitCodexProjectedContextForTurnStart,
  CodexContextAttachmentError,
  isCodexDurableCustomMessage,
  projectContextEngineAssemblyForCodex,
  type CodexProjectedImageGroup,
  type CodexProjectedContextRange,
} from "./context-engine-projection.js";
import { joinPresentSections } from "./developer-instruction-sections.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
import type { CodexAttemptContext } from "./run-attempt-context.js";
import { estimateCodexAppServerProjectedTurnTokens } from "./run-attempt-lifecycle.js";
import { prependCurrentInboundContext } from "./run-attempt-state.js";
import { rotateOversizedCodexAppServerStartupBinding } from "./startup-binding.js";
import { buildContextEngineBinding } from "./thread-context-engine.js";
import {
  codexDynamicToolsFingerprint,
  codexLegacyDynamicToolsFingerprint,
} from "./thread-fingerprints.js";
import { hasCodexMirrorOrigin } from "./transcript-mirror-attestation.js";
import {
  buildCodexHistoryProvenancePrefix,
  buildCodexParentLocalInstructions,
  buildTurnCollaborationMode,
} from "./turn-params.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";

export async function prepareCodexAttemptPrompt(context: CodexAttemptContext) {
  const {
    runtime,
    attemptTools,
    historyState,
    hookContext,
    workspaceBootstrapContext,
    buildActiveContextEngineRuntimeContext,
    baseDeveloperInstructions,
    buildOpenClawPromptContext,
    skillsInstructions,
    refreshableInstructions,
    promptState,
    codexContextProjectionMaxChars,
    codexContinuityProjectionMaxChars,
  } = context;
  const {
    connection,
    runtimeParams,
    effectiveContextTokenBudget,
    effectiveRuntimeModelId,
    effectiveRuntimeProviderId,
  } = runtime;
  const {
    params,
    activeContextEngine,
    usesSupervisionConnection,
    mutable,
    isInactiveThreadBootstrapBinding,
    bindingStore,
    bindingIdentity,
    agentDir,
    appServer,
    contextSessionKey,
    effectiveWorkspace,
    sandbox,
  } = connection;
  const { toolBridge } = attemptTools;
  const nativeHistoryProvenancePrefix =
    params.trigger === "user" ? buildCodexHistoryProvenancePrefix(params) : undefined;
  const forkedSession =
    !mutable.startupBinding?.threadId && params.sessionTarget
      ? getSessionEntry({
          ...params.sessionTarget,
          sessionKey: contextSessionKey,
          hydrateSkillPromptRefs: false,
          readConsistency: "latest",
        })
      : undefined;
  // A copied spawn transcript promises completed tool evidence to this child.
  const preserveForkedToolResults = Boolean(
    forkedSession?.sessionId === params.sessionId &&
    forkedSession.createdVia === "spawn" &&
    forkedSession.parentSessionKey &&
    forkedSession.parentSessionKey !== contextSessionKey &&
    forkedSession.forkSource?.sessionKey === forkedSession.parentSessionKey &&
    forkedSession.forkSource.sessionId !== params.sessionId,
  );
  let contextImageGroups: CodexProjectedImageGroup[] = [];
  let turnContextImageGroups: CodexProjectedImageGroup[] = [];
  const assertProjectionCurrent = () => {
    params.hostCapabilities.assertActive();
    connection.assertCurrent();
    connection.runAbortController.signal.throwIfAborted();
  };
  const inputAttachmentNote = await connection.prepareInputAttachments({
    maxChars: Math.max(
      0,
      CODEX_TURN_START_TEXT_INPUT_MAX_CHARS -
        (nativeHistoryProvenancePrefix?.length ?? 0) -
        params.prompt.length -
        2,
    ),
    assertCurrent: assertProjectionCurrent,
    signal: connection.runAbortController.signal,
  });
  assertProjectionCurrent();
  const admittedMessage =
    params.userTurnTranscriptRecorder?.message ??
    (await params.userTurnTranscriptRecorder?.resolveMessage());
  assertProjectionCurrent();
  // A refreshed native thread receives the original admitted user as historical context.
  const currentUserTurnIdempotencyKey = params.pluginRuntimeRefreshMessages
    ? undefined
    : admittedMessage?.idempotencyKey;
  const prepareFileContext: NonNullable<
    Parameters<typeof projectContextEngineAssemblyForCodex>[0]["prepareFileContext"]
  > = async (message, maxChars) => {
    // Older hosts retain ordinary text history, but cannot claim restored attachments.
    const prepare = params.hostCapabilities.prepareContextMedia;
    if (!prepare) {
      const media = asOptionalRecord(Reflect.get(message, "__openclaw"))?.media;
      if (
        (Array.isArray(media) && media.length) ||
        (message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === "image"))
      ) {
        throw new CodexContextAttachmentError(
          "Saved attachments require a newer OpenClaw host. Update the Gateway and Codex plugin together, then retry.",
        );
      }
      return { images: [] };
    }
    try {
      const files = await prepare({ message, maxChars });
      assertProjectionCurrent();
      return files;
    } catch (error) {
      assertProjectionCurrent();
      throw new CodexContextAttachmentError(
        "Saved attachment preparation failed. Retry the request after checking the attachment source.",
        { cause: error },
      );
    }
  };
  const applyContinuityProjection = async (messages: typeof historyState.messages) => {
    const projection = await projectContextEngineAssemblyForCodex({
      assembledMessages: messages,
      prompt: params.prompt,
      maxRenderedContextChars: codexContinuityProjectionMaxChars,
      toolPayloadMode:
        params.pluginRuntimeRefreshMessages || preserveForkedToolResults ? "preserve" : "elide",
      prepareFileContext,
      currentUserTurnIdempotencyKey,
    });
    assertProjectionCurrent();
    contextImageGroups = projection.imageGroups ?? [];
    promptState.promptText = projection.promptText;
    promptState.promptContextRange = projection.promptContextRange;
    promptState.noEngineContinuityProjectionApplied = true;
  };
  const applyActiveContextEngineProjection = async (
    decisionStartupBinding: typeof mutable.startupBinding,
  ) => {
    if (!activeContextEngine) {
      return;
    }
    try {
      const assembled = await assembleHarnessContextEngine({
        contextEngine: activeContextEngine,
        sessionId: runtimeParams.sessionId,
        sessionKey: contextSessionKey,
        messages: historyState.messages,
        tokenBudget: effectiveContextTokenBudget,
        availableTools: new Set(
          flattenCodexDynamicToolFunctions(toolBridge.availableSpecs)
            .map((tool) => tool.name)
            .filter(isNonEmptyString),
        ),
        citationsMode: params.config?.memory?.citations,
        sandboxed: sandbox?.enabled === true,
        modelId: effectiveRuntimeModelId,
        contextEngineHostSupport: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
        providerId: effectiveRuntimeProviderId,
        requestedModelId: usesSupervisionConnection ? undefined : params.requestedModelId,
        fallbackReason: usesSupervisionConnection ? undefined : params.fallbackReason,
        degradedReason: usesSupervisionConnection ? undefined : params.degradedReason,
        runtimeContext: buildActiveContextEngineRuntimeContext(),
        transcriptReadFence: params.userTurnTranscriptRecorder?.getAdmissionReceipt(),
        prompt: params.prompt,
      });
      if (!assembled) {
        throw new Error("context engine assemble returned no result");
      }
      const contextEngineProjection = readContextEngineThreadBootstrapProjection(
        assembled.contextProjection,
      );
      const projectionDecision = contextEngineProjection
        ? resolveContextEngineBootstrapProjectionDecision({
            startupBinding: decisionStartupBinding,
            expectedBinding: buildContextEngineBinding(
              { ...runtimeParams },
              contextEngineProjection,
            ),
            projection: contextEngineProjection,
            dynamicToolsFingerprint: codexDynamicToolsFingerprint(toolBridge.specs),
            legacyDynamicToolsFingerprint: codexLegacyDynamicToolsFingerprint(toolBridge.specs),
          })
        : { project: true, reason: "per-turn-projection" };
      const projection = await projectContextEngineAssemblyForCodex({
        assembledMessages: assembled.messages,
        prompt: params.prompt,
        systemPromptAddition: assembled.systemPromptAddition,
        maxRenderedContextChars: codexContextProjectionMaxChars,
        toolPayloadMode:
          contextEngineProjection ||
          params.pluginRuntimeRefreshMessages ||
          preserveForkedToolResults
            ? "preserve"
            : "elide",
        ...(projectionDecision.project ? { prepareFileContext } : {}),
        currentUserTurnIdempotencyKey,
      });
      assertProjectionCurrent();
      contextImageGroups = projectionDecision.project ? (projection.imageGroups ?? []) : [];
      embeddedAgentLog.info("codex app-server context-engine projection decision", {
        sessionId: params.sessionId,
        sessionKey: contextSessionKey,
        engineId: activeContextEngine.info.id,
        mode: contextEngineProjection?.mode ?? assembled.contextProjection?.mode ?? "per_turn",
        epoch: contextEngineProjection?.epoch,
        fingerprint: contextEngineProjection?.fingerprint,
        previousThreadId: decisionStartupBinding?.threadId,
        previousEpoch: decisionStartupBinding?.contextEngine?.projection?.epoch,
        previousFingerprint: decisionStartupBinding?.contextEngine?.projection?.fingerprint,
        projected: projectionDecision.project,
        reason: projectionDecision.reason,
        assembledMessages: assembled.messages.length,
        originalHistoryMessages: historyState.messages.length,
        projectedPromptChars: projection.promptText.length,
        developerInstructionAdditionChars: projection.developerInstructionAddition?.length ?? 0,
      });
      // Projection metadata and rendered prompt must advance together or retries can skip context.
      promptState.contextEngineProjection = contextEngineProjection;
      promptState.promptText = projectionDecision.project ? projection.promptText : params.prompt;
      promptState.promptContextRange = projectionDecision.project
        ? projection.promptContextRange
        : undefined;
      promptState.developerInstructions = joinPresentSections(
        baseDeveloperInstructions,
        projection.developerInstructionAddition,
      );
    } catch (assembleErr) {
      if (
        assembleErr instanceof CodexContextAttachmentError ||
        params.pluginRuntimeRefreshMessages
      ) {
        throw assembleErr;
      }
      assertProjectionCurrent();
      embeddedAgentLog.warn("context engine assemble failed; using Codex baseline prompt", {
        error: formatErrorMessage(assembleErr),
      });
    }
  };
  if (activeContextEngine) {
    await applyActiveContextEngineProjection(
      runtime.nativeToolSurfaceEnabled ? mutable.startupBinding : undefined,
    );
  }
  // Refresh changes the transport prompt, but retains the admitted request's recorder.
  const buildPromptFromCurrentInputs = () =>
    resolveAgentHarnessBeforePromptBuildResult({
      currentUserMessage:
        admittedMessage ?? (params.pluginRuntimeRefreshMessages ? "" : params.prompt),
      prompt: prependCurrentInboundContext(promptState.promptText, params.currentInboundContext),
      developerInstructions: {
        build: ({ hasToolRestrictions }) => {
          if (hasToolRestrictions) {
            throw new Error(
              "Codex app-server cannot enforce before_prompt_build toolsAllow; use the embedded or Copilot runtime for turn-scoped tool policy.",
            );
          }
          return promptState.developerInstructions;
        },
      },
      messages: historyState.messages,
      ctx: hookContext,
      bootstrapContextRunKind: params.bootstrapContextRunKind,
      toolAuthority: {
        fingerprint: params.toolAuthorityFingerprint,
        activeToolNames: () =>
          flattenCodexDynamicToolFunctions(toolBridge.availableSpecs)
            .map((tool) => tool.name)
            .filter(isNonEmptyString),
        // Shipped prompt-hook capabilities revalidate synchronously after awaits.
        assertActive: connection.assertLegacyCurrent,
      },
    });
  const resolveShiftedPromptRanges = (
    prompt: string,
    promptInputRange: { start: number; end: number } | undefined,
    turnPromptText: string,
  ): {
    inputRange?: CodexProjectedContextRange;
    contextRange?: CodexProjectedContextRange;
    requestRange?: CodexProjectedContextRange;
  } => {
    if (
      !promptInputRange ||
      promptInputRange.start < 0 ||
      promptInputRange.end < promptInputRange.start ||
      promptInputRange.end > prompt.length ||
      !turnPromptText.endsWith(prompt)
    ) {
      return {};
    }
    const turnPromptOffset = turnPromptText.length - prompt.length;
    const inputRange = {
      start: turnPromptOffset + promptInputRange.start,
      end: turnPromptOffset + promptInputRange.end,
    };
    const promptTextInputOffset = promptInputRange.end - promptState.promptText.length;
    if (
      !promptState.promptContextRange ||
      promptTextInputOffset < promptInputRange.start ||
      prompt.slice(promptTextInputOffset, promptInputRange.end) !== promptState.promptText
    ) {
      return { inputRange };
    }
    const promptTextOffset = prompt.endsWith(promptState.promptText)
      ? prompt.length - promptState.promptText.length
      : promptTextInputOffset;
    const contextOffset = turnPromptOffset + promptTextOffset;
    const contextRange = {
      start: contextOffset + promptState.promptContextRange.start,
      end: contextOffset + promptState.promptContextRange.end,
    };
    return {
      inputRange,
      contextRange,
      requestRange: {
        start: contextRange.end,
        end: contextOffset + promptState.promptText.length,
      },
    };
  };
  const decorateCodexTurnPromptText = (
    promptBuildResult: {
      prompt: string;
      promptInputRange?: { start: number; end: number };
    },
    includeWorkspaceReferences = true,
  ) => {
    const turnPromptText = prependCodexOpenClawPromptContext(
      promptBuildResult.prompt,
      buildOpenClawPromptContext(includeWorkspaceReferences),
      {
        preservePromptWithoutContext:
          params.bootstrapContextMode === "lightweight" &&
          params.bootstrapContextRunKind === "cron",
      },
    );
    const projectedRanges = resolveShiftedPromptRanges(
      promptBuildResult.prompt,
      promptBuildResult.promptInputRange,
      turnPromptText,
    );
    const preservedRange =
      projectedRanges.inputRange ??
      resolveCodexDeliveryHintPreservedInputRange({
        prompt: promptBuildResult.prompt,
        promptInputRange: promptBuildResult.promptInputRange,
        decoratedPrompt: turnPromptText,
      });
    const imageOffset =
      projectedRanges.contextRange && promptState.promptContextRange
        ? projectedRanges.contextRange.start - promptState.promptContextRange.start
        : undefined;
    const inputLimit =
      CODEX_TURN_START_TEXT_INPUT_MAX_CHARS - (nativeHistoryProvenancePrefix?.length ?? 0);
    const requiredInputChars =
      turnPromptText.length -
      (projectedRanges.contextRange
        ? projectedRanges.contextRange.end - projectedRanges.contextRange.start
        : 0);
    // Optional paths may consume projected history, never current inbound or hook context.
    const attachmentNote =
      inputAttachmentNote && requiredInputChars + inputAttachmentNote.length + 2 <= inputLimit
        ? inputAttachmentNote
        : undefined;
    const fitted = fitCodexProjectedContextForTurnStart({
      promptText: turnPromptText,
      maxChars: inputLimit - (attachmentNote ? attachmentNote.length + 2 : 0),
      contextRange: projectedRanges?.contextRange,
      requestRange: projectedRanges?.requestRange,
      preservedRange,
      imageGroups:
        imageOffset === undefined
          ? []
          : contextImageGroups.map((group) => ({
              images: group.images,
              start: group.start + imageOffset,
              end: group.end + imageOffset,
            })),
    });
    turnContextImageGroups = fitted.imageGroups ?? [];
    return attachmentNote ? `${fitted.promptText}\n\n${attachmentNote}` : fitted.promptText;
  };
  const firstPromptBuild = await buildPromptFromCurrentInputs();
  const turnState = {
    promptBuild: firstPromptBuild,
    codexTurnPromptText: decorateCodexTurnPromptText(firstPromptBuild),
  };
  let parentLocalEgress = false;
  const parentLocalContext = {
    personaInstructions: workspaceBootstrapContext.personaInstructions,
    memoryInstructions: workspaceBootstrapContext.memoryInstructions,
  };
  // Observability view of the whole developer surface the model sees (reports,
  // trajectory, size estimates). The lifecycle receives the generic policy and the
  // refreshable instructions separately; joining them here must never feed thread requests.
  const buildRenderedCodexDeveloperInstructions = () =>
    joinPresentSections(
      turnState.promptBuild.developerInstructions,
      parentLocalEgress ? undefined : refreshableInstructions,
      (parentLocalEgress
        ? buildCodexParentLocalInstructions(params, { ...parentLocalContext, skillsInstructions })
        : buildTurnCollaborationMode(params).settings.developer_instructions) ?? undefined,
    );
  const rebuildCodexPromptBuildFromCurrentProjection = async () => {
    turnState.promptBuild = await buildPromptFromCurrentInputs();
    turnState.codexTurnPromptText = decorateCodexTurnPromptText(turnState.promptBuild);
  };
  const rebuildCodexTurnPromptTextFromCurrentProjection = async () => {
    const nextPromptBuild = await buildPromptFromCurrentInputs();
    turnState.promptBuild = {
      ...turnState.promptBuild,
      prompt: nextPromptBuild.prompt,
      promptInputRange: nextPromptBuild.promptInputRange,
    };
    turnState.codexTurnPromptText = decorateCodexTurnPromptText(nextPromptBuild);
  };
  const selectNewerVisibleHistoryAfterBinding = (
    binding: NonNullable<typeof mutable.startupBinding>,
  ) => {
    const cutoff = Date.parse(binding.historyCoveredThrough ?? "");
    return historyState.messages.filter((message) => {
      if (
        message.role !== "user" &&
        message.role !== "assistant" &&
        !isCodexDurableCustomMessage(message)
      ) {
        return false;
      }
      const mirrorIdentity = readMirrorIdentity(message);
      const timestamp =
        typeof message.timestamp === "number"
          ? message.timestamp
          : typeof message.timestamp === "string"
            ? Date.parse(message.timestamp)
            : Number.NaN;
      return (
        !(
          "idempotencyKey" in message &&
          typeof message.idempotencyKey === "string" &&
          message.idempotencyKey.startsWith("codex-app-server:")
        ) &&
        !hasCodexMirrorOrigin(message) &&
        !mirrorIdentity?.startsWith("codex-app-server:") &&
        Number.isFinite(timestamp) &&
        timestamp > (Number.isFinite(cutoff) ? cutoff : 0)
      );
    });
  };
  const applyResumeStaleBindingContinuityProjection = async (
    binding: NonNullable<typeof mutable.startupBinding>,
  ) => {
    const newerVisibleMessages = selectNewerVisibleHistoryAfterBinding(binding);
    if (newerVisibleMessages.length === 0) {
      return false;
    }
    await applyContinuityProjection(newerVisibleMessages);
    return true;
  };
  const precomputeNoContextEngineStaleBindingProjection = async () => {
    promptState.precomputedStaleBindingContinuityProjectionApplied = false;
    promptState.staleBindingContinuityForcedFreshStart = false;
    const binding = mutable.startupBinding;
    if (activeContextEngine || !binding?.threadId || binding.pendingSupervisionBranch) {
      return false;
    }
    if (isInactiveThreadBootstrapBinding(binding)) {
      promptState.inactiveThreadBootstrapBindingForcedFreshStart = true;
      return false;
    }
    const projected = await applyResumeStaleBindingContinuityProjection(binding);
    promptState.precomputedStaleBindingContinuityProjectionApplied = projected;
    return projected;
  };
  const applyNoContextEngineContinuityProjection = async (
    action: "started" | "resumed" | "forked",
    binding?: NonNullable<typeof mutable.startupBinding>,
  ) => {
    // A bounded history can retain an answer after its user turn falls outside the window.
    // Fresh threads need that text (or summaries), but tool-only suffixes are not continuity.
    // Resumed bindings hand off only newer local conversation and durable notes.
    const hasContinuity = historyState.messages.some(
      (message) =>
        message.role === "user" ||
        isCodexDurableCustomMessage(message) ||
        (action === "started" &&
          (message.role === "compactionSummary" ||
            message.role === "branchSummary" ||
            (message.role === "assistant" &&
              message.content.some((part) => part.type === "text" && part.text.trim())))),
    );
    if (activeContextEngine || (!hasContinuity && !params.pluginRuntimeRefreshMessages?.length)) {
      return false;
    }
    if (action === "resumed" && promptState.precomputedStaleBindingContinuityProjectionApplied) {
      return true;
    }
    if (action === "started" && promptState.staleBindingContinuityForcedFreshStart) {
      return true;
    }
    if (action === "started" && promptState.inactiveThreadBootstrapBindingForcedFreshStart) {
      return false;
    }
    if (action === "resumed" && binding) {
      return applyResumeStaleBindingContinuityProjection(binding);
    }
    if (action === "started") {
      await applyContinuityProjection(historyState.messages);
      return true;
    }
    return false;
  };
  if (await precomputeNoContextEngineStaleBindingProjection()) {
    await rebuildCodexPromptBuildFromCurrentProjection();
  }
  const rotateStartupBindingForProjectedTurn = async () => {
    const binding = mutable.startupBinding;
    if (!binding?.threadId) {
      return;
    }
    const previousThreadId = binding.threadId;
    const hadInactiveThreadBootstrapBinding = isInactiveThreadBootstrapBinding(binding);
    const startupBindingResolution = await rotateOversizedCodexAppServerStartupBinding({
      assertCurrent: connection.assertCurrent,
      authority: connection.authority,
      binding,
      bindingStore,
      identity: bindingIdentity,
      agentDir,
      codexHome: appServer.start.codexHome ?? appServer.start.env?.CODEX_HOME,
      config: params.config,
      contextEngineActive: Boolean(activeContextEngine),
      expectedSessionRuntimeOwnership: params.expectedSessionRuntimeOwnership,
      projectedTurnTokens: estimateCodexAppServerProjectedTurnTokens({
        prompt: turnState.codexTurnPromptText,
        developerInstructions: buildRenderedCodexDeveloperInstructions(),
      }),
    });
    mutable.startupBinding = startupBindingResolution.binding;
    mutable.startupContextTokens = startupBindingResolution.startupContextTokens;
    if (mutable.startupBinding?.threadId) {
      return;
    }
    promptState.inactiveThreadBootstrapBindingForcedFreshStart = hadInactiveThreadBootstrapBinding;
    promptState.staleBindingContinuityForcedFreshStart =
      promptState.precomputedStaleBindingContinuityProjectionApplied &&
      !promptState.inactiveThreadBootstrapBindingForcedFreshStart;
    if (promptState.staleBindingContinuityForcedFreshStart) {
      await applyContinuityProjection(historyState.messages);
    }
    if (activeContextEngine) {
      promptState.contextEngineProjection = undefined;
      await applyActiveContextEngineProjection(undefined);
    }
    await rebuildCodexPromptBuildFromCurrentProjection();
    embeddedAgentLog.info("codex app-server rebuilt turn prompt after native thread rotation", {
      sessionId: params.sessionId,
      sessionKey: contextSessionKey,
      previousThreadId,
      promptChars: turnState.codexTurnPromptText.length,
      developerInstructionChars: buildRenderedCodexDeveloperInstructions()?.length ?? 0,
    });
  };
  await rotateStartupBindingForProjectedTurn();
  const buildSystemPromptReport = (omitWorkspaceReferences = false) =>
    buildCodexSystemPromptReport({
      attempt: params,
      sessionKey: contextSessionKey,
      workspaceDir: effectiveWorkspace,
      developerInstructions: buildRenderedCodexDeveloperInstructions(),
      workspaceBootstrapContext,
      omitWorkspaceReferences,
      parentLocalEgress,
      skillsPrompt: skillsInstructions ? (params.skillsSnapshot?.prompt ?? "") : "",
      tools: toolBridge.availableSpecs,
    });
  const systemPromptReport = buildSystemPromptReport();
  let workspaceReferencesIncluded = true;
  return {
    context,
    get contextImageGroups() {
      return turnContextImageGroups;
    },
    nativeHistoryProvenancePrefix,
    turnState,
    refreshWorkspaceReferences: (include: boolean) => {
      turnState.codexTurnPromptText = decorateCodexTurnPromptText(turnState.promptBuild, include);
      if (include !== workspaceReferencesIncluded) {
        Object.assign(systemPromptReport, buildSystemPromptReport(!include));
        workspaceReferencesIncluded = include;
      }
    },
    setParentLocalEgress: () => {
      parentLocalEgress = true;
      Object.assign(systemPromptReport, buildSystemPromptReport(!workspaceReferencesIncluded));
    },
    buildRenderedCodexDeveloperInstructions,
    rebuildCodexTurnPromptTextFromCurrentProjection,
    applyNoContextEngineContinuityProjection,
    systemPromptReport,
  };
}

export type CodexAttemptPrompt = Awaited<ReturnType<typeof prepareCodexAttemptPrompt>>;
