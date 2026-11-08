import { Routes } from "discord-api-types/v10";
import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { resolveChannelModelOverride } from "openclaw/plugin-sdk/model-session-runtime";
import { generateConversationLabel } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateWithMarker } from "openclaw/plugin-sdk/string-normalization-runtime";
import { ChannelType, createThread, getChannelMessage } from "../internal/discord.js";
import { registerPendingDiscordAutoThread } from "../pending-auto-thread.js";
import { resolveDiscordMessageChannelId } from "./message-channel-info.js";
import { resolveDiscordReplyDeliveryPlan, sanitizeDiscordThreadName } from "./threading.starter.js";
import type {
  DiscordAutoThreadContext,
  DiscordAutoThreadReplyPlan,
  DiscordMessageEvent,
  DiscordPendingAutoThread,
  MaybeCreateDiscordAutoThreadParams,
} from "./threading.types.js";

const DEFAULT_THREAD_TITLE_TIMEOUT_MS = 60_000;
const MAX_THREAD_TITLE_SOURCE_CHARS = 600;
const MAX_THREAD_TITLE_CHANNEL_NAME_CHARS = 120;
const MAX_THREAD_TITLE_CHANNEL_DESCRIPTION_CHARS = 320;
const DISCORD_THREAD_TITLE_SYSTEM_PROMPT =
  "Generate a concise Discord thread title (3-6 words) in sentence case: capitalize only the first word and words that are always capitalized. Return only the title. Use channel context when provided and avoid redundant channel-name words unless needed for clarity.";

function truncateThreadTitleText(text: string, maxChars: number): string {
  return truncateWithMarker(text, maxChars, { marker: "...", reserve: 0, trimEnd: false });
}

function normalizeGeneratedThreadTitle(raw: string): string {
  const firstLine = raw
    .replace(/\r/g, "")
    .split("\n")
    .find((line) => line.trim() && !line.trim().startsWith("```"));
  return stripThreadTitleWrappers(firstLine ?? "");
}

function stripThreadTitleWrappers(raw: string): string {
  let current = raw.trim();
  let previous = "";
  while (current && current !== previous) {
    previous = current;
    current = current.replace(/^["'`]+|["'`]+$/g, "").trim();
    // Preserve separate spans ("*Plan* for *project*") while unwrapping nested emphasis.
    for (const marker of ["**", "__", "*", "_", "~~"]) {
      current = stripBalancedWrapper(current, marker);
    }
  }
  return current;
}

function stripBalancedWrapper(text: string, marker: string): string {
  if (text.length < marker.length * 2 + 1 || !text.startsWith(marker) || !text.endsWith(marker)) {
    return text;
  }
  const inner = text.slice(marker.length, text.length - marker.length);
  return inner.includes(marker) ? text : inner;
}

function normalizeTitleContextField(raw: string | undefined, maxChars: number): string | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  return truncateThreadTitleText(value.replace(/\s+/g, " "), maxChars);
}

function resolveTrimmedDiscordMessageChannelId(params: {
  message: DiscordMessageEvent["message"];
  messageChannelId?: string;
}) {
  return (
    params.messageChannelId ||
    resolveDiscordMessageChannelId({
      message: params.message,
    })
  ).trim();
}

export function resolveDiscordAutoThreadContext(params: {
  agentId: string;
  channel: string;
  parentSessionKey: string;
  createdThreadId?: string | null;
  groupScope?: "main" | "per-group";
  parentInheritanceEnabled?: boolean;
}): DiscordAutoThreadContext | null {
  const createdThreadId = normalizeOptionalStringifiedId(params.createdThreadId) ?? "";
  if (!createdThreadId) {
    return null;
  }
  const parentSessionKey = normalizeOptionalString(params.parentSessionKey) ?? "";
  if (!parentSessionKey) {
    return null;
  }

  const threadSessionKey =
    params.groupScope === "main"
      ? parentSessionKey
      : buildAgentSessionKey({
          agentId: params.agentId,
          channel: params.channel,
          peer: { kind: "channel", id: createdThreadId },
        });
  const inheritsDistinctParent = threadSessionKey !== parentSessionKey;

  return {
    createdThreadId,
    From: `${params.channel}:channel:${createdThreadId}`,
    To: `channel:${createdThreadId}`,
    OriginatingTo: `channel:${createdThreadId}`,
    SessionKey: threadSessionKey,
    ...(inheritsDistinctParent ? { ModelParentSessionKey: parentSessionKey } : {}),
    ...(inheritsDistinctParent && params.parentInheritanceEnabled === true
      ? { ParentSessionKey: parentSessionKey }
      : {}),
  };
}

export async function resolveDiscordAutoThreadReplyPlan(
  params: MaybeCreateDiscordAutoThreadParams & {
    replyToMode: ReplyToMode;
    parentSessionKey: string;
    groupScope?: "main" | "per-group";
    threadParentInheritanceEnabled?: boolean;
  },
): Promise<DiscordAutoThreadReplyPlan> {
  const messageChannelId = resolveTrimmedDiscordMessageChannelId(params);
  const targetChannelId = params.threadChannel?.id ?? (messageChannelId || "unknown");
  const originalReplyTarget = `channel:${targetChannelId}`;
  const createParams = { ...params, messageChannelId: messageChannelId || undefined };
  const deferred = resolveDiscordAutoThreadMode(params.channelConfig) === "on-first-message";
  const pendingAutoThread = deferred ? planDeferredDiscordAutoThread(createParams) : undefined;
  if (pendingAutoThread) {
    // From here on, the first outbound send into this thread id opens it.
    registerPendingDiscordAutoThread(pendingAutoThread);
  }
  const createdThreadId = deferred
    ? pendingAutoThread?.threadId
    : await maybeCreateDiscordAutoThread(createParams);
  const deliveryPlan = resolveDiscordReplyDeliveryPlan({
    replyTarget: originalReplyTarget,
    replyToMode: params.replyToMode,
    messageId: params.message.id,
    threadChannel: params.threadChannel,
    createdThreadId,
  });
  const autoThreadContext = params.isGuildMessage
    ? resolveDiscordAutoThreadContext({
        ...params,
        createdThreadId,
        parentInheritanceEnabled: params.threadParentInheritanceEnabled,
      })
    : null;
  return {
    ...deliveryPlan,
    autoThreadContext,
    ...(pendingAutoThread ? { pendingAutoThread } : {}),
  };
}

export type DiscordAutoThreadMode = "off" | "immediate" | "on-first-message";

export function resolveDiscordAutoThreadMode(
  channelConfig: MaybeCreateDiscordAutoThreadParams["channelConfig"],
): DiscordAutoThreadMode {
  const value = channelConfig?.autoThread;
  if (value === "on-first-message") {
    return "on-first-message";
  }
  return value ? "immediate" : "off";
}

function isDiscordAutoThreadCandidate(params: MaybeCreateDiscordAutoThreadParams): boolean {
  if (!params.isGuildMessage || !params.channelConfig?.autoThread || params.threadChannel) {
    return false;
  }
  return !(
    params.channelType === ChannelType.GuildForum ||
    params.channelType === ChannelType.GuildMedia ||
    params.channelType === ChannelType.GuildVoice ||
    params.channelType === ChannelType.GuildStageVoice
  );
}

async function findExistingDiscordAutoThreadId(
  params: MaybeCreateDiscordAutoThreadParams,
  messageChannelId: string,
): Promise<string | undefined> {
  try {
    const message = await getChannelMessage(
      params.client.rest,
      messageChannelId,
      params.message.id,
    );
    const existingThreadId = message?.thread?.id;
    if (existingThreadId) {
      return existingThreadId;
    }
  } catch {
    // Best effort only. A failed message refetch must not block creating the thread.
  }
  return undefined;
}

/** Creates the Discord thread under the message and, for "generated" naming, starts the async rename. */
async function createDiscordAutoThread(
  params: MaybeCreateDiscordAutoThreadParams,
  messageChannelId: string,
): Promise<string | undefined> {
  const rawThreadSource = params.baseText || params.combinedBody || "Thread";
  const threadName = sanitizeDiscordThreadName(rawThreadSource, params.message.id);
  const archiveDuration = params.channelConfig?.autoArchiveDuration
    ? Number(params.channelConfig.autoArchiveDuration)
    : 60;

  const created = await createThread<{ id?: string }>(
    params.client.rest,
    messageChannelId,
    {
      body: {
        name: threadName,
        auto_archive_duration: archiveDuration,
      },
    },
    params.message.id,
  );
  const createdId = created?.id || "";
  if (createdId && params.channelConfig?.autoThreadName === "generated") {
    const { client, channelName, channelDescription, cfg, agentId, channel } = params;
    const parentSessionKey = buildAgentSessionKey({
      agentId,
      channel,
      peer: { kind: "channel", id: messageChannelId },
    });
    const channelLabel = channelName?.trim();
    const groupChannel = channelLabel ? `#${channelLabel}` : undefined;
    const modelRef = resolveChannelModelOverride({
      cfg,
      channel,
      groupId: createdId,
      groupChatType: "channel",
      groupChannel,
      groupSubject: groupChannel,
      parentSessionKey,
    })?.model;
    const fallbackId = params.message.id;
    void (async (): Promise<void> => {
      try {
        const fallbackName = sanitizeDiscordThreadName("", fallbackId);
        const sourceText = rawThreadSource.trim();
        const rawChannelName = channelName;
        const rawChannelDescription = channelDescription;
        let generated: string | null = null;
        if (sourceText) {
          try {
            const titleSourceText = truncateThreadTitleText(
              sourceText,
              MAX_THREAD_TITLE_SOURCE_CHARS,
            );
            const titleChannelName = normalizeTitleContextField(
              rawChannelName,
              MAX_THREAD_TITLE_CHANNEL_NAME_CHARS,
            );
            const titleChannelDescription = normalizeTitleContextField(
              rawChannelDescription,
              MAX_THREAD_TITLE_CHANNEL_DESCRIPTION_CHARS,
            );
            const userMessage = [
              titleChannelName ? `Channel: ${titleChannelName}` : undefined,
              titleChannelDescription
                ? `Channel description: ${titleChannelDescription}`
                : undefined,
              `Message:\n${titleSourceText}`,
            ]
              .filter(Boolean)
              .join("\n\n");
            const label = await generateConversationLabel({
              cfg,
              agentId,
              userMessage,
              prompt: DISCORD_THREAD_TITLE_SYSTEM_PROMPT,
              ...(modelRef ? { modelRef } : {}),
              timeoutMs: DEFAULT_THREAD_TITLE_TIMEOUT_MS,
              maxLength: MAX_THREAD_TITLE_SOURCE_CHARS,
            });
            generated = label ? normalizeGeneratedThreadTitle(label) : null;
          } catch (err) {
            logVerbose(
              `thread-title: title generation failed for agent ${agentId}: ${String(err)}`,
            );
          }
        }
        if (!generated) {
          return;
        }
        const nextName = sanitizeDiscordThreadName(generated, fallbackId);
        if (!nextName || nextName === threadName || nextName === fallbackName) {
          return;
        }
        await client.rest.patch(Routes.channel(createdId), {
          body: { name: nextName },
        });
      } catch (err) {
        logVerbose(`discord: autoThread rename failed for ${createdId}: ${String(err)}`);
      }
    })();
  }
  return createdId || undefined;
}

export async function maybeCreateDiscordAutoThread(
  params: MaybeCreateDiscordAutoThreadParams,
): Promise<string | undefined> {
  if (!isDiscordAutoThreadCandidate(params)) {
    return undefined;
  }
  const messageChannelId = resolveTrimmedDiscordMessageChannelId(params);
  if (!messageChannelId) {
    return undefined;
  }
  try {
    const existingThreadId = await findExistingDiscordAutoThreadId(params, messageChannelId);
    if (existingThreadId) {
      return existingThreadId;
    }
    if (params.message.author?.bot) {
      logVerbose(
        `discord: autoThread skipped for bot-authored message ${messageChannelId}/${params.message.id}`,
      );
      return undefined;
    }
    return await createDiscordAutoThread(params, messageChannelId);
  } catch (err) {
    logVerbose(
      `discord: autoThread creation failed for ${messageChannelId}/${params.message.id}: ${String(err)}`,
    );
    return findExistingDiscordAutoThreadId(params, messageChannelId);
  }
}

/**
 * Plans an `autoThread: "on-first-message"` thread without creating it.
 *
 * Discord gives a thread started from a message the same id as that message, so
 * the session key, `To` target and routing can be fixed now while the actual
 * `createThread` call waits for the first outbound send. `create()` is invoked
 * at most once by the pending-thread registry.
 */
export function planDeferredDiscordAutoThread(
  params: MaybeCreateDiscordAutoThreadParams,
): DiscordPendingAutoThread | undefined {
  if (!isDiscordAutoThreadCandidate(params)) {
    return undefined;
  }
  const messageChannelId = resolveTrimmedDiscordMessageChannelId(params);
  if (!messageChannelId) {
    return undefined;
  }
  if (params.message.author?.bot) {
    logVerbose(
      `discord: autoThread skipped for bot-authored message ${messageChannelId}/${params.message.id}`,
    );
    return undefined;
  }
  return {
    threadId: params.message.id,
    parentChannelId: messageChannelId,
    create: async () => {
      try {
        // A second agent mentioned in the same message may have created it already.
        const existingThreadId = await findExistingDiscordAutoThreadId(params, messageChannelId);
        if (existingThreadId) {
          return existingThreadId;
        }
        return await createDiscordAutoThread(params, messageChannelId);
      } catch (err) {
        logVerbose(
          `discord: autoThread creation failed for ${messageChannelId}/${params.message.id}: ${String(err)}`,
        );
        return findExistingDiscordAutoThreadId(params, messageChannelId);
      }
    },
  };
}
