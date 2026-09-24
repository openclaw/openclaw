import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  interruptCodexTurnAndWaitBestEffort,
  retireUnsafeCodexTurnClientBestEffort,
} from "./attempt-client-cleanup.js";
import {
  createCodexModelCallDiagnosticEmitter,
  utf8JsonByteLength,
} from "./attempt-diagnostics.js";
import {
  assertCodexSessionRuntimeOwnership,
  requireCodexSupervisionModelSelection,
} from "./binding-connection.js";
import { prepareCodexWorkspaceReferences } from "./client-runtime.js";
import { isCodexAppServerIndeterminateRequestCancellationError } from "./client.js";
import { resolveCodexExplicitSkillInputs } from "./explicit-skill-input.js";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { getCodexInferenceThread } from "./inference-routing.js";
import { readCodexRuntimeModelId } from "./model-runtime.js";
import { assertCodexTurnStartResponse } from "./protocol-validators.js";
import type { CodexTurnStartResponse } from "./protocol.js";
import { prepareCodexProviderReviewContinuation } from "./provider-review-continuation.js";
import { readCodexRateLimitsRevision } from "./rate-limit-cache.js";
import {
  emitCodexAppServerEvent,
  withCodexAppServerFastModeServiceTier,
} from "./run-attempt-lifecycle.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import { joinPresentSections } from "./run-attempt-state.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import { buildTurnStartParams } from "./thread-lifecycle.js";
import { recordCodexTrajectoryContext } from "./trajectory.js";
import { buildCodexUserPromptMessage } from "./transcript-mirror.js";
import { buildCodexParentLocalInstructions } from "./turn-params.js";

export type CodexStartedTurn = {
  turn: CodexTurnStartResponse;
  upstreamUserText: string;
};

export async function prepareCodexAttemptTurnRequest(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  ensureCurrentThreadRoute: () => Promise<unknown>,
  waitForActiveNativeTurnCompletion: () => Promise<boolean>,
) {
  const { prompt, state: resourceState, releaseCurrentRoute } = resources;
  const {
    context,
    turnState,
    buildRenderedCodexDeveloperInstructions,
    nativeHistoryProvenancePrefix,
  } = prompt;
  const { runtime, attemptTools, hookContextWindowFields, workspaceBootstrapContext } = context;
  const { connection, runtimeParams, effectiveRuntimeProviderId, effectiveRuntimeModelId } =
    runtime;
  const { tools, toolBridge } = attemptTools;
  const {
    params,
    sessionAgentId,
    usesSupervisionConnection,
    codexModelCallId,
    codexModelCallTrace,
    codexModelContentCapture,
    appServer,
    runAbortController,
  } = connection;
  const { state } = turnRuntime;
  const explicitSkillInputs = await resolveCodexExplicitSkillInputs({
    client: resourceState.client,
    cwd: resourceState.codexExecutionCwd,
    selections: runtimeParams.explicitSkillSelections,
    signal: runAbortController.signal,
  });
  const buildCodexModelInputMessages = () => [
    ...prompt.codexModelInputHistoryMessages,
    buildCodexUserPromptMessage({ ...runtimeParams, prompt: turnState.codexTurnPromptText }),
  ];
  const codexModelCallDiagnostics = createCodexModelCallDiagnosticEmitter({
    baseFields: {
      runId: params.runId,
      agentId: sessionAgentId,
      callId: codexModelCallId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      sessionId: params.sessionId,
      provider: usesSupervisionConnection
        ? (resourceState.thread.modelProvider ?? effectiveRuntimeProviderId)
        : params.provider,
      model: usesSupervisionConnection
        ? (resourceState.thread.model ?? effectiveRuntimeModelId)
        : params.modelId,
      api: usesSupervisionConnection ? runtimeParams.model.api : params.model.api,
      transport: appServer.start.transport,
      observationUnit: "turn",
      ...hookContextWindowFields,
      trace: codexModelCallTrace,
    },
    capture: codexModelContentCapture,
    tools,
    buildInputMessages: buildCodexModelInputMessages,
    buildSystemPrompt: buildRenderedCodexDeveloperInstructions,
    onErrorDiagnostic: (error) => {
      embeddedAgentLog.debug("codex app-server model call diagnostic ended with error", {
        error: formatErrorMessage(error),
      });
    },
  });
  const throwIfTurnStartAcceptedAfterAbort = () => {
    if (!runAbortController.signal.aborted) {
      return;
    }
    const reason = runAbortController.signal.reason;
    if (reason instanceof Error) {
      throw reason;
    }
    const error = new Error(
      typeof reason === "string" && reason.length > 0
        ? reason
        : "codex app-server turn start aborted before acceptance",
    );
    error.name = "AbortError";
    throw error;
  };
  const prepareWorkspaceReferences = () => {
    const references = prepareCodexWorkspaceReferences(
      resourceState.client,
      resourceState.thread.threadId,
      workspaceBootstrapContext.promptContext,
    );
    prompt.refreshWorkspaceReferences(references.include);
    return references;
  };
  const startCodexTurn = async (): Promise<CodexStartedTurn> => {
    const activeTurnRoute = (await ensureCurrentThreadRoute()) as {
      armTurn(): void;
      cancelTurn(): Promise<void>;
    };
    // Resume may observe a newer native tuple after host auth was prepared. Keep
    // that truthful binding, but never infer with credentials selected for the old tuple.
    assertCodexSessionRuntimeOwnership(
      resourceState.thread,
      params.expectedSessionRuntimeOwnership,
    );
    // Each retry selects anew, but an accepted write must settle its original thread.
    const selectedThread = resourceState.thread;
    const { threadId, liveThreadOwnership, model, modelProvider } = selectedThread;
    const turnClient = resourceState.client;
    const nativeModel = usesSupervisionConnection
      ? requireCodexSupervisionModelSelection(selectedThread)
      : undefined;
    const assertTurnCurrent = () => {
      connection.assertCurrent();
      liveThreadOwnership?.assertCurrent();
      if (
        resourceState.thread !== selectedThread ||
        selectedThread.threadId !== threadId ||
        selectedThread.liveThreadOwnership !== liveThreadOwnership ||
        selectedThread.model !== model ||
        selectedThread.modelProvider !== modelProvider
      ) {
        throw new Error("Codex native model or thread ownership changed during turn start.");
      }
    };
    const turnAppServer = withCodexAppServerFastModeServiceTier(
      connection.mutable.pluginAppServer,
      runtimeParams,
    );
    connection.mutable.pluginAppServer = turnAppServer;
    const references = prepareWorkspaceReferences();
    const inferenceRoute = getCodexInferenceThread(
      resourceState.client,
      resourceState.thread.threadId,
    );
    const turnStartParams = buildTurnStartParams(runtimeParams, {
      threadId: resourceState.thread.threadId,
      cwd: resourceState.codexExecutionCwd,
      appServer: turnAppServer,
      promptText: turnState.codexTurnPromptText,
      historyProvenancePrefix: nativeHistoryProvenancePrefix,
      contextImageGroups: prompt.contextImageGroups,
      explicitSkillInputs,
      sandboxPolicy: resourceState.codexSandboxPolicy,
      environmentSelection: resourceState.codexEnvironmentSelection,
      clearInheritedServiceTier: resourceState.thread.clearInheritedServiceTier,
      ...(usesSupervisionConnection
        ? {}
        : {
            model: resourceState.thread.model,
            modelProvider: resourceState.thread.modelProvider,
          }),
      turnScopedDeveloperInstructions: workspaceBootstrapContext.turnScopedDeveloperInstructions,
      skillsCollaborationInstructions: context.skillsCollaborationInstructions,
      memoryCollaborationInstructions: workspaceBootstrapContext.memoryCollaborationInstructions,
      preserveNativeTurnSettings: usesSupervisionConnection,
      parentLocalEgress: inferenceRoute !== undefined,
      messageToolAvailable: toolBridge.availableTools.some((tool) => tool.name === "message"),
      requireExplicitMessageTarget: attemptTools.requireExplicitMessageTarget,
      sessionStatusAvailable: toolBridge.availableTools.some(
        (tool) => tool.name === "session_status",
      ),
    });
    // Prepared runtime mappings retain catalog authorization; a retry must
    // authorize the model actually encoded for the substituted turn.
    const authorizedModel = nativeModel
      ? { provider: nativeModel.modelProvider, model: nativeModel.model }
      : effectiveRuntimeModelId === readCodexRuntimeModelId(params.model, params.modelId)
        ? { provider: params.provider, model: params.modelId }
        : turnStartParams.model
          ? {
              provider: modelProvider ?? params.provider,
              model: turnStartParams.model,
            }
          : undefined;
    connection.bindModelExecution(authorizedModel);
    const nativeRequestModel = turnStartParams.model ?? model;
    const modelMapping =
      authorizedModel && nativeRequestModel
        ? {
            nativeModel: {
              provider: modelProvider ?? params.provider,
              model: nativeRequestModel,
            },
            authorizedModel,
          }
        : undefined;
    if (inferenceRoute) {
      if (!usesSupervisionConnection) {
        prompt.setParentLocalEgress();
      }
      resourceState.releaseInferenceContext?.();
      const inferenceThread = resourceState.thread;
      const registration = inferenceRoute.context.register({
        threadId: resourceState.thread.threadId,
        text: usesSupervisionConnection
          ? ""
          : (buildCodexParentLocalInstructions(runtimeParams, {
              turnScopedDeveloperInstructions:
                workspaceBootstrapContext.turnScopedDeveloperInstructions,
              skillsCollaborationInstructions: context.skillsCollaborationInstructions,
              memoryCollaborationInstructions:
                workspaceBootstrapContext.memoryCollaborationInstructions,
            }) ?? ""),
        signal: runAbortController.signal,
        assertCurrent: () => {
          params.hostCapabilities.assertActive();
          connection.assertCurrent();
          if (
            resourceState.thread !== inferenceThread ||
            getCodexInferenceThread(resourceState.client, inferenceThread.threadId) !==
              inferenceRoute
          ) {
            throw new Error("Codex inference thread ownership changed");
          }
          inferenceThread.liveThreadOwnership?.assertCurrent();
        },
      });
      resourceState.releaseInferenceContext = registration.release;
      turnStartParams.responsesapiClientMetadata = {
        ...turnStartParams.responsesapiClientMetadata,
        [CODEX_INFERENCE_GENERATION_KEY]: registration.generation,
      };
    } else if (!usesSupervisionConnection) {
      embeddedAgentLog.warn(
        "Codex parent-local egress workaround is unavailable for this connection or native network profile; legacy collaboration delivery is not guaranteed.",
      );
      prompt.systemPromptReport.source = "estimate";
      prompt.systemPromptReport.injectedWorkspaceFiles =
        prompt.systemPromptReport.injectedWorkspaceFiles.map((file) =>
          ["SOUL.MD", "IDENTITY.MD", "USER.MD"].includes(file.name.toUpperCase())
            ? {
                ...file,
                injectionStatus: "native_unverified",
                injectedChars: null,
                truncated: null,
              }
            : file,
        );
    }
    const continuation = await prepareCodexProviderReviewContinuation({
      acknowledgment: params.providerReviewAcknowledgment,
      client: resourceState.client,
      turnStartParams,
      provider: params.provider,
      model: params.modelId,
      api: runtimeParams.model.api,
      signal: runAbortController.signal,
      timeoutMs: params.timeoutMs,
      assertCurrent: assertTurnCurrent,
    });
    codexModelCallDiagnostics.setRequestPayloadBytes(utf8JsonByteLength(turnStartParams));
    recordCodexTrajectoryContext(resources.trajectoryRecorder, {
      attempt: params,
      cwd: connection.effectiveCwd,
      developerInstructions: joinPresentSections(
        buildRenderedCodexDeveloperInstructions(),
        attemptTools.configuredMcp?.diagnosticNotice,
      ),
      prompt: turnState.codexTurnPromptText,
      tools: toolBridge.availableSpecs,
    });
    state.latestStartupErrorNotification = undefined;
    state.rateLimitsRevisionBeforeLastTurnStart = readCodexRateLimitsRevision(resourceState.client);
    activeTurnRoute.armTurn();
    void emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: {
        phase: "turn_starting",
        threadId: resourceState.thread.threadId,
        model: params.modelId,
        effort: turnStartParams.effort,
        collaborationEffort: turnStartParams.collaborationMode?.settings.reasoning_effort,
        serviceTier: turnStartParams.serviceTier,
      },
    });
    let acceptedTurnId: string | undefined;
    const upstreamUserText = turnStartParams.input
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .join("\n");
    try {
      const startedTurn = assertCodexTurnStartResponse(
        await turnClient.request("turn/start", turnStartParams, {
          timeoutMs: params.timeoutMs,
          signal: runAbortController.signal,
          assertCurrent: () => {
            assertTurnCurrent();
            continuation?.dispatch();
          },
        }),
      );
      acceptedTurnId = startedTurn.turn.id;
      resources.nativeProcessAuthority?.bindTurn(turnClient, threadId, acceptedTurnId);
      assertTurnCurrent();
      resourceState.nativeSubagentMonitor?.bindTurn(acceptedTurnId, modelMapping);
      // Fitting may drop or truncate references; only acknowledge the complete block.
      if (upstreamUserText.includes(workspaceBootstrapContext.promptContext ?? "")) {
        references.accepted();
      }
      throwIfTurnStartAcceptedAfterAbort();
      await continuation?.accept(acceptedTurnId);
      return { turn: startedTurn, upstreamUserText };
    } catch (error) {
      if (acceptedTurnId || isCodexAppServerIndeterminateRequestCancellationError(error)) {
        // Codex serializes start/interrupt per thread; an empty id interrupts
        // the accepted native turn even when local cancellation hid its response.
        try {
          resourceState.startupClientUnsafe = !(await interruptCodexTurnAndWaitBestEffort(
            turnClient,
            { threadId, turnId: acceptedTurnId ?? "" },
          ));
          if (resourceState.startupClientUnsafe) {
            await retireUnsafeCodexTurnClientBestEffort(turnClient, "startup interrupt");
          }
        } finally {
          await releaseCurrentRoute();
        }
      } else {
        await activeTurnRoute.cancelTurn();
      }
      if (params.providerReviewAcknowledgment) {
        // oxlint-disable-next-line preserve-caught-error -- Native RPC errors can contain the submitted steer; continuation diagnostics must stay generic.
        throw new Error(
          "Could not continue this chat. Review its latest status before trying again.",
        );
      }
      throw error;
    } finally {
      continuation?.dispose();
    }
  };
  if (
    resourceState.thread.lifecycle.action === "resumed" &&
    (resourceState.thread.lifecycle.activeTurnIds?.length ?? 0) > 0
  ) {
    embeddedAgentLog.info(
      "codex app-server resumed thread has active native turn; waiting before turn/start",
      { threadId: resourceState.thread.threadId },
    );
    void emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: {
        phase: "turn_start_waiting_for_native_turn",
        threadId: resourceState.thread.threadId,
      },
    });
    const nativeTurnCompleted = await waitForActiveNativeTurnCompletion();
    if (nativeTurnCompleted) {
      await resourceState.turnRoute?.drain();
    } else if (!runAbortController.signal.aborted) {
      embeddedAgentLog.warn(
        "codex app-server active native turn did not complete before turn/start wait timed out",
        { threadId: resourceState.thread.threadId },
      );
    }
  }
  prepareWorkspaceReferences();
  const buildLlmInputEvent = () => ({
    runId: params.runId,
    sessionId: params.sessionId,
    provider: usesSupervisionConnection
      ? (resourceState.thread.modelProvider ?? effectiveRuntimeProviderId)
      : params.provider,
    model: usesSupervisionConnection
      ? (resourceState.thread.model ?? effectiveRuntimeModelId)
      : params.modelId,
    systemPrompt: buildRenderedCodexDeveloperInstructions(),
    prompt: turnState.codexTurnPromptText,
    historyMessages: prompt.codexModelInputHistoryMessages,
    imagesCount:
      prompt.contextImageGroups.reduce((count, group) => count + group.images.length, 0) +
      (params.images?.length ?? 0),
    tools,
  });
  const buildLlmOutputEvent = () => ({
    runId: params.runId,
    sessionId: params.sessionId,
    provider: usesSupervisionConnection
      ? (resourceState.thread.modelProvider ?? effectiveRuntimeProviderId)
      : params.provider,
    model: usesSupervisionConnection
      ? (resourceState.thread.model ?? effectiveRuntimeModelId)
      : params.modelId,
    ...hookContextWindowFields,
    resolvedRef: usesSupervisionConnection
      ? `${resourceState.thread.modelProvider ?? effectiveRuntimeProviderId}/${resourceState.thread.model ?? effectiveRuntimeModelId}`
      : (params.runtimePlan?.observability.resolvedRef ?? `${params.provider}/${params.modelId}`),
    ...(!usesSupervisionConnection && params.runtimePlan?.observability.harnessId
      ? { harnessId: params.runtimePlan.observability.harnessId }
      : {}),
  });
  return { codexModelCallDiagnostics, startCodexTurn, buildLlmInputEvent, buildLlmOutputEvent };
}
