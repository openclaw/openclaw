import type {
  PermissionRequest as SdkPermissionRequest,
  SessionConfig,
  Tool as SdkTool,
} from "@github/copilot-sdk";
import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  attachEventBridge,
  type AssistantMessage,
  type AssistantUsageSnapshot,
  type OnAssistantDeltaPayload,
  type SessionLike,
} from "./event-bridge.js";
import type { ClientCreateOptions, CopilotClientPool, PoolKey, PooledClient } from "./runtime.js";

// SAFETY: tool-bridge has not yet been implemented. We pass tools: [] to the
// SDK so no OpenClaw tool can be invoked from this attempt. tool-bridge will
// replace this with a converted SDK Tool[] backed by params.tools and
// delegating execution through params.onToolCall.
const SDK_TOOLS: SdkTool[] = [];

const SUPPORTED_PROVIDERS = new Set(["github", "openclaw", "copilot"]);
const TOKEN_PROFILE_ERROR =
  "[copilot-sdk-attempt] gitHubToken auth requires profileId+profileVersion (pool keying safety; per Q5/Q1 decisions)";

type AttemptResultWithSdkSessionId = AgentHarnessAttemptResult & { sdkSessionId?: string };
type PromptErrorWithCode = Error & { code?: string; cause?: unknown };
// TODO(plugin-sdk-widening): Remove AttemptParamsLike when
// openclaw/plugin-sdk/agent-harness-runtime declares auth, messages,
// onAssistantDelta, and initialReplayState.sdkSessionId fields. Tracked by
// project openclaw-copilot-sdk-harness; reviewer-attempt-bridge note.

type AttemptParamsLike = AgentHarnessAttemptParams & {
  auth?: {
    gitHubToken?: string;
    profileId?: string;
    profileVersion?: string;
    useLoggedInUser?: boolean;
  };
  copilotHome?: string;
  cwd?: string;
  initialReplayState?: AgentHarnessAttemptParams["initialReplayState"] & { sdkSessionId?: string };
  messages?: AgentMessage[];
  model?: string | { api?: string; id?: string; provider?: string };
  onAssistantDelta?: (payload: OnAssistantDeltaPayload) => void | Promise<void>;
  profileVersion?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
};
type ModelRef = { api?: string; id: string; provider: string };
type SdkUserInputRequest = {
  allowFreeform?: boolean;
  choices?: string[];
  question: string;
};

export interface CopilotSdkAttemptDeps {
  pool: CopilotClientPool;
  now?: () => number;
}

export async function runCopilotSdkAttempt(
  params: AgentHarnessAttemptParams,
  deps: CopilotSdkAttemptDeps,
): Promise<AgentHarnessAttemptResult> {
  const now = deps.now ?? Date.now;
  const input = params as AttemptParamsLike;
  const messages = getMessagesSnapshotInput(input);

  if (params.abortSignal?.aborted) {
    return createResult(input, {
      aborted: true,
      externalAbort: true,
      messagesSnapshot: messages,
      now,
      promptError: undefined,
      sdkSessionId: undefined,
      sessionIdUsed: input.sessionId,
    });
  }

  const modelRef = resolveModelRef(input);
  if (!SUPPORTED_PROVIDERS.has(modelRef.provider)) {
    return createResult(input, {
      messagesSnapshot: messages,
      now,
      promptError: createPromptError(
        "model_not_supported",
        `[copilot-sdk-attempt] provider ${modelRef.provider} is not supported at MVP (subscription Copilot models only; BYOK arrives via byok-mapping-skeleton)`,
      ),
      sdkSessionId: undefined,
      sessionIdUsed: input.sessionId,
    });
  }

  let abortRequested = false;
  let aborted = false;
  let externalAbort = false;
  let settled = false;
  let sentTurnStarted = false;
  let timedOut = false;
  let promptError: Error | undefined;
  let sdkSessionId: string | undefined;
  let sessionIdUsed = input.sessionId;
  let disconnectError: Error | undefined;
  let handle: PooledClient | undefined;
  let session: SessionLike | undefined;
  let bridge: ReturnType<typeof attachEventBridge> | undefined;
  let releaseError: Error | undefined;

  const onAbort = () => {
    abortRequested = true;
    externalAbort = true;
    aborted = true;
    if (settled || !sentTurnStarted || !session) {
      return;
    }
    void session.abort().catch(() => undefined);
  };

  params.abortSignal?.addEventListener("abort", onAbort, { once: true });

  const poolAcquire = resolvePoolAcquire(input);

  try {
    handle = await deps.pool.acquire(poolAcquire.key, poolAcquire.options);
    const client = handle.client;
    const sessionConfig = createSessionConfig(input, modelRef.id);
    const resumeSessionId = readString(input.initialReplayState?.sdkSessionId);

    session = (resumeSessionId
      ? await client.resumeSession(resumeSessionId, {
          ...sessionConfig,
          // SAFETY: replay-shim owns pending-work replay. This bridge always resumes
          // with continuePendingWork: false so suspended tool/permission work cannot
          // be replayed implicitly before the dedicated replay bridge lands.
          continuePendingWork: false,
        })
      : await client.createSession(sessionConfig)) as unknown as SessionLike;

    sdkSessionId = readSessionId(session) ?? resumeSessionId;
    sessionIdUsed = sdkSessionId ?? input.sessionId;
    bridge = attachEventBridge(session, {
      onAssistantDelta: input.onAssistantDelta,
      getSdkSessionId: () => sdkSessionId,
      isAborted: () => aborted,
    });

    if (abortRequested || params.abortSignal?.aborted) {
      aborted = true;
      externalAbort = true;
    } else {
      sentTurnStarted = true;
      const result = await session.sendAndWait({ prompt: input.prompt }, input.timeoutMs);
      await bridge.awaitDeltaChain();
      if (!bridge.recordSendResult(result) && !aborted) {
        // SDK sendAndWait returning undefined is treated as a timeout by the
        // capability inventory. Do not call session.abort() here: OpenClaw may
        // resume the in-flight SDK session on the next attempt.
        timedOut = true;
      }
      const snap = bridge.snapshot();
      if (!promptError && !timedOut && !aborted && snap.streamError) {
        promptError = snap.streamError;
      }
    }
  } catch (error: unknown) {
    if (!aborted) {
      promptError = toError(error);
    }
  } finally {
    settled = true;
    bridge?.detach();
    params.abortSignal?.removeEventListener("abort", onAbort);

    if (session) {
      try {
        await session.disconnect();
      } catch (error: unknown) {
        disconnectError = toError(error);
        if (!promptError) {
          promptError = disconnectError;
        }
      }
    }

    if (handle) {
      try {
        await deps.pool.release(handle);
      } catch (error: unknown) {
        const releaseFailure = toError(error);
        if (promptError) {
          console.warn(
            "[copilot-sdk-attempt] pool.release failed after primary error",
            releaseFailure,
          );
        } else {
          releaseError = releaseFailure;
        }
      }
    }
  }

  if (releaseError) {
    throw releaseError;
  }

  const snap = bridge?.snapshot();
  const assistantTexts = bridge?.finalizeAssistantTexts() ?? [];
  const lastAssistant = bridge?.buildAssistantMessage({ modelRef, now });
  const messagesSnapshot = lastAssistant ? [...messages, lastAssistant] : [...messages];

  return createResult(input, {
    aborted,
    assistantTexts,
    currentAttemptAssistant: lastAssistant,
    externalAbort,
    itemLifecycle: {
      activeCount: Math.max((snap?.startedCount ?? 0) - (snap?.completedCount ?? 0), 0),
      completedCount: snap?.completedCount ?? 0,
      startedCount: snap?.startedCount ?? 0,
    },
    lastAssistant,
    messagesSnapshot,
    now,
    promptError,
    sdkSessionId,
    sessionIdUsed,
    timedOut,
    toolMetas: snap ? [...snap.toolMetas] : [],
    usage: snap?.usage,
  });
}

function createResult(
  params: AttemptParamsLike,
  state: {
    aborted?: boolean;
    assistantTexts?: string[];
    currentAttemptAssistant?: AssistantMessage;
    externalAbort?: boolean;
    itemLifecycle?: { activeCount: number; completedCount: number; startedCount: number };
    lastAssistant?: AssistantMessage;
    messagesSnapshot: AgentMessage[];
    now: () => number;
    promptError: Error | undefined;
    sdkSessionId?: string;
    sessionIdUsed?: string;
    timedOut?: boolean;
    toolMetas?: Array<{ meta?: string; toolName: string }>;
    usage?: AssistantUsageSnapshot;
  },
): AttemptResultWithSdkSessionId {
  const promptError = state.promptError;
  const timedOut = state.timedOut === true;
  const replayHadPotentialSideEffects = timedOut;
  return {
    aborted: state.aborted === true,
    ...(state.sdkSessionId ? { sdkSessionId: state.sdkSessionId } : {}),
    assistantTexts: state.assistantTexts ?? [],
    attemptUsage: state.usage,
    cloudCodeAssistFormatError: false,
    currentAttemptAssistant: state.currentAttemptAssistant,
    didSendViaMessagingTool: false,
    externalAbort: state.externalAbort === true,
    idleTimedOut: false,
    itemLifecycle: state.itemLifecycle ?? {
      activeCount: 0,
      completedCount: 0,
      startedCount: 0,
    },
    lastAssistant: state.lastAssistant,
    messagesSnapshot: state.messagesSnapshot,
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSentTexts: [],
    promptError,
    promptErrorSource: promptError ? "prompt" : null,
    replayMetadata: {
      hadPotentialSideEffects: replayHadPotentialSideEffects,
      replaySafe: !replayHadPotentialSideEffects,
    },
    sessionFileUsed: readString(params.sessionFile),
    sessionIdUsed: state.sessionIdUsed ?? readString(params.sessionId) ?? "copilot-sdk-session",
    timedOut,
    timedOutDuringCompaction: false,
    toolMetas: state.toolMetas ?? [],
  };
}

function createPromptError(code: string, message: string, cause?: unknown): PromptErrorWithCode {
  const error = new Error(message) as PromptErrorWithCode;
  error.code = code;
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function createSessionConfig(
  params: AttemptParamsLike,
  sdkModelId: string,
): Pick<
  SessionConfig,
  | "model"
  | "onPermissionRequest"
  | "onUserInputRequest"
  | "reasoningEffort"
  | "tools"
  | "workingDirectory"
> {
  return {
    model: sdkModelId,
    // SAFETY: permission-bridge has not yet been implemented. The placeholder
    // handler denies every permission request (fail-closed). The SDK will report
    // the denial back to the model. permission-bridge replaces this with the
    // copied PI tool-policy logic.
    onPermissionRequest: (async (_request: SdkPermissionRequest) => {
      return {
        kind: "deny" as const,
        reason:
          "copilot-sdk harness MVP: permissions not yet wired (awaiting permission-bridge todo)",
      } as unknown as ReturnType<NonNullable<SessionConfig["onPermissionRequest"]>> extends Promise<
        infer TResult
      >
        ? TResult
        : never;
    }) as NonNullable<SessionConfig["onPermissionRequest"]>,
    // SAFETY: user-input-bridge has not yet been implemented. The placeholder
    // rejects every user-input request. user-input-bridge replaces this with
    // the channel/TUI prompt flow via commitments/.
    onUserInputRequest: (async (_request: SdkUserInputRequest) => {
      throw new Error(
        "[copilot-sdk-attempt] onUserInputRequest not implemented at MVP; awaiting user-input-bridge todo",
      );
    }) as NonNullable<SessionConfig["onUserInputRequest"]>,
    reasoningEffort: params.reasoningEffort,
    tools: SDK_TOOLS,
    workingDirectory: readString(params.workspaceDir) ?? readString(params.cwd),
  };
}

function getMessagesSnapshotInput(params: AttemptParamsLike): AgentMessage[] {
  return Array.isArray(params.messages) ? [...params.messages] : [];
}

function readSessionId(session: SessionLike | undefined): string | undefined {
  if (!session) {
    return undefined;
  }
  return readString(session.sessionId) ?? readString(session.id);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveModelRef(params: AttemptParamsLike): ModelRef {
  const rawModel = params.model;
  if (rawModel && typeof rawModel === "object") {
    return {
      api: readString(rawModel.api),
      id:
        readString(rawModel.id) ??
        readString((params as { modelId?: unknown }).modelId) ??
        "unknown-model",
      provider:
        readString(rawModel.provider) ??
        readString((params as { provider?: unknown }).provider) ??
        "unknown-provider",
    };
  }
  return {
    id:
      readString(typeof rawModel === "string" ? rawModel : undefined) ??
      readString((params as { modelId?: unknown }).modelId) ??
      "unknown-model",
    provider: readString((params as { provider?: unknown }).provider) ?? "unknown-provider",
  };
}

function resolvePoolAcquire(params: AttemptParamsLike): {
  key: PoolKey;
  options: ClientCreateOptions;
} {
  const auth = params.auth;
  const gitHubToken = readString(auth?.gitHubToken);
  const authProfileId = readString(auth?.profileId) ?? readString(params.authProfileId);
  const authProfileVersion = readString(auth?.profileVersion) ?? readString(params.profileVersion);

  let authMode: PoolKey["authMode"] = "useLoggedInUser";
  if (auth?.useLoggedInUser === true) {
    authMode = "useLoggedInUser";
  } else if (gitHubToken) {
    if (!authProfileId || !authProfileVersion) {
      throw new Error(TOKEN_PROFILE_ERROR);
    }
    authMode = "gitHubToken";
  }

  const copilotHome =
    readString(params.copilotHome) ??
    readString(params.agentDir) ??
    readString(params.workspaceDir) ??
    process.cwd();

  return {
    key: {
      agentId: readString(params.agentId) ?? "copilot-sdk",
      authMode,
      ...(authMode === "gitHubToken"
        ? {
            authProfileId,
            authProfileVersion,
          }
        : {}),
      copilotHome,
    },
    options: {
      copilotHome,
      cwd: readString(params.cwd) ?? readString(params.workspaceDir),
      gitHubToken: authMode === "gitHubToken" ? gitHubToken : undefined,
      useLoggedInUser: authMode === "useLoggedInUser",
    },
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
