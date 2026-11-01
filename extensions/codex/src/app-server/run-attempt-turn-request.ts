import {
  embeddedAgentLog,
  formatErrorMessage,
  runAgentHarnessLlmInputHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { CodexAccessProgramUnavailableError } from "./access-program.js";
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
import { recordCodexTurnForkSettings } from "./client-fork-settings.js";
import { prepareCodexWorkspaceReferences } from "./client-runtime.js";
import { isCodexAppServerIndeterminateRequestCancellationError } from "./client.js";
import { joinPresentSections } from "./developer-instruction-sections.js";
import { resolveCodexExplicitSkillInputs } from "./explicit-skill-input.js";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { getCodexInferenceThread } from "./inference-routing.js";
import { readCodexRuntimeModelId } from "./model-runtime.js";
import { listAllCodexAppServerModels } from "./models.js";
import { assertCodexTurnStartResponse } from "./protocol-validators.js";
import type { CodexGetAccountResponse, CodexTurnStartResponse } from "./protocol.js";
import { prepareCodexProviderReviewContinuation } from "./provider-review-continuation.js";
import { readCodexRateLimitsRevision } from "./rate-limit-cache.js";
import type { CodexAppServerScopedRequest } from "./request.js";
import {
  emitCodexAppServerEvent,
  withCodexAppServerFastModeServiceTier,
} from "./run-attempt-lifecycle.js";
import type { StartedCodexAttemptResources } from "./run-attempt-start.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import { buildCodexConversationTurnInstructions } from "./thread-prompt.js";
import { recordCodexTrajectoryContext } from "./trajectory.js";
import { buildCodexParentLocalInstructions, buildTurnStartParams } from "./turn-params.js";
import type { CodexThreadRouteReservation } from "./turn-router.js";
import { buildCodexUserPromptMessage } from "./user-prompt-message.js";

export type CodexStartedTurn = {
  turn: CodexTurnStartResponse;
  upstreamUserText: string;
};

export async function prepareCodexAttemptTurnRequest(
  resources: StartedCodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  ensureCurrentThreadRoute: () => Promise<
    Pick<CodexThreadRouteReservation, "armTurn" | "cancelTurn">
  >,
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
    buildCodexUserPromptMessage({ ...runtimeParams, prompt: turnState.codexTurnPromptText }),
  ];
  const buildModelCallIdentity = () => ({
    runId: params.runId,
    sessionId: params.sessionId,
    provider: usesSupervisionConnection
      ? (resourceState.thread.modelProvider ?? effectiveRuntimeProviderId)
      : params.provider,
    model: usesSupervisionConnection
      ? (resourceState.thread.model ?? effectiveRuntimeModelId)
      : params.modelId,
  });
  const codexModelCallDiagnostics = createCodexModelCallDiagnosticEmitter({
    baseFields: {
      ...buildModelCallIdentity(),
      agentId: sessionAgentId,
      callId: codexModelCallId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
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
    const activeTurnRoute = await ensureCurrentThreadRoute();
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
    let accessProgramIsCurrent: (() => boolean) | undefined;
    const nativeModel = usesSupervisionConnection
      ? requireCodexSupervisionModelSelection(selectedThread)
      : undefined;
    const assertTurnCurrent = () => {
      connection.assertCurrent();
      if (accessProgramIsCurrent?.() === false) {
        throw new Error(
          "Codex account changed while preparing the access program. Retry the turn.",
        );
      }
      liveThreadOwnership?.assertCurrent();
      if (
        resourceState.client !== turnClient ||
        resourceState.thread !== selectedThread ||
        selectedThread.threadId !== threadId ||
        selectedThread.liveThreadOwnership !== liveThreadOwnership ||
        selectedThread.model !== model ||
        selectedThread.modelProvider !== modelProvider
      ) {
        throw new Error("Codex native model or thread ownership changed during turn start.");
      }
    };
    const fastMode =
      typeof runtimeParams.fastMode === "function"
        ? runtimeParams.fastMode()
        : runtimeParams.fastMode;
    const turnAppServer = withCodexAppServerFastModeServiceTier(
      connection.mutable.pluginAppServer,
      { fastMode },
      connection.appServer,
    );
    const references = prepareWorkspaceReferences();
    const inferenceRoute = getCodexInferenceThread(
      resourceState.client,
      resourceState.thread.threadId,
    );
    const turnStartParams = await buildTurnStartParams(runtimeParams, {
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
      preserveNativeTurnSettings: usesSupervisionConnection,
      parentLocalEgress: inferenceRoute !== undefined,
      messageToolAvailable: toolBridge.availableTools.some((tool) => tool.name === "message"),
      requireExplicitMessageTarget: attemptTools.requireExplicitMessageTarget,
      sessionStatusAvailable: toolBridge.availableTools.some(
        (tool) => tool.name === "session_status",
      ),
    });
    if (
      turnStartParams.cyberAccessProgram !== undefined &&
      turnStartParams.cyberAccessProgram !== "standard"
    ) {
      // The managed Codex runtime supports explicit programs for both native
      // OpenAI account types; entitlement still comes from this client's catalog.
      const account = await turnClient.request<CodexGetAccountResponse>(
        "account/read",
        { refreshToken: false },
        { assertCurrent: assertTurnCurrent },
      );
      assertTurnCurrent();
      if (account.account?.type !== "chatgpt" && account.account?.type !== "apiKey") {
        throw new CodexAccessProgramUnavailableError(
          "Explicit Daybreak access in the Codex runtime requires an authenticated OpenAI account. Sign in or select Standard Access.",
        );
      }
      const accountRevision = turnClient.getModelCatalogRevision();
      accessProgramIsCurrent = () => turnClient.getModelCatalogRevision() === accountRevision;
      const catalog = await listAllCodexAppServerModels({
        request: <T>({ method, requestParams }: Parameters<CodexAppServerScopedRequest>[0]) =>
          turnClient.request<T>(method, requestParams, { assertCurrent: assertTurnCurrent }),
        includeHidden: true,
      });
      assertTurnCurrent();
      const selectedModel = turnStartParams.model ?? model;
      const advertised = catalog.models.find(
        (entry) => entry.model === selectedModel || entry.id === selectedModel,
      )?.availableAccessPrograms?.cyber;
      const program =
        turnStartParams.cyberAccessProgram === "daybreakBlue" ? "daybreak_blue" : "daybreak_red";
      if (!advertised?.includes(program)) {
        throw new CodexAccessProgramUnavailableError(
          "This Daybreak program is not advertised for the current account and model. Select Standard Access or refresh account capabilities.",
        );
      }
    }
    const serviceTier =
      fastMode === "ultrafast" ? selectedThread.preparedServiceTier : turnStartParams.serviceTier;
    assertTurnCurrent();
    turnStartParams.serviceTier = serviceTier;
    connection.mutable.pluginAppServer = { ...turnAppServer, serviceTier };
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
    connection.bindModelExecution(
      authorizedModel && {
        ...authorizedModel,
        cyberAccessProgram:
          turnStartParams.cyberAccessProgram === "daybreakBlue"
            ? "daybreak_blue"
            : turnStartParams.cyberAccessProgram === "daybreakRed"
              ? "daybreak_red"
              : "standard",
      },
    );
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
      resourceState.releaseInferenceContext?.();
      const inferenceThread = resourceState.thread;
      const inferenceInstructions = joinPresentSections(
        usesSupervisionConnection
          ? undefined
          : (buildCodexParentLocalInstructions(runtimeParams, {
              personaInstructions: workspaceBootstrapContext.personaInstructions,
              skillsInstructions: context.skillsInstructions,
              memoryInstructions: workspaceBootstrapContext.memoryInstructions,
            }) ?? undefined),
        turnState.promptBuild.turnDeveloperInstructions,
        buildCodexConversationTurnInstructions(
          runtimeParams,
          attemptTools.toolBridge.availableSpecs,
        ),
      );
      const registration = await inferenceRoute.context.register({
        threadId: resourceState.thread.threadId,
        text: inferenceInstructions,
        signal: runAbortController.signal,
        assertCurrent: () => {
          params.hostCapabilities.assertActive();
          connection.assertLegacyCurrent();
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
      prompt.setInferenceInstructions(inferenceInstructions);
      turnStartParams.responsesapiClientMetadata = {
        ...turnStartParams.responsesapiClientMetadata,
        [CODEX_INFERENCE_GENERATION_KEY]: registration.generation,
      };
    } else if (workspaceBootstrapContext.personaFiles?.some((file) => file.personalUser)) {
      embeddedAgentLog.warn(
        "Personal USER.md was omitted: this Codex connection has no parent-only inference relay. Shared workspace persona is still delivered.",
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
    runAgentHarnessLlmInputHook({
      event: buildLlmInputEvent(),
      ctx: context.hookContext,
      hookRunner: context.hookRunner,
    });
    recordCodexTrajectoryContext(resources.trajectoryRecorder, {
      attempt: params,
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
          withCurrent: (write) =>
            runtime.nativeExecutionPolicy.admit(write, connection.withCurrent),
          assertCurrent: () => {
            assertTurnCurrent();
            runtime.nativeExecutionPolicy.source?.();
            continuation?.dispatch();
          },
        }),
      );
      acceptedTurnId = startedTurn.turn.id;
      recordCodexTurnForkSettings(turnClient, turnStartParams);
      resources.nativeProcessAuthority?.bindTurn(turnClient, threadId, acceptedTurnId);
      assertTurnCurrent();
      resourceState.nativeSubagentMonitor?.bindTurn(acceptedTurnId, modelMapping);
      // Fitting may drop or truncate references; only acknowledge the complete block.
      if (upstreamUserText.includes(workspaceBootstrapContext.promptContext ?? "")) {
        references.accepted();
      }
      if (runAbortController.signal.aborted) {
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
      }
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
    ...buildModelCallIdentity(),
    systemPrompt: buildRenderedCodexDeveloperInstructions(),
    prompt: turnState.codexTurnPromptText,
    historyMessages: [],
    imagesCount:
      prompt.contextImageGroups.reduce((count, group) => count + group.images.length, 0) +
      (params.images?.length ?? 0),
    tools,
  });
  const buildLlmOutputEvent = () => ({
    ...buildModelCallIdentity(),
    ...hookContextWindowFields,
    resolvedRef: usesSupervisionConnection
      ? `${resourceState.thread.modelProvider ?? effectiveRuntimeProviderId}/${resourceState.thread.model ?? effectiveRuntimeModelId}`
      : (params.runtimePlan?.observability.resolvedRef ?? `${params.provider}/${params.modelId}`),
    ...(!usesSupervisionConnection && params.runtimePlan?.observability.harnessId
      ? { harnessId: params.runtimePlan.observability.harnessId }
      : {}),
  });
  return { codexModelCallDiagnostics, startCodexTurn, buildLlmOutputEvent };
}
