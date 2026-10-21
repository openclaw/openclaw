import type { MessageOptions } from "@github/copilot-sdk";
import type { AgentMessage, SandboxContext } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  detectAndLoadAgentHarnessPromptImages,
  getModelProviderRequestTransport,
  resolveUserPath,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { toStringifiedError as toCopilotError } from "openclaw/plugin-sdk/error-runtime";
import { readNonEmptyStringPreservingWhitespace as readNonEmptyString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  withPromptFailure,
  type AgentHarnessAttemptResult,
  type AttemptParamsLike,
  type AttemptResultWithSdkSessionId,
  type ModelRef,
  type ModelRefInputObject,
} from "./attempt-types.js";
import { createCopilotByokAuth, resolveCopilotAuth } from "./auth-bridge.js";
import type { AssistantMessage, AssistantUsageSnapshot } from "./event-bridge.js";
import type { PromptErrorWithCode } from "./prompt-error.js";
import { resolveCopilotProvider, type ResolvedCopilotProvider } from "./provider-bridge.js";
import { computeReplayMetadata, copilotToolMetasHavePotentialSideEffects } from "./replay-shim.js";
import type { ClientCreateOptions, PoolKey } from "./runtime.js";

export { toCopilotError };
export function createResult(
  params: AttemptParamsLike,
  state: {
    acceptedSessionSpawns?: AgentHarnessAttemptResult["acceptedSessionSpawns"];
    aborted?: boolean;
    assistantTranscriptOwned?: boolean;
    assistantTranscriptIdempotencyKey?: string;
    contextEngineTerminalAnchor?: import("openclaw/plugin-sdk/session-transcript-runtime").TranscriptEntryAnchor;
    assistantTexts?: string[];
    codeModeEngaged?: boolean;
    currentAttemptAssistant?: AssistantMessage;
    currentAttemptCompletedAssistant?: AssistantMessage;
    downgradedFromResume?: boolean;
    externalAbort?: boolean;
    itemLifecycle?: { activeCount: number; completedCount: number; startedCount: number };
    lastAssistant?: AssistantMessage;
    journalValidated?: boolean;
    lastToolError?: AgentHarnessAttemptResult["lastToolError"];
    messagesSnapshot: AgentMessage[];
    nativeReplayInvalid?: boolean;
    promptError: Error | undefined;
    resumeFailureRecovered?: boolean;
    sdkSessionId?: string;
    timedOut?: boolean;
    timedOutDuringCompaction?: boolean;
    toolMetas?: AgentHarnessAttemptResult["toolMetas"];
    usage?: AssistantUsageSnapshot;
    yieldDetected?: boolean;
    yieldAcknowledgment?: string;
  },
): AttemptResultWithSdkSessionId {
  const promptError = state.promptError;
  const transcriptPersistenceFailed =
    (promptError as PromptErrorWithCode | undefined)?.code === "transcript_persistence_failed";
  const timedOut = state.timedOut === true;
  const toolMetas = state.toolMetas ?? [];
  const replayMetadata =
    params.operation === "settled-tool-finalization"
      ? {
          hadPotentialSideEffects: false,
          replaySafe: !transcriptPersistenceFailed,
        }
      : computeReplayMetadata({
          priorReplayInvalid:
            params.initialReplayState?.replayInvalid === true ||
            state.nativeReplayInvalid === true ||
            transcriptPersistenceFailed,
          priorHadPotentialSideEffects: params.initialReplayState?.hadPotentialSideEffects,
          thisAttemptTimedOut: timedOut,
          thisAttemptHadPotentialSideEffects: copilotToolMetasHavePotentialSideEffects(toolMetas),
          thisAttemptDowngradedFromResume: state.downgradedFromResume,
          thisAttemptResumeFailureRecovered: state.resumeFailureRecovered,
        });
  const interruption = timedOut
    ? {
        kind: "timeout" as const,
        phase: state.timedOutDuringCompaction ? ("compaction" as const) : ("prompt" as const),
        source: state.externalAbort ? ("external" as const) : ("runtime" as const),
        ...(state.aborted ? { aborted: true as const } : {}),
      }
    : state.aborted
      ? {
          kind: "aborted" as const,
          source: state.externalAbort ? ("external" as const) : ("runtime" as const),
        }
      : { kind: "ok" as const };
  const terminal =
    promptError !== undefined ? withPromptFailure(interruption, promptError) : interruption;
  return {
    terminal,
    ...(state.acceptedSessionSpawns?.length
      ? { acceptedSessionSpawns: state.acceptedSessionSpawns }
      : {}),
    ...(state.assistantTranscriptOwned
      ? {
          assistantTranscriptOwned: true,
          ...(state.assistantTranscriptIdempotencyKey
            ? { assistantTranscriptIdempotencyKey: state.assistantTranscriptIdempotencyKey }
            : {}),
        }
      : {}),
    ...(state.sdkSessionId ? { sdkSessionId: state.sdkSessionId } : {}),
    ...(state.contextEngineTerminalAnchor
      ? { contextEngineTerminalAnchor: state.contextEngineTerminalAnchor }
      : {}),
    ...(state.journalValidated !== undefined ? { journalValidated: state.journalValidated } : {}),
    ...(state.codeModeEngaged !== undefined ? { codeModeEngaged: state.codeModeEngaged } : {}),
    assistantTexts: state.assistantTexts ?? [],
    attemptUsage: state.usage,
    cloudCodeAssistFormatError: false,
    currentAttemptAssistant: state.currentAttemptAssistant,
    currentAttemptCompletedAssistant: state.currentAttemptCompletedAssistant,
    didSendViaMessagingTool: false,
    itemLifecycle: state.itemLifecycle ?? {
      activeCount: 0,
      completedCount: 0,
      startedCount: 0,
    },
    lastAssistant: state.lastAssistant,
    ...(state.lastToolError ? { lastToolError: state.lastToolError } : {}),
    messagesSnapshot: state.messagesSnapshot,
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSentTexts: [],
    replayMetadata,
    sessionFileUsed: readNonEmptyString(params.sessionFile),
    // Core adopts this identity before its next transcript write; SDK session
    // identity belongs only in sdkSessionId and must not replace the host id.
    sessionIdUsed: params.sessionId,
    toolMetas,
    yieldDetected: state.yieldDetected === true,
    ...(state.yieldAcknowledgment ? { yieldAcknowledgment: state.yieldAcknowledgment } : {}),
  };
}
export async function createMessageOptions(
  params: AttemptParamsLike,
  context: {
    effectiveCwd: string | undefined;
    effectiveWorkspaceDir: string | undefined;
    provider: ResolvedCopilotProvider;
    sandbox: SandboxContext | null;
    workspaceOnly: boolean;
  },
): Promise<MessageOptions> {
  async function resolvePromptImages() {
    const workspaceDir =
      context.effectiveCwd ??
      context.effectiveWorkspaceDir ??
      readResolvedAttemptPath(params.cwd) ??
      readResolvedAttemptPath(params.workspaceDir);
    if (!workspaceDir) {
      return [];
    }
    const localRoots =
      context.workspaceOnly && context.effectiveWorkspaceDir
        ? [context.effectiveWorkspaceDir]
        : undefined;
    const model = params.model;
    const result = await detectAndLoadAgentHarnessPromptImages({
      prompt: params.prompt,
      workspaceDir,
      model: { input: typeof model === "object" ? (model.input ?? ["image"]) : ["image"] },
      existingImages: params.images,
      imageOrder: params.imageOrder,
      media: params.media,
      config: params.config,
      workspaceOnly: context.workspaceOnly,
      localRoots,
      sandbox:
        context.sandbox?.enabled && context.sandbox.fsBridge
          ? { root: context.sandbox.workspaceDir, bridge: context.sandbox.fsBridge }
          : undefined,
    });
    return result.images;
  }
  const attachments = (await resolvePromptImages()).map((image, index) => ({
    type: "blob" as const,
    data: image.data,
    mimeType: image.mimeType,
    displayName: `prompt-image-${index + 1}`,
  }));
  const providerHeaders = context.provider.provider?.headers;
  const requestHeaders =
    providerHeaders && Object.keys(providerHeaders).length > 0 ? providerHeaders : undefined;
  return {
    prompt: params.prompt,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(requestHeaders ? { requestHeaders } : {}),
  };
}
export { readNonEmptyString };
export function readResolvedAttemptPath(value: unknown): string | undefined {
  const raw = readNonEmptyString(value)?.trim();
  if (!raw) {
    return undefined;
  }
  if (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(raw)) {
    return raw;
  }
  return resolveUserPath(raw);
}
export function resolveModelRef(params: AttemptParamsLike): ModelRef {
  const rawModel = (params as { runtimeModel?: unknown }).runtimeModel ?? params.model;
  if (rawModel && typeof rawModel === "object") {
    const model = rawModel as ModelRefInputObject;
    const requestTransport = getModelProviderRequestTransport(rawModel);
    const rawRequest = model.request;
    return {
      api: readNonEmptyString(model.api),
      id:
        readNonEmptyString(model.id) ??
        readNonEmptyString((params as { modelId?: unknown }).modelId) ??
        "unknown-model",
      provider:
        readNonEmptyString(model.provider) ??
        readNonEmptyString((params as { provider?: unknown }).provider) ??
        "unknown-provider",
      baseUrl: readNonEmptyString(model.baseUrl),
      azureApiVersion: readNonEmptyString(model.azureApiVersion ?? model.params?.azureApiVersion),
      headers: model.headers,
      authHeader: model.authHeader,
      requestAuthMode: readNonEmptyString(requestTransport?.auth?.mode ?? rawRequest?.auth?.mode),
      requestProxy: requestTransport?.proxy ?? rawRequest?.proxy,
      requestTls: requestTransport?.tls ?? rawRequest?.tls,
      requestAllowPrivateNetwork:
        requestTransport?.allowPrivateNetwork ?? rawRequest?.allowPrivateNetwork,
      contextTokens: model.contextTokens,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    };
  }
  return {
    id:
      readNonEmptyString(typeof rawModel === "string" ? rawModel : undefined) ??
      readNonEmptyString((params as { modelId?: unknown }).modelId) ??
      "unknown-model",
    provider: readNonEmptyString((params as { provider?: unknown }).provider) ?? "unknown-provider",
  };
}
export function resolvePoolAcquire(params: AttemptParamsLike): {
  key: PoolKey;
  options: ClientCreateOptions;
  auth: ReturnType<typeof resolveCopilotAuth>;
  provider: ResolvedCopilotProvider;
} {
  const model = resolveModelRef(params);
  const provider = resolveCopilotProvider({
    model,
    resolvedApiKey: readNonEmptyString(params.resolvedApiKey),
    authProfileId: readNonEmptyString(params.authProfileId),
  });
  const authContext = {
    agentId: readNonEmptyString(params.agentId),
    agentDir: readNonEmptyString(params.agentDir),
    copilotHome: readNonEmptyString(params.copilotHome),
  };
  const auth =
    provider.mode === "byok"
      ? createCopilotByokAuth({
          ...authContext,
          authProfileId: provider.authProfileId,
          authProfileVersion: provider.authProfileVersion,
        })
      : resolveCopilotAuth({
          ...authContext,
          auth: params.auth,
          resolvedApiKey: readNonEmptyString(params.resolvedApiKey),
          authProfileId: readNonEmptyString(params.authProfileId),
          profileVersion: readNonEmptyString(params.profileVersion),
        });
  return {
    key: {
      agentId: auth.agentId,
      authMode: auth.authMode,
      ...(auth.authMode === "gitHubToken" || auth.authMode === "byok"
        ? {
            authProfileId: auth.authProfileId,
            authProfileVersion: auth.authProfileVersion,
          }
        : {}),
      copilotHome: auth.copilotHome,
    },
    options: {
      copilotHome: auth.copilotHome,
      ...(auth.authMode === "gitHubToken" && auth.gitHubToken
        ? { gitHubToken: auth.gitHubToken }
        : {}),
      useLoggedInUser: auth.authMode === "useLoggedInUser",
    },
    auth,
    provider,
  };
}
export function isSdkSendAndWaitTimeoutError(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") {
    return false;
  }
  return /^Timeout after \d+ms waiting for session\.idle$/.test(message);
}
