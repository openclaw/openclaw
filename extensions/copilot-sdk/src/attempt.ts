import type {
  PermissionRequest as SdkPermissionRequest,
  SessionConfig,
  SessionEvent,
  SessionEventType,
  Tool as SdkTool,
} from "@github/copilot-sdk";
import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ClientCreateOptions, CopilotClientPool, PoolKey, PooledClient } from "./runtime.js";

// SAFETY: tool-bridge has not yet been implemented. We pass tools: [] to the
// SDK so no OpenClaw tool can be invoked from this attempt. tool-bridge will
// replace this with a converted SDK Tool[] backed by params.tools and
// delegating execution through params.onToolCall.
const SDK_TOOLS: SdkTool[] = [];

const SUPPORTED_PROVIDERS = new Set(["github", "openclaw", "copilot"]);
const TOKEN_PROFILE_ERROR =
  "[copilot-sdk-attempt] gitHubToken auth requires profileId+profileVersion (pool keying safety; per Q5/Q1 decisions)";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type AttemptResultWithSdkSessionId = AgentHarnessAttemptResult & { sdkSessionId?: string };
type PromptErrorWithCode = Error & { code?: string; cause?: unknown };
type OnAssistantDeltaPayload = {
  delta: string;
  sessionId?: string;
  text: string;
  usage?: {
    cacheRead?: number;
    cacheWrite?: number;
    input?: number;
    output?: number;
    total?: number;
  };
};
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
type MessageAccumulator = { messageId: string; text: string };
type AssistantUsageSnapshot = {
  cacheRead?: number;
  cacheWrite?: number;
  input?: number;
  output?: number;
  total?: number;
};
type SdkUserInputRequest = {
  allowFreeform?: boolean;
  choices?: string[];
  question: string;
};
type SessionLike = {
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  id?: string;
  off?: (eventType: string, handler: (...args: unknown[]) => void) => void;
  on: {
    <K extends SessionEventType>(
      eventType: K,
      handler: (event: Extract<SessionEvent, { type: K }>) => void,
    ): (() => void) | void;
    (eventType: string, handler: (event: SessionEvent) => void): (() => void) | void;
  };
  sendAndWait(options: { prompt: string }, timeout?: number): Promise<SessionEvent | undefined>;
  sessionId?: string;
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
  let completedCount = 0;
  let startedCount = 0;
  const toolMetas: Array<{ meta?: string; toolName: string }> = [];
  const toolNamesByCallId = new Map<string, string>();
  const messageOrder: string[] = [];
  const messagesById = new Map<string, MessageAccumulator>();
  const reasoningOrder: string[] = [];
  const reasoningById = new Map<string, string>();
  let lastAssistantEvent: Extract<SessionEvent, { type: "assistant.message" }> | undefined;
  let usage: AssistantUsageSnapshot | undefined;
  let streamError: Error | undefined;
  let handle: PooledClient | undefined;
  let session: SessionLike | undefined;
  const unsubscribeFns: Array<() => void> = [];
  let deltaChain = Promise.resolve();
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

    registerListener(session, unsubscribeFns, "assistant.message_delta", (event) => {
      const messageId = readString(event.data.messageId) ?? "assistant-message";
      const delta = event.data.deltaContent;
      if (!delta) {
        return;
      }
      const entry = ensureMessageAccumulator(messagesById, messageOrder, messageId);
      entry.text += delta;
      const onAssistantDelta = input.onAssistantDelta;
      if (!onAssistantDelta) {
        return;
      }
      const payload: OnAssistantDeltaPayload = {
        delta,
        sessionId: sdkSessionId,
        text: entry.text,
        usage,
      };
      deltaChain = deltaChain.then(() => onAssistantDelta(payload));
    });

    registerListener(session, unsubscribeFns, "assistant.reasoning_delta", (event) => {
      const reasoningId = readString(event.data.reasoningId) ?? "assistant-reasoning";
      const delta = event.data.deltaContent;
      if (!delta) {
        return;
      }
      if (!reasoningById.has(reasoningId)) {
        reasoningById.set(reasoningId, "");
        reasoningOrder.push(reasoningId);
      }
      reasoningById.set(reasoningId, `${reasoningById.get(reasoningId) ?? ""}${delta}`);
    });

    registerListener(session, unsubscribeFns, "assistant.message", (event) => {
      lastAssistantEvent = event;
      const entry = ensureMessageAccumulator(messagesById, messageOrder, event.data.messageId);
      if (
        typeof event.data.content === "string" &&
        event.data.content.length >= entry.text.length
      ) {
        entry.text = event.data.content;
      }
    });

    registerListener(session, unsubscribeFns, "assistant.usage", (event) => {
      usage = normalizeUsage(event.data);
    });

    registerListener(session, unsubscribeFns, "tool.execution_start", (event) => {
      startedCount += 1;
      toolNamesByCallId.set(event.data.toolCallId, event.data.toolName);
      toolMetas.push({ toolName: event.data.toolName });
    });

    registerListener(session, unsubscribeFns, "tool.execution_complete", (event) => {
      completedCount += 1;
      const toolName = toolNamesByCallId.get(event.data.toolCallId);
      const meta = event.data.success
        ? (event.data.result?.detailedContent ?? event.data.result?.content)
        : event.data.error?.message;
      if (toolName) {
        toolMetas.push({ meta, toolName });
      }
    });

    registerListener(session, unsubscribeFns, "session.error", (event) => {
      if (!aborted) {
        streamError = createPromptError(
          event.data.errorCode ?? event.data.errorType,
          event.data.message,
        );
      }
    });

    registerListener(session, unsubscribeFns, "abort", (event) => {
      if (!aborted) {
        streamError = createPromptError(
          "session_aborted",
          `[copilot-sdk-attempt] session aborted: ${event.data.reason}`,
        );
      }
    });

    if (abortRequested || params.abortSignal?.aborted) {
      aborted = true;
      externalAbort = true;
    } else {
      sentTurnStarted = true;
      const result = await session.sendAndWait({ prompt: input.prompt }, input.timeoutMs);
      await deltaChain;
      if (isAssistantMessageEvent(result)) {
        lastAssistantEvent = result;
      } else if (!aborted) {
        // SDK sendAndWait returning undefined is treated as a timeout by the
        // capability inventory. Do not call session.abort() here: OpenClaw may
        // resume the in-flight SDK session on the next attempt.
        timedOut = true;
      }
      if (!promptError && !timedOut && !aborted && streamError) {
        promptError = streamError;
      }
    }
  } catch (error: unknown) {
    if (!aborted) {
      promptError = toError(error);
    }
  } finally {
    settled = true;
    for (const unsubscribe of unsubscribeFns.reverse()) {
      try {
        unsubscribe();
      } catch {
        // best-effort cleanup only
      }
    }
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

  const assistantTexts = finalizeAssistantTexts(messageOrder, messagesById, lastAssistantEvent);
  const lastAssistant = buildAssistantMessage({
    assistantTexts,
    event: lastAssistantEvent,
    modelRef,
    now,
    reasoningById,
    reasoningOrder,
    usage,
  });
  const messagesSnapshot = lastAssistant ? [...messages, lastAssistant] : [...messages];

  return createResult(input, {
    aborted,
    assistantTexts,
    currentAttemptAssistant: lastAssistant,
    externalAbort,
    itemLifecycle: {
      activeCount: Math.max(startedCount - completedCount, 0),
      completedCount,
      startedCount,
    },
    lastAssistant,
    messagesSnapshot,
    now,
    promptError,
    sdkSessionId,
    sessionIdUsed,
    timedOut,
    toolMetas,
    usage,
  });
}

function buildAssistantMessage(params: {
  assistantTexts: string[];
  event?: Extract<SessionEvent, { type: "assistant.message" }>;
  modelRef: ModelRef;
  now: () => number;
  reasoningById: Map<string, string>;
  reasoningOrder: string[];
  usage?: AssistantUsageSnapshot;
}): AssistantMessage | undefined {
  const event = params.event;
  const text = event
    ? event.data.content || params.assistantTexts[params.assistantTexts.length - 1] || ""
    : "";
  const reasoningText =
    event?.data.reasoningText ?? joinReasoning(params.reasoningOrder, params.reasoningById);
  const toolRequests = event?.data.toolRequests ?? [];
  if (!text && !reasoningText && toolRequests.length === 0) {
    return undefined;
  }

  const content: AssistantMessage["content"] = [];
  if (reasoningText) {
    content.push({ thinking: reasoningText, type: "thinking" });
  }
  if (text) {
    content.push({ text, type: "text" });
  }
  for (const request of toolRequests) {
    content.push({
      arguments: request.arguments ?? {},
      id: request.toolCallId,
      name: request.name,
      type: "toolCall",
    });
  }

  const usage = normalizeUsageWithFallback(params.usage, event?.data.outputTokens);

  return {
    api: params.modelRef.api ?? "openai-responses",
    content,
    model: event?.data.model ?? params.modelRef.id,
    provider: params.modelRef.provider,
    role: "assistant",
    stopReason: toolRequests.length > 0 ? "toolUse" : "stop",
    timestamp: params.now(),
    usage: {
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      cost: {
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        output: 0,
        total: 0,
      },
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      totalTokens: usage.total ?? 0,
    },
  };
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

function ensureMessageAccumulator(
  messagesById: Map<string, MessageAccumulator>,
  messageOrder: string[],
  messageId: string,
): MessageAccumulator {
  let entry = messagesById.get(messageId);
  if (!entry) {
    entry = { messageId, text: "" };
    messagesById.set(messageId, entry);
    messageOrder.push(messageId);
  }
  return entry;
}

function finalizeAssistantTexts(
  messageOrder: string[],
  messagesById: Map<string, MessageAccumulator>,
  event?: Extract<SessionEvent, { type: "assistant.message" }>,
): string[] {
  const texts = messageOrder
    .map((messageId) => messagesById.get(messageId)?.text ?? "")
    .filter((text) => text.length > 0);
  if (texts.length > 0) {
    return texts;
  }
  if (event?.data.content) {
    return [event.data.content];
  }
  return [];
}

function getMessagesSnapshotInput(params: AttemptParamsLike): AgentMessage[] {
  return Array.isArray(params.messages) ? [...params.messages] : [];
}

function isAssistantMessageEvent(
  event: SessionEvent | undefined,
): event is Extract<SessionEvent, { type: "assistant.message" }> {
  return event?.type === "assistant.message";
}

function joinReasoning(order: string[], reasoningById: Map<string, string>): string {
  return order.map((reasoningId) => reasoningById.get(reasoningId) ?? "").join("");
}

function normalizeUsage(data: {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}): AssistantUsageSnapshot {
  const input = normalizeUsageNumber(data.inputTokens);
  const output = normalizeUsageNumber(data.outputTokens);
  const cacheRead = normalizeUsageNumber(data.cacheReadTokens);
  const cacheWrite = normalizeUsageNumber(data.cacheWriteTokens);
  const total = [input, output, cacheRead, cacheWrite].reduce<number>(
    (sum, value) => sum + (value ?? 0),
    0,
  );
  return {
    cacheRead,
    cacheWrite,
    input,
    output,
    total,
  };
}

function normalizeUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : undefined;
}

function normalizeUsageWithFallback(
  usage: AssistantUsageSnapshot | undefined,
  outputTokens: number | undefined,
): AssistantUsageSnapshot {
  if (usage) {
    return usage;
  }
  const normalizedOutput = normalizeUsageNumber(outputTokens);
  return {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: normalizedOutput ?? 0,
    total: normalizedOutput ?? 0,
  };
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

function registerListener<K extends SessionEventType>(
  session: SessionLike,
  unsubscribeFns: Array<() => void>,
  eventType: K,
  handler: (event: Extract<SessionEvent, { type: K }>) => void,
): void {
  const maybeUnsubscribe = session.on(eventType, handler);
  if (typeof maybeUnsubscribe === "function") {
    unsubscribeFns.push(maybeUnsubscribe);
    return;
  }
  unsubscribeFns.push(() => {
    session.off?.(eventType, handler as (...args: unknown[]) => void);
  });
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
