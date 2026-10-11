import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { buildTimestampPrefix } from "../../../gateway/server-methods/agent-timestamp.js";
import {
  hasLegacyRuntimeContextEnvelope,
  RUNTIME_CONTEXT_BEGIN_MARKER,
  RUNTIME_CONTEXT_END_MARKER,
  type ImageContent,
  type UserMessage,
} from "../../../llm/types.js";
import { INTER_SESSION_PROMPT_PREFIX_BASE } from "../../../sessions/input-provenance.js";
import { hasPersistedMedia, MEDIA_ONLY_USER_TEXT } from "../../../sessions/user-turn-media.js";
import { getUserTurnTranscriptAdmissionOwner } from "../../../sessions/user-turn-transcript-admission.js";
import { buildLateMediaAttachedProjection } from "../../../sessions/user-turn-transcript.js";
import {
  readModelPromptProjection,
  projectRecordedModelPrompt,
} from "../../../sessions/user-turn-transcript.message.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import {
  escapeInternalRuntimeContextDelimiters,
  isOpenClawSystemUpdateMessage,
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  projectRuntimeContextFragments,
  resolveRuntimeContextPromptOwner,
  retainRuntimeContextMessageForPrompt,
  stripHistoricalRuntimeContextCustomMessages,
} from "../../internal-runtime-context.js";
import type { Agent, AgentMessage } from "../../runtime/index.js";
import { stripToolResultDetails } from "../../session-transcript-repair.js";
import { normalizeAssistantReplayContent } from "../replay-history.js";
import {
  contentMatchesTimestampOverride,
  findActiveUserMessageIndex,
  hasNonBlankUserText,
  isUserTextBlock,
  projectPersistedSenderContext,
  resolveUserTranscriptMessages,
  type CurrentUserTimestampMatch,
  type UserTranscriptContext,
} from "./attempt-history.js";
import {
  materializeSteeringRuntimeContext,
  type RuntimeContextCustomMessage,
} from "./runtime-context-prompt.js";

const runtimeContextDetailsSchema = z.object({
  source: z.literal("openclaw-runtime-context"),
  runtimeContextCarrier: z.literal(true),
  fragments: z.array(
    z.object({
      kind: z.enum(["runtime-instruction", "conversation-data", "heartbeat-outcome"]),
      text: z.string(),
    }),
  ),
});
const systemUpdateDetailsSchema = z.object({
  kind: z.enum(["prompt-update", "runtime-context"]),
  turnScoped: z.boolean(),
});

type LlmBoundaryOptions = {
  sessionVersion?: number;
  appendOnlyRuntimeContext?: boolean;
  inHistorySystemUpdates?: boolean;
  timezone?: string;
  includeTimestamp?: boolean;
  projectPersistedSenderContext?: boolean;
  userTranscriptContexts?: readonly UserTranscriptContext[];
  currentUserTimestampOverride?: CurrentUserTimestampMatch;
  onRuntimeContextCarrierRemoved?: (removed: AgentMessage[]) => void;
};

/** A session keeps its model projection across replay and process restarts. */
export function usesEscapedRuntimeContext(sessionVersion?: number): boolean {
  if (sessionVersion === undefined || sessionVersion === 3) {
    return false;
  }
  if (sessionVersion === 4) {
    return true;
  }
  throw new Error(`Unsupported session prompt projection version: ${sessionVersion}`);
}

function projectRuntimeContextMessages(
  messages: AgentMessage[],
  options?: LlmBoundaryOptions,
): AgentMessage[] {
  const escape = usesEscapedRuntimeContext(options?.sessionVersion);
  return messages.map((message) => {
    if (message.role === "custom" && isOpenClawSystemUpdateMessage(message)) {
      const details = systemUpdateDetailsSchema.safeParse(message.details);
      if (details.success) {
        const projected: UserMessage = {
          role: "user",
          content: message.content,
          timestamp: message.timestamp,
        };
        if (options?.inHistorySystemUpdates) {
          projected.operatorMessage = { turnScoped: details.data.turnScoped };
        }
        return projected;
      }
    }
    if (!escape || (message.role === "user" && message.operatorMessage)) {
      return message;
    }
    if (message.role === "custom" && message.customType === OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE) {
      const details = runtimeContextDetailsSchema.safeParse(message.details);
      if (details.success) {
        const projected = projectRuntimeContextFragments(details.data.fragments);
        return {
          ...message,
          content:
            typeof message.content === "string" && hasLegacyRuntimeContextEnvelope(message.content)
              ? `${RUNTIME_CONTEXT_BEGIN_MARKER}\n${projected}\n${RUNTIME_CONTEXT_END_MARKER}`
              : projected,
          details: details.data,
        };
      }
    }
    if (message.role !== "user" && message.role !== "custom") {
      return message;
    }
    const content = message.content;
    const projected =
      typeof content === "string"
        ? escapeInternalRuntimeContextDelimiters(content)
        : content.map((block) =>
            block.type === "text"
              ? Object.assign({}, block, {
                  text: escapeInternalRuntimeContextDelimiters(block.text),
                })
              : block,
          );
    return Object.assign({}, message, { content: projected });
  });
}

type PromptContextTransform = (
  messages: AgentMessage[],
  signal?: AbortSignal,
) => Promise<AgentMessage[]>;

// Match channel envelopes and previous boundary stamps to avoid double-stamping.
const BOUNDARY_TIMESTAMP_ENVELOPE_RE = /^\[.*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;
const BOUNDARY_CRON_TIME_MARKER = "Current time: ";

export function normalizeMessagesForLlmBoundary(
  messages: AgentMessage[],
  options?: LlmBoundaryOptions,
): AgentMessage[] {
  const normalized = stripUnsafeBlockedRunMetadata(
    stripToolResultDetails(
      normalizeAssistantReplayContent(materializeSteeringRuntimeContext(messages)),
    ),
  );
  const userTranscriptMessages = resolveUserTranscriptMessages(
    normalized,
    options?.userTranscriptContexts,
    options?.currentUserTimestampOverride,
  );
  const normalizedUserMessages = normalizeUserMessagesForLlmBoundary(
    normalized.map((message, index) =>
      projectRecordedModelPrompt(message, userTranscriptMessages?.[index]),
    ),
    options,
  );
  const withPersistedSenderContext =
    options?.projectPersistedSenderContext === false
      ? normalizedUserMessages
      : projectPersistedSenderContext(normalizedUserMessages, userTranscriptMessages);
  // Prefix-bound thinking must replay every earlier carrier in its original position.
  const retained =
    options?.appendOnlyRuntimeContext || options?.inHistorySystemUpdates
      ? withPersistedSenderContext
      : stripHistoricalRuntimeContextCustomMessages(withPersistedSenderContext);
  if (retained.length < withPersistedSenderContext.length) {
    const retainedMessages = new Set(retained);
    options?.onRuntimeContextCarrierRemoved?.(
      withPersistedSenderContext.filter((message) => !retainedMessages.has(message)),
    );
  }
  return projectRuntimeContextMessages(retained, options);
}

type CurrentPromptBoundaryInput = {
  sessionVersion?: number;
  appendOnlyRuntimeContext?: boolean;
  inHistorySystemUpdates?: boolean;
  prompt: string;
  timezone?: string;
  includeTimestamp?: boolean;
  currentUserTimestamp?: number;
  currentUserTranscriptMessage?: AgentMessage;
};

/** Normalizes existing transcript messages as if the current prompt were appended last. */
export function normalizeMessagesForCurrentPromptBoundary(
  params: CurrentPromptBoundaryInput & { messages: AgentMessage[] },
): AgentMessage[] {
  const { message, options } = buildCurrentPromptBoundaryInput(params);
  return normalizeMessagesForLlmBoundary([...params.messages, message], options).slice(0, -1);
}

export function normalizeCurrentPromptTextForLlmBoundary(
  params: CurrentPromptBoundaryInput,
): string {
  const { message, options } = buildCurrentPromptBoundaryInput(params);
  const [normalized] = normalizeMessagesForLlmBoundary([message], options);
  const content = (normalized as { content?: unknown } | undefined)?.content;
  return typeof content === "string" ? content : params.prompt;
}

function buildCurrentPromptBoundaryInput(params: CurrentPromptBoundaryInput): {
  message: AgentMessage;
  options: LlmBoundaryOptions;
} {
  const message = {
    role: "user",
    content: [{ type: "text", text: params.prompt }],
    timestamp: params.currentUserTimestamp ?? Date.now(),
  } as AgentMessage;
  const options: LlmBoundaryOptions = {
    sessionVersion: params.sessionVersion,
    appendOnlyRuntimeContext: params.appendOnlyRuntimeContext,
    inHistorySystemUpdates: params.inHistorySystemUpdates,
    ...(params.timezone ? { timezone: params.timezone } : {}),
    ...(params.includeTimestamp === false ? { includeTimestamp: false } : {}),
    ...(params.currentUserTranscriptMessage
      ? {
          userTranscriptContexts: [
            {
              runtimeMessage: message,
              transcriptMessage: params.currentUserTranscriptMessage,
            },
          ],
        }
      : {}),
  };
  return { message, options };
}

/**
 * Temporarily injects a runtime-context message for prompt conversion and retry.
 * Cleanup restores the original prompt/continuation hooks and removes only
 * the injected message object.
 */
export function installRuntimeContextMessageForPrompt(params: {
  session: {
    messages: AgentMessage[];
    agent: {
      state: { messages: AgentMessage[] };
      prompt?: Agent["prompt"];
      continue?: Agent["continue"];
      transformContext?: PromptContextTransform;
    };
  };
  message?: RuntimeContextCustomMessage;
  persistedUserIdempotencyKey?: string;
}): () => void {
  const { message, session } = params;
  if (!message) {
    return () => undefined;
  }
  const owner = retainRuntimeContextMessageForPrompt(message);
  let retired = false;
  const install = (retry: boolean) => {
    if (retired) {
      return;
    }
    const messages = session.messages;
    if (messages.includes(message)) {
      return;
    }
    const canonicalUser = owner.transcriptUser ?? owner.user;
    const canonicalKey =
      typeof canonicalUser === "object" && canonicalUser !== null
        ? Reflect.get(canonicalUser, "idempotencyKey")
        : undefined;
    const userIdempotencyKey =
      owner.transcriptUser === undefined
        ? (params.persistedUserIdempotencyKey ?? canonicalKey)
        : canonicalKey;
    const userIndex = userIdempotencyKey
      ? messages.findIndex(
          (candidate) =>
            candidate.role === "user" &&
            Reflect.get(candidate, "idempotencyKey") === userIdempotencyKey,
        )
      : owner.user
        ? messages.findIndex(
            (candidate) => candidate === owner.user || candidate === owner.transcriptUser,
          )
        : retry
          ? findActiveUserMessageIndex(messages)
          : -1;
    // Compaction restores canonical transcript objects. Keep the original user's
    // recorded key/reference; never attach its context to a later steering user.
    if (retry && userIndex < 0) {
      return;
    }
    const index = userIndex < 0 ? messages.length : userIndex;
    session.agent.state.messages = [...messages.slice(0, index), message, ...messages.slice(index)];
  };
  install(false);
  const agent = session.agent;
  const originalTransformContext = agent.transformContext;
  agent.transformContext = async (messages, signal) => {
    // Capture source identity before prompt hooks and replay sanitizers clone it.
    owner.user ??= messages[resolveRuntimeContextPromptOwner(messages)?.userIndex ?? -1];
    return originalTransformContext
      ? await originalTransformContext.call(agent, messages, signal)
      : messages;
  };
  const originalPrompt = agent.prompt;
  if (originalPrompt) {
    const promptWithAgent = originalPrompt.bind(agent);
    agent.prompt = function promptWithRuntimeContext(
      input: string | AgentMessage | AgentMessage[],
      images?: ImageContent[],
    ): Promise<void> {
      // SDK pre-prompt compaction can rebuild history before this first call.
      // Install before input normalization and initial steering to bind the original user.
      install(false);
      return typeof input === "string" ? promptWithAgent(input, images) : promptWithAgent(input);
    };
  }
  const originalContinue = agent.continue;
  if (originalContinue) {
    const continueWithAgent = originalContinue.bind(agent);
    agent.continue = function continueWithRuntimeContext(): Promise<void> {
      // Pi overflow recovery can rebuild state from the persisted branch before retrying.
      install(true);
      return continueWithAgent();
    };
  }
  return () => {
    retired = true;
    owner.release();
    agent.transformContext = originalTransformContext;
    if (originalPrompt) {
      agent.prompt = originalPrompt;
    }
    if (originalContinue) {
      agent.continue = originalContinue;
    }
    session.agent.state.messages = session.messages.filter((candidate) => candidate !== message);
  };
}

function composeModelPromptContext(params: {
  prompt: string;
  prependContext?: string;
  appendContext?: string;
}): string {
  return [params.prependContext, params.prompt, params.appendContext]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n");
}

/** Capture the admitted prompt once; every later request reads the same transcript field. */
export function installModelPromptProjection(params: {
  session: {
    agent: { transformContext?: PromptContextTransform; state?: { messages: AgentMessage[] } };
  };
  transcriptPrompt: string;
  modelPrompt?: string;
  prependContext?: string;
  appendContext?: string;
  shouldCapturePrompt: () => boolean;
  recorder?: UserTurnTranscriptRecorder;
  getUserTranscriptContexts?: () => readonly UserTranscriptContext[] | undefined;
  withTranscriptWrite?: <T>(write: () => Promise<T>) => Promise<T>;
  assertCurrent?: () => void;
}): () => void {
  if (
    (!params.modelPrompt?.trim() || params.modelPrompt === params.transcriptPrompt) &&
    !params.prependContext?.trim() &&
    !params.appendContext?.trim()
  ) {
    return () => {};
  }
  const agent = params.session.agent;
  const originalTransformContext = agent.transformContext;
  let targetPrompt: AgentMessage | undefined;
  let promptOwner:
    | NonNullable<ReturnType<typeof resolveRuntimeContextPromptOwner>>["owner"]
    | undefined;
  agent.transformContext = async (messages, signal) => {
    let promptMessages = messages;
    const assertCurrent = () => {
      signal?.throwIfAborted();
      params.assertCurrent?.();
    };
    if (params.shouldCapturePrompt()) {
      await params.recorder?.waitForRuntimePersistence();
      assertCurrent();
      const recorded = params.recorder?.getPersistedMessage?.();
      if (!targetPrompt) {
        const retained = resolveRuntimeContextPromptOwner(messages);
        const key = recorded?.idempotencyKey;
        const paired = params
          .getUserTranscriptContexts?.()
          ?.find(
            ({ transcriptMessage }) =>
              transcriptMessage === recorded ||
              (key && Reflect.get(transcriptMessage, "idempotencyKey") === key),
          )?.runtimeMessage;
        targetPrompt = params.recorder
          ? messages.find(
              (message) =>
                message === paired ||
                message === recorded ||
                (key && message.role === "user" && Reflect.get(message, "idempotencyKey") === key),
            )
          : messages[retained?.userIndex ?? findActiveUserMessageIndex(messages)];
        promptOwner = retained?.owner;
      }
      const canonicalPrompt = recorded ?? promptOwner?.transcriptUser ?? targetPrompt;
      const key = asOptionalObjectRecord(canonicalPrompt)?.idempotencyKey;
      const target = messages.find(
        (message) =>
          message === targetPrompt ||
          message === canonicalPrompt ||
          (key && message.role === "user" && Reflect.get(message, "idempotencyKey") === key),
      );
      if (target?.role === "user") {
        const firstText =
          typeof target.content === "string"
            ? target.content
            : target.content.find(isUserTextBlock)?.text;
        const targetProjection = readModelPromptProjection(target);
        const frozen = readModelPromptProjection(canonicalPrompt) ?? targetProjection;
        let text =
          frozen ??
          (firstText === undefined
            ? undefined
            : params.modelPrompt?.trim() && firstText === params.transcriptPrompt
              ? params.modelPrompt
              : composeModelPromptContext({
                  prompt: firstText,
                  prependContext: params.prependContext,
                  appendContext: params.appendContext,
                }));
        if (text !== undefined && (frozen !== undefined || text !== firstText)) {
          const captureProjection = params.recorder?.captureModelPromptProjection;
          // A fallback retry can change the prompt after the turn already reached a provider
          // unprojected. Its text stays request-local; history keeps the bytes first sent.
          const sentUnprojected =
            frozen === undefined &&
            params.recorder !== undefined &&
            getUserTurnTranscriptAdmissionOwner(params.recorder)?.sentToProvider() === true;
          if (frozen === undefined && captureProjection && !sentUnprojected) {
            const pendingText = text;
            const capture = () => captureProjection(pendingText, assertCurrent);
            const captured = await (params.withTranscriptWrite
              ? params.withTranscriptWrite(capture)
              : capture());
            assertCurrent();
            text = readModelPromptProjection(captured);
            if (text === undefined) {
              throw new Error("Transcript recorder did not capture the model prompt projection");
            }
          }
          // Replay snapshots are immutable. Publish the same recorded fact on
          // the runtime view without changing its original transcript text.
          if (targetProjection !== text) {
            const projectedTarget = {
              ...target,
              __openclaw: {
                ...asOptionalObjectRecord(Reflect.get(target, "__openclaw")),
                modelPromptProjection: { version: 1, text },
              },
            };
            promptMessages = messages.map((message) =>
              message === target ? projectedTarget : message,
            );
            if (agent.state && !sentUnprojected) {
              agent.state.messages = agent.state.messages.map((message) =>
                message === target ? projectedTarget : message,
              );
            }
          }
        }
      }
    }
    return originalTransformContext
      ? await originalTransformContext.call(agent, promptMessages, signal)
      : promptMessages;
  };
  return () => {
    agent.transformContext = originalTransformContext;
  };
}

// Current text-only turns arrive as arrays; stored turns are strings. Keep their
// provider bytes identical without collapsing attachment or multi-block turns (#3658).
function canonicalizeTextOnlyUserContent(content: unknown): unknown {
  if (!Array.isArray(content) || content.length !== 1) {
    return content;
  }
  const block = content[0];
  return isUserTextBlock(block) ? block.text : content;
}

// Stamp from the message's fixed timestamp so current and historical turns share
// cache bytes. Existing channel/cron envelopes and inter-session prompts stay intact.
function stampUserTextWithMessageTimestamp(
  text: string,
  timestamp: unknown,
  timezone: string | undefined,
  includeTimestamp: boolean | undefined,
): string {
  // A resolved timezone opts the caller into stamping.
  if (
    includeTimestamp === false ||
    !timezone ||
    !text.trim() ||
    BOUNDARY_TIMESTAMP_ENVELOPE_RE.test(text) ||
    text.includes(BOUNDARY_CRON_TIME_MARKER) ||
    text.startsWith(INTER_SESSION_PROMPT_PREFIX_BASE) ||
    typeof timestamp !== "number" ||
    !Number.isFinite(timestamp)
  ) {
    return text;
  }
  const prefix = buildTimestampPrefix(new Date(timestamp), { timezone });
  return prefix ? `${prefix}${text}` : text;
}

function messageRuntimeTimestampMatchesCurrentUserOverride(
  runtimeTimestamp: unknown,
  override: NonNullable<LlmBoundaryOptions["currentUserTimestampOverride"]>,
): boolean {
  if (typeof override.runtimeTimestamp === "number") {
    return runtimeTimestamp === override.runtimeTimestamp;
  }
  if (typeof runtimeTimestamp === "number" && Number.isFinite(runtimeTimestamp)) {
    override.runtimeTimestamp = runtimeTimestamp;
  }
  return true;
}

function normalizeUserMessagesForLlmBoundary(
  messages: AgentMessage[],
  options: LlmBoundaryOptions | undefined,
): AgentMessage[] {
  const activeUserMessageIndex = findActiveUserMessageIndex(messages);
  const prompt = resolveRuntimeContextPromptOwner(messages);
  const promptUserMessageIndex = prompt?.userIndex ?? -1;
  if (prompt) {
    // The persistence owner already records this exact pair, including keyless
    // users and write-hook replacements. Retain it for same-attempt compaction.
    prompt.owner.transcriptUser =
      options?.userTranscriptContexts?.find(
        (context) => context.runtimeMessage === prompt.owner.user,
      )?.transcriptMessage ?? prompt.owner.transcriptUser;
  }
  let changed = false;
  const nextMessages = messages.map((message, index) => {
    if (message.role !== "user" || message.operatorMessage) {
      return message;
    }
    const content = (message as { content?: unknown }).content;
    const injectMediaText = !hasNonBlankUserText(content) && hasPersistedMedia(message);
    const isActive =
      index === activeUserMessageIndex ||
      (promptUserMessageIndex >= 0 && index >= promptUserMessageIndex);
    const override = options?.currentUserTimestampOverride;
    const runtimeTimestamp = (message as { timestamp?: unknown }).timestamp;
    const useCurrentUserTimestampOverride =
      override !== undefined &&
      (isActive ||
        (typeof override.runtimeTimestamp === "number" &&
          override.runtimeTimestamp === runtimeTimestamp)) &&
      contentMatchesTimestampOverride(content, override) &&
      messageRuntimeTimestampMatchesCurrentUserOverride(runtimeTimestamp, override);
    const messageTimestamp = useCurrentUserTimestampOverride
      ? override.timestamp
      : runtimeTimestamp;

    // Preserve the first submission's metadata when this turn becomes history.
    const transformText = (raw: string): string => {
      // Restore late-media paths only for blank media turns, never into transcript storage.
      const sourceText =
        injectMediaText && !raw.trim()
          ? (buildLateMediaAttachedProjection(message).text ?? MEDIA_ONLY_USER_TEXT)
          : raw;
      return stampUserTextWithMessageTimestamp(
        sourceText,
        messageTimestamp,
        options?.timezone,
        options?.includeTimestamp,
      );
    };

    const canonical = canonicalizeTextOnlyUserContent(content);
    if (typeof canonical === "string") {
      const next = transformText(canonical);
      if (next === content) {
        return message;
      }
      changed = true;
      return { ...message, content: next } as AgentMessage;
    }

    if (!Array.isArray(content)) {
      return message;
    }

    // Stamp only the first text block; preserve all later blocks verbatim.
    let contentChanged = false;
    let processedFirstText = false;
    const nextContent = content.map((block) => {
      if (!isUserTextBlock(block)) {
        return block;
      }
      const nextText = processedFirstText ? block.text : transformText(block.text);
      processedFirstText = true;
      if (nextText === block.text) {
        return block;
      }
      contentChanged = true;
      return Object.assign({}, block, { text: nextText });
    });
    if (!processedFirstText && injectMediaText) {
      nextContent.unshift({ type: "text", text: transformText("") });
      contentChanged = true;
    }
    if (!contentChanged) {
      return message;
    }
    changed = true;
    return { ...message, content: nextContent } as AgentMessage;
  });
  return changed ? nextMessages : messages;
}

function stripUnsafeBlockedRunMetadata(messages: AgentMessage[]): AgentMessage[] {
  let changed = false;
  const nextMessages = messages.map((message) => {
    const openclaw = Reflect.get(message, "__openclaw");
    if (!openclaw || typeof openclaw !== "object") {
      return message;
    }
    const beforeAgentRunBlocked = (openclaw as { beforeAgentRunBlocked?: unknown })
      .beforeAgentRunBlocked;
    if (!beforeAgentRunBlocked || typeof beforeAgentRunBlocked !== "object") {
      return message;
    }
    const blocked = beforeAgentRunBlocked as Record<string, unknown>;
    const safeBlocked: Record<string, unknown> = {};
    if (typeof blocked.blockedBy === "string") {
      safeBlocked.blockedBy = blocked.blockedBy;
    }
    if (typeof blocked.blockedAt === "number") {
      safeBlocked.blockedAt = blocked.blockedAt;
    }
    const nextOpenClaw = {
      ...(openclaw as Record<string, unknown>),
      beforeAgentRunBlocked: safeBlocked,
    };
    changed = true;
    return Object.assign({}, message, {
      __openclaw: nextOpenClaw,
    });
  });
  return changed ? nextMessages : messages;
}
