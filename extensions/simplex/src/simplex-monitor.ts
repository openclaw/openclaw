import type { ChannelAccountSnapshot, OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { resolveMentionGatingWithBypass } from "openclaw/plugin-sdk";
import { getSimplexRuntime } from "./runtime.js";
import {
  buildCancelFileCommand,
  buildReceiveFileCommand,
  buildSendMessagesCommand,
  formatChatRef,
} from "./simplex-commands.js";
import { resolveSimplexCommandError } from "./simplex-errors.js";
import { buildComposedMessages, resolveSimplexMediaMaxBytes } from "./simplex-media.js";
import { isSimplexAllowlisted } from "./simplex-security.js";
import { SimplexWsClient, type SimplexWsEvent } from "./simplex-ws-client.js";
import type { ResolvedSimplexAccount } from "./types.js";

export type SimplexMonitorOpts = {
  account: ResolvedSimplexAccount;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
};

type SimplexChatItem = {
  chatInfo?: {
    type?: string;
    contact?: { contactId?: number; localDisplayName?: string; profile?: { displayName?: string } };
    groupInfo?: { groupId?: number; localDisplayName?: string };
  };
  chatItem?: {
    chatDir?: {
      type?: string;
      groupMember?: {
        memberId?: string;
        groupMemberId?: number;
        contactId?: number | string;
        localDisplayName?: string;
      };
    };
    meta?: { itemId?: number; itemTs?: string };
    content?: { type?: string; msgContent?: { type?: string; text?: string } };
    file?: {
      fileId?: number;
      fileName?: string;
      fileSize?: number;
      fileSource?: { filePath?: string };
    };
  };
};

const INBOUND_DIRS = new Set(["directRcv", "groupRcv"]);
const PENDING_FILE_TIMEOUT_MS = 90_000;

type PendingInboundFile = {
  fileId: number;
  ctxPayload: Record<string, unknown>;
  storePath: string;
  sessionKey: string;
  chatRef: string;
  rawBody: string;
  account: ResolvedSimplexAccount;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  client: SimplexWsClient;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
};

const pendingFiles = new Map<string, PendingInboundFile>();

function pendingKey(accountId: string, fileId: number): string {
  return `${accountId}:${fileId}`;
}

function normalizeSimplexSenderId(value?: string | null): string | undefined {
  let trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("simplex:")) {
    trimmed = trimmed.slice("simplex:".length).trim();
  }
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("@")) {
    trimmed = trimmed.slice(1).trim();
  } else {
    const kindLower = trimmed.toLowerCase();
    if (kindLower.startsWith("contact:")) {
      trimmed = trimmed.slice("contact:".length).trim();
    } else if (kindLower.startsWith("user:")) {
      trimmed = trimmed.slice("user:".length).trim();
    } else if (kindLower.startsWith("member:")) {
      trimmed = trimmed.slice("member:".length).trim();
    }
  }
  return trimmed || undefined;
}

function resolveMessageText(
  content: { type?: string; text?: string } | undefined,
  fileName?: string,
): string {
  if (!content) {
    return "";
  }
  const text = content.text?.trim() ?? "";
  if (text) {
    return text;
  }
  switch (content.type) {
    case "image":
      return "[image]";
    case "video":
      return "[video]";
    case "voice":
      return "[voice message]";
    case "file":
      return fileName ? `[file: ${fileName}]` : "[file]";
    case "link":
      return "[link]";
    case "report":
      return "[report]";
    case "chat":
      return "[chat]";
    default:
      return "[message]";
  }
}

function isInboundChatItem(item: SimplexChatItem): boolean {
  const dir = item.chatItem?.chatDir?.type;
  return Boolean(dir && INBOUND_DIRS.has(dir));
}

function resolveChatContext(item: SimplexChatItem): {
  chatType: "direct" | "group";
  chatId: number;
  chatLabel: string;
  senderId?: string;
  senderName?: string;
} | null {
  const info = item.chatInfo;
  if (!info || !item.chatItem) {
    return null;
  }
  if (info.type === "direct") {
    const contactId = info.contact?.contactId;
    if (typeof contactId !== "number") {
      return null;
    }
    const senderName =
      info.contact?.localDisplayName?.trim() ||
      info.contact?.profile?.displayName?.trim() ||
      undefined;
    return {
      chatType: "direct",
      chatId: contactId,
      chatLabel: senderName || `contact:${contactId}`,
      senderId: String(contactId),
      senderName,
    };
  }
  if (info.type === "group") {
    const groupId = info.groupInfo?.groupId;
    if (typeof groupId !== "number") {
      return null;
    }
    const member = item.chatItem?.chatDir?.groupMember;
    const contactId =
      typeof member?.contactId === "number"
        ? String(member.contactId)
        : member?.contactId?.trim() || undefined;
    const senderId =
      contactId ??
      member?.memberId?.trim() ??
      (typeof member?.groupMemberId === "number" ? String(member.groupMemberId) : undefined);
    const senderName = member?.localDisplayName?.trim() || undefined;
    const groupLabel = info.groupInfo?.localDisplayName?.trim() || `group:${groupId}`;
    return {
      chatType: "group",
      chatId: groupId,
      chatLabel: groupLabel,
      senderId: senderId || undefined,
      senderName,
    };
  }
  return null;
}

function resolveSimplexGroupRequireMention(params: {
  account: ResolvedSimplexAccount;
  groupId?: number | null;
}): boolean {
  const groupId = params.groupId ? String(params.groupId) : undefined;
  const groups = params.account.config.groups ?? {};
  const entry = groupId ? groups[groupId] : undefined;
  const fallback = groups["*"];
  if (typeof entry?.requireMention === "boolean") {
    return entry.requireMention;
  }
  if (typeof fallback?.requireMention === "boolean") {
    return fallback.requireMention;
  }
  return true;
}

async function sendSimplexPayload(params: {
  client: SimplexWsClient;
  chatRef: string;
  cfg: OpenClawConfig;
  accountId: string;
  payload: {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    audioAsVoice?: boolean;
  };
}): Promise<{ messageId?: number }> {
  const composedMessages = await buildComposedMessages({
    cfg: params.cfg,
    accountId: params.accountId,
    text: params.payload.text,
    mediaUrl: params.payload.mediaUrl,
    mediaUrls: params.payload.mediaUrls,
    audioAsVoice: params.payload.audioAsVoice,
  });
  if (composedMessages.length === 0) {
    return {};
  }
  const cmd = buildSendMessagesCommand({
    chatRef: params.chatRef,
    composedMessages,
  });
  const response = await params.client.sendCommand(cmd);
  const resp = response.resp as {
    type?: string;
    chatError?: { errorType?: { type?: string; message?: string } };
    chatItems?: Array<{ chatItem?: { meta?: { itemId?: number } } }>;
  };
  const commandError = resolveSimplexCommandError(resp);
  if (commandError) {
    throw new Error(commandError);
  }
  if (resp?.type === "newChatItems") {
    const itemId = resp.chatItems?.[0]?.chatItem?.meta?.itemId;
    return { messageId: typeof itemId === "number" ? itemId : undefined };
  }
  return {};
}

export async function startSimplexMonitor(params: SimplexMonitorOpts): Promise<{
  client: SimplexWsClient;
}> {
  const { account, cfg, runtime, statusSink } = params;
  const client = new SimplexWsClient({
    url: account.wsUrl,
    connectTimeoutMs: account.config.connection?.connectTimeoutMs,
    logger: {
      info: (message) => runtime.log?.(message),
      warn: (message) => runtime.error?.(message),
      error: (message) => runtime.error?.(message),
    },
  });

  await connectWithRetry({
    client,
    runtime,
    accountId: account.accountId,
    abortSignal: params.abortSignal,
  });

  const stopListening = client.onEvent(async (event) => {
    try {
      await handleSimplexEvent({ event, account, cfg, runtime, statusSink, client });
    } catch (err) {
      runtime.error?.(`[${account.accountId}] SimpleX event error: ${String(err)}`);
    }
  });

  params.abortSignal.addEventListener(
    "abort",
    () => {
      stopListening();
      client.close().catch((err) => {
        runtime.error?.(`[${account.accountId}] SimpleX close failed: ${String(err)}`);
      });
    },
    { once: true },
  );

  return { client };
}

async function connectWithRetry(params: {
  client: SimplexWsClient;
  runtime: RuntimeEnv;
  accountId: string;
  abortSignal: AbortSignal;
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}): Promise<void> {
  const attempts = params.attempts ?? 10;
  let delayMs = params.baseDelayMs ?? 500;
  const maxDelayMs = params.maxDelayMs ?? 5_000;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (params.abortSignal.aborted) {
      throw new Error("SimpleX connect aborted");
    }
    try {
      await params.client.connect();
      return;
    } catch (err) {
      if (attempt >= attempts) {
        throw err;
      }
      params.runtime.error?.(
        `[${params.accountId}] SimpleX connect failed (attempt ${attempt}/${attempts}): ${String(err)}; retrying in ${delayMs}ms`,
      );
      await sleep(delayMs, params.abortSignal);
      delayMs = Math.min(maxDelayMs, delayMs * 2);
    }
  }
}

function sleep(ms: number, abortSignal: AbortSignal): Promise<void> {
  if (abortSignal.aborted) {
    return Promise.reject(new Error("SimpleX connect aborted"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error("SimpleX connect aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      abortSignal.removeEventListener("abort", onAbort);
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

async function handleSimplexEvent(params: {
  event: SimplexWsEvent;
  account: ResolvedSimplexAccount;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
  client: SimplexWsClient;
}): Promise<void> {
  const { event, account, cfg, runtime, statusSink, client } = params;
  if (event.type === "rcvFileDescrReady") {
    const fileId = Number(
      (event as { rcvFileTransfer?: { fileId?: number } })?.rcvFileTransfer?.fileId,
    );
    if (Number.isFinite(fileId)) {
      await requestFileDownload({ fileId, account, client, runtime });
    }
    return;
  }

  if (event.type === "rcvFileComplete") {
    const chatItem = (event as { chatItem?: SimplexChatItem })?.chatItem;
    const file = chatItem?.chatItem?.file;
    const fileId = typeof file?.fileId === "number" ? file.fileId : null;
    if (fileId && pendingFiles.has(pendingKey(account.accountId, fileId))) {
      const filePath = file?.fileSource?.filePath?.trim();
      await finalizePendingFile({
        accountId: account.accountId,
        fileId,
        filePath,
      });
    }
    return;
  }

  if (event.type !== "newChatItems") {
    return;
  }

  const chatItems = event.chatItems;
  const items = Array.isArray(chatItems) ? (chatItems as SimplexChatItem[]) : [];

  for (const item of items) {
    if (!isInboundChatItem(item)) {
      continue;
    }

    const context = resolveChatContext(item);
    if (!context) {
      continue;
    }

    const content =
      item.chatItem?.content?.type === "rcvMsgContent"
        ? item.chatItem?.content?.msgContent
        : undefined;

    if (!content) {
      continue;
    }

    const rawBody = resolveMessageText(content, item.chatItem?.file?.fileName);
    if (!rawBody) {
      continue;
    }

    const normalizedSenderId = normalizeSimplexSenderId(context.senderId);
    const dmPeerId = normalizedSenderId ?? String(context.chatId);
    const chatRef = formatChatRef({
      type: context.chatType,
      id: context.chatType === "group" ? context.chatId : dmPeerId,
    });

    const core = getSimplexRuntime();

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "simplex",
      accountId: account.accountId,
      peer: {
        kind: context.chatType === "group" ? "group" : "direct",
        id: context.chatType === "group" ? String(context.chatId) : dmPeerId,
      },
    });

    const isGroup = context.chatType === "group";
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
    const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
    const configAllowFrom = (account.config.allowFrom ?? []).map((entry) => String(entry));
    const configGroupAllowFrom = (account.config.groupAllowFrom ?? []).map((entry) =>
      String(entry),
    );
    const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, cfg);
    const shouldLoadAllowFromStore =
      (!isGroup && (dmPolicy !== "open" || shouldComputeAuth)) ||
      (isGroup && (groupPolicy !== "open" || shouldComputeAuth));
    const storeAllowFrom = shouldLoadAllowFromStore
      ? await core.channel.pairing.readAllowFromStore("simplex").catch(() => [])
      : [];
    const effectiveDmAllowFrom = [...configAllowFrom, ...storeAllowFrom];
    const baseGroupAllowFrom =
      configGroupAllowFrom.length > 0 ? configGroupAllowFrom : configAllowFrom;
    const effectiveGroupAllowFrom = [...baseGroupAllowFrom, ...storeAllowFrom];
    const allowlistForCommands = isGroup ? effectiveGroupAllowFrom : effectiveDmAllowFrom;
    const senderAllowedForCommands = isSimplexAllowlisted({
      allowFrom: allowlistForCommands,
      senderId: normalizedSenderId,
      groupId: String(context.chatId),
      allowGroupId: isGroup,
    });
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    const commandAuthorized = shouldComputeAuth
      ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
          useAccessGroups,
          authorizers: [
            {
              configured: allowlistForCommands.length > 0,
              allowed: senderAllowedForCommands,
            },
          ],
        })
      : undefined;

    if (isGroup) {
      if (groupPolicy === "disabled") {
        runtime.log?.(`[${account.accountId}] SimpleX drop group (groupPolicy=disabled)`);
        continue;
      }
      if (groupPolicy === "allowlist") {
        if (effectiveGroupAllowFrom.length === 0) {
          runtime.log?.(
            `[${account.accountId}] SimpleX drop group (groupPolicy=allowlist, empty allowlist)`,
          );
          continue;
        }
        const allowed = isSimplexAllowlisted({
          allowFrom: effectiveGroupAllowFrom,
          senderId: normalizedSenderId,
          groupId: String(context.chatId),
          allowGroupId: true,
        });
        if (!allowed) {
          runtime.log?.(
            `[${account.accountId}] SimpleX drop group sender ${context.senderId ?? "unknown"} (not allowlisted)`,
          );
          continue;
        }
      }
    } else {
      if (dmPolicy === "disabled") {
        runtime.log?.(
          `[${account.accountId}] SimpleX drop DM from ${context.senderId ?? "unknown"} (dmPolicy=disabled)`,
        );
        continue;
      }
      if (dmPolicy !== "open") {
        const allowed = isSimplexAllowlisted({
          allowFrom: effectiveDmAllowFrom,
          senderId: normalizedSenderId,
          allowGroupId: false,
        });
        if (!allowed) {
          if (dmPolicy === "pairing") {
            const senderId = normalizedSenderId ?? String(context.chatId);
            const { code, created } = await core.channel.pairing.upsertPairingRequest({
              channel: "simplex",
              id: senderId,
              meta: { name: context.senderName },
            });
            if (created) {
              runtime.log?.(`[${account.accountId}] SimpleX pairing request sender=${senderId}`);
              try {
                await sendSimplexPayload({
                  client,
                  chatRef,
                  cfg,
                  accountId: account.accountId,
                  payload: {
                    text: core.channel.pairing.buildPairingReply({
                      channel: "simplex",
                      idLine: `Your SimpleX contact id: ${senderId}`,
                      code,
                    }),
                  },
                });
                statusSink?.({ lastOutboundAt: Date.now() });
              } catch (err) {
                runtime.error?.(
                  `[${account.accountId}] SimpleX pairing reply failed: ${String(err)}`,
                );
              }
            }
          } else {
            runtime.log?.(
              `[${account.accountId}] SimpleX drop DM from ${context.senderId ?? "unknown"} (dmPolicy=${dmPolicy})`,
            );
          }
          continue;
        }
      }
    }

    let effectiveWasMentioned: boolean | undefined;
    if (isGroup) {
      const requireMention = resolveSimplexGroupRequireMention({
        account,
        groupId: context.chatId,
      });
      const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
      const wasMentioned = core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes);
      const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
        cfg,
        surface: "simplex",
      });
      const mentionGate = resolveMentionGatingWithBypass({
        isGroup: true,
        requireMention,
        canDetectMention: mentionRegexes.length > 0,
        wasMentioned,
        allowTextCommands,
        hasControlCommand: core.channel.text.hasControlCommand(rawBody, cfg),
        commandAuthorized: commandAuthorized === true,
      });
      effectiveWasMentioned = mentionGate.effectiveWasMentioned;
      if (mentionGate.shouldSkip) {
        runtime.log?.(
          `[${account.accountId}] SimpleX drop group ${context.chatId} (mention required)`,
        );
        continue;
      }
    }

    if (isGroup && core.channel.commands.isControlCommandMessage(rawBody, cfg)) {
      if (commandAuthorized !== true) {
        runtime.log?.(
          `[${account.accountId}] SimpleX drop control command from ${context.senderId ?? "unknown"}`,
        );
        continue;
      }
    }

    const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
      agentId: route.agentId,
    });

    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const previousTimestamp = core.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });

    const fromLabel =
      context.chatType === "group"
        ? `group:${context.chatId}`
        : context.senderName || `contact:${context.senderId ?? "unknown"}`;

    const body = core.channel.reply.formatAgentEnvelope({
      channel: "SimpleX",
      from: fromLabel,
      previousTimestamp,
      envelope: envelopeOptions,
      body: rawBody,
    });

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: rawBody,
      CommandBody: rawBody,
      From:
        context.chatType === "group" ? `simplex:group:${context.chatId}` : `simplex:${dmPeerId}`,
      To: context.chatType === "group" ? `simplex:group:${context.chatId}` : `simplex:${dmPeerId}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: context.chatType === "group" ? "group" : "direct",
      ConversationLabel: fromLabel,
      GroupSubject: context.chatType === "group" ? context.chatLabel : undefined,
      SenderName: context.senderName,
      SenderId: context.senderId,
      Provider: "simplex" as const,
      Surface: "simplex" as const,
      MessageSid:
        typeof item.chatItem?.meta?.itemId === "number"
          ? String(item.chatItem.meta.itemId)
          : undefined,
      WasMentioned: context.chatType === "group" ? effectiveWasMentioned : undefined,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "simplex" as const,
      OriginatingTo:
        context.chatType === "group" ? `simplex:group:${context.chatId}` : `simplex:${dmPeerId}`,
    });

    const fileId = item.chatItem?.file?.fileId;
    const fileSize = item.chatItem?.file?.fileSize;
    const maxBytes = resolveSimplexMediaMaxBytes({
      cfg,
      accountId: account.accountId,
    });

    const pending: PendingInboundFile = {
      fileId: typeof fileId === "number" ? fileId : -1,
      ctxPayload,
      storePath,
      sessionKey: route.sessionKey,
      chatRef,
      rawBody,
      account,
      cfg,
      runtime,
      client,
      statusSink,
    };

    if (typeof fileId === "number") {
      if (typeof fileSize === "number" && fileSize > maxBytes) {
        runtime.error?.(
          `[${account.accountId}] SimpleX file ${fileId} exceeds limit (${fileSize} > ${maxBytes})`,
        );
        continue;
      } else {
        const accepted = await requestFileDownload({ fileId, account, client, runtime });
        if (accepted) {
          pendingFiles.set(pendingKey(account.accountId, fileId), pending);
          setTimeout(() => {
            const key = pendingKey(account.accountId, fileId);
            const current = pendingFiles.get(key);
            if (current) {
              pendingFiles.delete(key);
              void current.client.sendCommand(buildCancelFileCommand(fileId)).catch((err) => {
                runtime.error?.(
                  `[${account.accountId}] SimpleX file timeout cancel failed: ${String(err)}`,
                );
              });
              void dispatchInbound({
                pending: current,
                mediaPath: undefined,
                mediaType: undefined,
              }).catch((err) => {
                runtime.error?.(
                  `[${account.accountId}] SimpleX pending file timeout: ${String(err)}`,
                );
              });
            }
          }, PENDING_FILE_TIMEOUT_MS);
          continue;
        }
      }
    }

    await dispatchInbound({ pending, mediaPath: undefined, mediaType: undefined });
  }
}

async function requestFileDownload(params: {
  fileId: number;
  account: ResolvedSimplexAccount;
  client: SimplexWsClient;
  runtime: RuntimeEnv;
}): Promise<boolean> {
  const { fileId, account, client, runtime } = params;
  const autoAccept = account.config.connection?.autoAcceptFiles !== false;
  if (!autoAccept) {
    return false;
  }
  const cmd = buildReceiveFileCommand({ fileId });
  try {
    await client.sendCommand(cmd);
  } catch (err) {
    runtime.error?.(`[${account.accountId}] SimpleX receive file failed: ${String(err)}`);
    return false;
  }
  return true;
}

async function finalizePendingFile(params: {
  accountId: string;
  fileId: number;
  filePath?: string;
}): Promise<void> {
  const pending = pendingFiles.get(pendingKey(params.accountId, params.fileId));
  if (!pending) {
    return;
  }
  pendingFiles.delete(pendingKey(params.accountId, params.fileId));
  const mediaPath = params.filePath?.trim() || undefined;
  let mediaType: string | undefined;
  if (mediaPath) {
    mediaType = await getSimplexRuntime().media.detectMime({ filePath: mediaPath });
  }
  await dispatchInbound({ pending, mediaPath, mediaType });
}

async function dispatchInbound(params: {
  pending: PendingInboundFile;
  mediaPath?: string;
  mediaType?: string;
}): Promise<void> {
  const { pending, mediaPath, mediaType } = params;
  const core = getSimplexRuntime();
  const ctxPayload = {
    ...pending.ctxPayload,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
  };

  await core.channel.session.recordInboundSession({
    storePath: pending.storePath,
    sessionKey: (ctxPayload as { SessionKey?: string }).SessionKey ?? pending.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      pending.runtime.error?.(`simplex: failed updating session meta: ${String(err)}`);
    },
  });

  pending.statusSink?.({ lastInboundAt: Date.now() });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: pending.cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        const hasMedia =
          Boolean(payload.mediaUrl) ||
          (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0);
        if (!payload.text && !hasMedia) {
          return;
        }
        if (!pending.account.enabled || !pending.account.configured) {
          pending.runtime.error?.(
            `[${pending.account.accountId}] SimpleX reply skipped: account not ready (enabled=${pending.account.enabled}, configured=${pending.account.configured})`,
          );
          return;
        }
        await sendSimplexPayload({
          client: pending.client,
          chatRef: pending.chatRef,
          cfg: pending.cfg,
          accountId: pending.account.accountId,
          payload,
        });
        pending.statusSink?.({ lastOutboundAt: Date.now() });
      },
      onError: (err) => {
        pending.runtime.error?.(
          `[${pending.account.accountId}] SimpleX reply failed: ${String(err)}`,
        );
      },
    },
    replyOptions: {
      disableBlockStreaming:
        typeof pending.account.config.blockStreaming === "boolean"
          ? !pending.account.config.blockStreaming
          : undefined,
    },
  });
}
