import { stableStringify } from "@openclaw/normalization-core";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { formatContextJsonBlock } from "../../../auto-reply/reply/channel-prompt-context.js";
import { markInboundContextLabel } from "../../../auto-reply/reply/inbound-context-marker.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import {
  hasInterSessionUserProvenance,
  INTER_SESSION_PROMPT_PREFIX_BASE,
} from "../../../sessions/input-provenance.js";
import { isTextContentBlock } from "../../content-blocks.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import { resolveTranscriptPolicy } from "../../transcript-policy.js";
import type { TranscriptPolicy } from "../../transcript-policy.types.js";
import { isRunnerToolCallBlock } from "./attempt-tool-call-block-type.js";

export type UserTranscriptContext = {
  runtimeMessage: AgentMessage;
  transcriptMessage: AgentMessage;
};

export type CurrentUserTimestampMatch = {
  timestamp: number;
  text: string;
  alternateText?: string;
  runtimeTimestamp?: number;
};

// Mirrors LEADING_TIMESTAMP_PREFIX_RE in strip-inbound-meta.ts so sender
// projection never displaces or duplicates a cache-stable timestamp envelope.
const LEADING_TIMESTAMP_ENVELOPE_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;
const CONVERSATION_INFO_LABEL = markInboundContextLabel("Conversation info:");

export function splitLeadingTimestampEnvelope(text: string): {
  body: string;
  envelope: string;
} {
  const envelope = text.match(LEADING_TIMESTAMP_ENVELOPE_RE)?.[0] ?? "";
  return { envelope, body: envelope ? text.slice(envelope.length) : text };
}

function readFirstUserText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content) ? content.find(isTextContentBlock)?.text : undefined;
}

export function hasNonBlankUserText(content: unknown): boolean {
  return typeof content === "string"
    ? Boolean(content.trim())
    : Array.isArray(content) &&
        content.some((block) => isTextContentBlock(block) && Boolean(block.text.trim()));
}

export function contentMatchesTimestampOverride(
  content: unknown,
  override: CurrentUserTimestampMatch,
): boolean {
  const text = readFirstUserText(content);
  return text !== undefined && (text === override.text || text === override.alternateText);
}

export function resolveUserTranscriptMessages(
  messages: AgentMessage[],
  contexts: readonly UserTranscriptContext[] | undefined,
  override: CurrentUserTimestampMatch | undefined,
): Array<AgentMessage | undefined> | undefined {
  if (!contexts?.length) {
    return undefined;
  }
  const resolved = Array.from(
    { length: messages.length },
    () => undefined as AgentMessage | undefined,
  );
  const unusedContexts = new Set(contexts);
  const byRuntimeMessage = new Map<AgentMessage, UserTranscriptContext[]>();
  for (const context of unusedContexts) {
    const bucket = byRuntimeMessage.get(context.runtimeMessage) ?? [];
    bucket.push(context);
    byRuntimeMessage.set(context.runtimeMessage, bucket);
  }
  // Reserve object-identity matches before structural fallback so duplicate
  // timestamp/text turns cannot consume a later message's exact pairing.
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user" || message.operatorMessage) {
      continue;
    }
    const context = byRuntimeMessage.get(message)?.shift();
    if (!context) {
      continue;
    }
    resolved[index] = context.transcriptMessage;
    unusedContexts.delete(context);
  }
  if (unusedContexts.size === 0) {
    return resolved;
  }
  const byTimestamp = new Map<number, UserTranscriptContext[]>();
  for (const context of unusedContexts) {
    const timestamp = context.runtimeMessage.timestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      continue;
    }
    const bucket = byTimestamp.get(timestamp) ?? [];
    bucket.push(context);
    byTimestamp.set(timestamp, bucket);
  }
  const activeUserMessageIndex = findActiveUserMessageIndex(messages);
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user" || message.operatorMessage || resolved[index]) {
      continue;
    }
    const timestamp = message.timestamp;
    const candidates = typeof timestamp === "number" ? byTimestamp.get(timestamp) : undefined;
    const context = candidates?.find(
      (candidate) =>
        unusedContexts.has(candidate) &&
        userContentMatchesTranscriptContext(
          message.content,
          (candidate.runtimeMessage as { content?: unknown }).content,
          index === activeUserMessageIndex ||
            (typeof override?.runtimeTimestamp === "number" &&
              override.runtimeTimestamp === timestamp)
            ? override
            : undefined,
        ),
    );
    if (!context) {
      continue;
    }
    resolved[index] = context.transcriptMessage;
    unusedContexts.delete(context);
  }
  return resolved;
}

function userContentMatchesTranscriptContext(
  messageContent: unknown,
  runtimeContent: unknown,
  override: CurrentUserTimestampMatch | undefined,
): boolean {
  const messageText = readFirstUserText(messageContent);
  const runtimeText = readFirstUserText(runtimeContent);
  if (messageText !== undefined && messageText === runtimeText) {
    return true;
  }
  if (
    messageText === undefined &&
    runtimeText === undefined &&
    Array.isArray(messageContent) &&
    Array.isArray(runtimeContent) &&
    stableStringify(messageContent) === stableStringify(runtimeContent)
  ) {
    return true;
  }
  return Boolean(
    override &&
    contentMatchesTimestampOverride(messageContent, override) &&
    contentMatchesTimestampOverride(runtimeContent, override),
  );
}

function normalizePersistedSenderValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replaceAll("\u0000", "").trim();
  return normalized || undefined;
}

type PersistedSender = {
  id?: string;
  name?: string;
  username?: string;
};

function readPersistedSender(message: AgentMessage): PersistedSender | undefined {
  const openclaw = Reflect.get(message, "__openclaw");
  if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
    return undefined;
  }
  const meta = openclaw as Record<string, unknown>;
  const sender = {
    id: normalizePersistedSenderValue(meta["senderId"]),
    name: normalizePersistedSenderValue(meta["senderName"]),
    username: normalizePersistedSenderValue(meta["senderUsername"]),
  };
  return Object.values(sender).some((value) => value !== undefined) ? sender : undefined;
}

function mergeSenderIntoLeadingConversationInfo(
  text: string,
  sender: PersistedSender,
): string | undefined {
  const { body, envelope } = splitLeadingTimestampEnvelope(text);
  const jsonPrefix = `${CONVERSATION_INFO_LABEL}\n\`\`\`json\n`;
  if (!body.startsWith(jsonPrefix)) {
    return undefined;
  }
  const jsonEnd = body.indexOf("\n```", jsonPrefix.length);
  if (jsonEnd === -1) {
    return undefined;
  }
  const payload = safeParseJsonRecord(body.slice(jsonPrefix.length, jsonEnd));
  if (!payload) {
    return undefined;
  }
  const suffix = body.slice(jsonEnd + "\n```".length);
  return `${envelope}${formatContextJsonBlock(CONVERSATION_INFO_LABEL, {
    ...payload,
    sender,
  })}${suffix}`;
}

function prependContextToUserMessage(message: AgentMessage, sender: PersistedSender): AgentMessage {
  const context = formatContextJsonBlock(CONVERSATION_INFO_LABEL, { sender });
  const projectText = (text: string): string | undefined => {
    const { body, envelope } = splitLeadingTimestampEnvelope(text);
    if (body === context || body.startsWith(`${context}\n\n`)) {
      return undefined;
    }
    return (
      mergeSenderIntoLeadingConversationInfo(text, sender) ??
      `${envelope}${body ? `${context}\n\n${body}` : context}`
    );
  };
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    const text = projectText(content);
    return text === undefined || text === content
      ? message
      : ({ ...message, content: text } as AgentMessage);
  }
  if (!Array.isArray(content)) {
    return message;
  }

  const textIndex = content.findIndex(isTextContentBlock);
  if (textIndex === -1) {
    return {
      ...message,
      content: [{ type: "text", text: context }, ...content],
    } as AgentMessage;
  }
  const textBlock = content[textIndex] as { text: string };
  const text = projectText(textBlock.text);
  if (text === undefined) {
    return message;
  }
  const nextContent = content.slice();
  nextContent[textIndex] = { ...textBlock, text };
  return { ...message, content: nextContent } as AgentMessage;
}

function hasInterSessionPromptPrefix(message: AgentMessage): boolean {
  const text = readFirstUserText((message as { content?: unknown }).content);
  return (
    text !== undefined &&
    splitLeadingTimestampEnvelope(text).body.startsWith(INTER_SESSION_PROMPT_PREFIX_BASE)
  );
}

export function projectPersistedSenderContext(
  messages: AgentMessage[],
  transcriptMessages?: readonly (AgentMessage | undefined)[],
): AgentMessage[] {
  let changed = false;
  const nextMessages = messages.map((message, index) => {
    if (message.role !== "user" || message.operatorMessage) {
      return message;
    }
    const transcriptMessage = transcriptMessages?.[index] ?? message;
    // Inter-session provenance must remain the first model-facing safety text.
    // Its own source envelope already identifies the routed origin.
    if (
      hasInterSessionUserProvenance(message) ||
      hasInterSessionUserProvenance(transcriptMessage) ||
      hasInterSessionPromptPrefix(message) ||
      hasInterSessionPromptPrefix(transcriptMessage)
    ) {
      return message;
    }
    // Group/channel persistence is the product boundary that opts into these
    // existing sender fields. Project every turn, including the active one, so
    // provider bytes stay stable when that same turn becomes historical.
    const sender = readPersistedSender(transcriptMessage);
    if (!sender) {
      return message;
    }
    const nextMessage = prependContextToUserMessage(message, sender);
    changed ||= nextMessage !== message;
    return nextMessage;
  });
  return changed ? nextMessages : messages;
}

export function findActiveUserMessageIndex(messages: AgentMessage[]): number {
  // A prompt turn may be followed by assistant tool-call scaffolding during
  // retry reconstruction. A normal assistant reply means the latest user turn is
  // historical, not the active prompt boundary.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && !message.operatorMessage) {
      return index;
    }
    if (
      message?.role === "assistant" &&
      (!Array.isArray(message.content) || !message.content.some(isRunnerToolCallBlock))
    ) {
      return -1;
    }
  }
  return -1;
}

type AttemptRuntimeModelContext = NonNullable<
  Parameters<AgentRuntimePlan["transcript"]["resolvePolicy"]>[0]
>;

/**
 * Resolves the transcript policy for an embedded attempt. RuntimePlan owns the
 * policy when present; otherwise the older provider/config/env resolver remains
 * the compatibility path for callers that have not produced a runtime plan yet.
 */
export function resolveAttemptTranscriptPolicy(params: {
  runtimePlan?: AgentRuntimePlan;
  runtimePlanModelContext: AttemptRuntimeModelContext;
  provider: string;
  modelId: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): TranscriptPolicy {
  return (
    params.runtimePlan?.transcript.resolvePolicy(params.runtimePlanModelContext) ??
    resolveTranscriptPolicy({
      modelApi: params.runtimePlanModelContext.modelApi,
      directApiKey: params.runtimePlanModelContext.directApiKey,
      provider: params.provider,
      modelId: params.modelId,
      config: params.config,
      workspaceDir: params.runtimePlanModelContext.workspaceDir,
      env: params.env ?? process.env,
      model:
        typeof params.runtimePlanModelContext.model?.id === "string"
          ? (params.runtimePlanModelContext.model as ProviderRuntimeModel)
          : undefined,
    })
  );
}
