import { constants, accessSync } from "node:fs";
import { basename } from "node:path";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import { addApprovalReactionHintToText } from "openclaw/plugin-sdk/approval-reaction-runtime";
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  createChannelPartialDeliveryError,
  type MediaPlaceholderTextFact,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  extractOriginalFilename,
  kindFromMime,
  resolveOutboundAttachmentFromUrl,
  type OutboundMediaAccess,
} from "openclaw/plugin-sdk/media-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { sleep as delay } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString as stringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import {
  convertMarkdownTables,
  stripInlineDirectiveTagsForDelivery,
} from "openclaw/plugin-sdk/text-chunking";
import {
  hasExclusiveIMessageLocalDatabase,
  resolveIMessageAccount,
  type ResolvedIMessageAccount,
} from "./accounts.js";
import {
  type IMessageApprovalConversationKey,
  registerIMessageApprovalReactionTarget,
} from "./approval-reactions.js";
import { chatContextFromIMessageTarget, resolveIMessageDirectChatService } from "./chat-context.js";
import { withIMessageReceiptGuidReader } from "./chat-db.js";
import { resolveIMessageChatDbLookupPath } from "./cli-path.js";
import { createIMessageRpcClient, type IMessageRpcClient } from "./client.js";
import { DEFAULT_IMESSAGE_SEND_TIMEOUT_MS } from "./constants.js";
import { normalizeIMessageMessageId } from "./message-guid.js";
import { resolveAuthorizedIMessageReplyReference } from "./message-resource.js";
import { rememberIMessageReplyCache } from "./monitor-reply-cache.js";
import {
  forgetPersistedIMessageEchoKey,
  rememberPersistedIMessageEcho,
} from "./monitor/persisted-echo-cache.js";
import {
  protectIMessageFencedRoleMarkers,
  sanitizeIMessageFinalOutboundText,
} from "./monitor/sanitize-outbound.js";
import { withIMessageRemoteFile } from "./remote-file.js";
import { resolveIMessageRemoteHost } from "./remote-host.js";
import {
  bindIMessageCliSend,
  requestIMessageRpcSend,
  type IMessageSendHandoff,
} from "./send-transport.js";
import {
  formatIMessageChatTarget,
  iMessageTargetRpcParams,
  type IMessageService,
  normalizeIMessageHandle,
  parseIMessageTarget,
} from "./targets.js";

type ParsedIMessageTarget = ReturnType<typeof parseIMessageTarget>;
const MIN_PENDING_PERSISTED_ECHO_TTL_MS = 60_000;
const PENDING_PERSISTED_ECHO_GRACE_MS = 5_000;
type IMessageSendTransport = "auto" | "bridge" | "applescript";

type IMessageApprovalPromptBinding = {
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
};

type IMessageSendOpts = IMessageSendHandoff & {
  cliPath?: string;
  dbPath?: string;
  service?: IMessageService;
  region?: string;
  accountId?: string;
  conversationReadOrigin?: "delegated" | "direct-operator";
  replyToId?: string;
  mediaUrl?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  audioAsVoice?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  chatId?: number;
  client?: IMessageRpcClient;
  config: OpenClawConfig;
  account?: ResolvedIMessageAccount;
  approvalPrompt?: IMessageApprovalPromptBinding;
  onDeliveryResult?: (result: IMessageDeliveryProgress) => Promise<void> | void;
};

type IMessageSendResult = {
  /** Bridge ID, numeric ROWID, or an "ok"/"unknown" placeholder. */
  messageId: string;
  /** Stable GUID for inbound tapback bindings; never a numeric ROWID or placeholder. */
  guid?: string;
  /** Transport confirmed by the bridge for the message that was sent. */
  service?: Exclude<IMessageService, "auto">;
  /** Conversation confirmed by the bridge for the message that was sent. */
  chatGuid?: string;
  sentText: string;
  echoText?: string;
  echoMedia?: MediaPlaceholderTextFact;
  receipt: MessageReceipt;
};

type IMessageDeliveryProgress = IMessageSendResult & {
  content: string;
  messageIds: string[];
  visibleReplySent: true;
  replyToId?: string;
};

function resolveMessageId(result: Record<string, unknown> | null | undefined): string | null {
  if (!result) {
    return null;
  }
  const raw =
    (typeof result.messageGuid === "string" && result.messageGuid.trim()) ||
    (typeof result.messageId === "string" && result.messageId.trim()) ||
    (typeof result.message_id === "string" && result.message_id.trim()) ||
    (typeof result.id === "string" && result.id.trim()) ||
    (typeof result.guid === "string" && result.guid.trim()) ||
    (typeof result.message_id === "number" ? String(result.message_id) : null) ||
    (typeof result.id === "number" ? String(result.id) : null);
  return raw ? raw.trim() : null;
}

function isNumericMessageRowId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d+$/.test(value.trim());
}

function normalizeResolvedMessageGuid(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  // Status placeholders and numeric ROWIDs cannot match inbound tapback GUIDs.
  return normalizeIMessageMessageId(trimmed) && !isNumericMessageRowId(trimmed) ? trimmed : null;
}

function canResolveLatestSentMessageGuidFromChatDb(dbPath?: string): boolean {
  const normalizedDbPath = dbPath?.trim();
  if (!normalizedDbPath) {
    return false;
  }
  try {
    accessSync(normalizedDbPath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveFallbackSentMessageGuid(params: {
  dbPath?: string;
  target: ParsedIMessageTarget;
  text: string;
  sentAfterMs?: number;
}): Promise<string | null> {
  const dbPath = params.dbPath?.trim();
  if (!dbPath || !canResolveLatestSentMessageGuidFromChatDb(dbPath)) {
    return null;
  }
  const deadlineMs = Date.now() + 5_000;
  return await withIMessageReceiptGuidReader(dbPath, async (read) => {
    while (Date.now() <= deadlineMs) {
      const resolved = normalizeResolvedMessageGuid(
        await read({
          type: "latestSentGuid",
          input: {
            target: params.target,
            text: params.text,
            sentAfterMs: params.sentAfterMs,
          },
        }),
      );
      if (resolved) {
        return resolved;
      }
      if (Date.now() >= deadlineMs) {
        return null;
      }
      await delay(250);
    }
    return null;
  });
}

async function withOriginalIMessageAttachmentPath<T>(
  filePath: string,
  send: (attachmentPath: string) => Promise<T>,
): Promise<T> {
  const filename = extractOriginalFilename(filePath);
  if (basename(filePath) === filename) {
    return await send(filePath);
  }
  // The bridge exposes this basename and copies its bytes before returning;
  // keep the UUID-backed media-store file intact while its private alias is live.
  return await withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-imessage-outbound-" },
    async (workspace) => await send(await workspace.copyIn(filename, filePath)),
  );
}

function resolveIMessageSendFailure(result: Record<string, unknown>): string | null {
  if (result.success !== false) {
    return null;
  }
  return typeof result.error === "string" && result.error.trim()
    ? result.error.trim()
    : "iMessage action failed";
}

function isIMessageRpcSendTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /imsg rpc timeout \(send\)/i.test(message);
}

function resultService(value: unknown): Exclude<IMessageService, "auto"> | undefined {
  const normalized = stringValue(value)?.toLowerCase();
  return normalized === "imessage" || normalized === "sms" ? normalized : undefined;
}

function isAttachmentCommandFallbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:unknown|unrecognized|invalid|unsupported)\s+(?:command|subcommand)|not a recognized command|send-attachment.*(?:not found|unsupported|unavailable)|private api bridge.*unavailable|requires the imsg private api bridge|run imsg launch/iu.test(
    message,
  );
}

// AppleScript-only imsg rejects threaded replies; retry only this rejection unthreaded.
function isThreadedReplyUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /reply_to requires bridge transport|cannot send threaded repl|threaded repl(?:y|ies)\b.*(?:unsupported|not supported|requires|unavailable)|requires bridge transport/iu.test(
    message,
  );
}

export async function sendMessageIMessage(
  to: string,
  text: string,
  opts: IMessageSendOpts,
): Promise<IMessageSendResult> {
  const cfg = requireRuntimeConfig(opts.config, "iMessage send");
  opts.assertDirectAdapterHandoff?.();
  const account =
    opts.account ??
    resolveIMessageAccount({
      cfg,
      accountId: opts.accountId,
    });
  const cliPath = opts.cliPath?.trim() || account.config.cliPath?.trim() || "imsg";
  const dbPath = opts.dbPath?.trim() || account.config.dbPath?.trim();
  const remoteHost = await resolveIMessageRemoteHost({
    cliPath,
    remoteHost: account.config.remoteHost,
  });
  opts.assertDirectAdapterHandoff?.();
  const chatDbLookupPath = resolveIMessageChatDbLookupPath({
    cliPath,
    dbPath,
    remoteHost,
  });
  const target = parseIMessageTarget(opts.chatId ? formatIMessageChatTarget(opts.chatId) : to);
  const service =
    opts.service ??
    (target.kind === "handle" && (target.serviceExplicit || target.service !== "auto")
      ? target.service
      : undefined) ??
    (account.config.service as IMessageService | undefined);
  const sendTransport = (account.config.sendTransport ?? "auto") as IMessageSendTransport;
  const resolvedReplyToId = await resolveAuthorizedIMessageReplyReference({
    account,
    target,
    cliPath,
    dbPath,
    remoteHost,
    hasExclusiveLocalDatabase: hasExclusiveIMessageLocalDatabase({
      cfg,
      account,
      cliPath,
      dbPath,
      remoteHost,
    }),
    service,
    replyToId: opts.replyToId,
    conversationReadOrigin: opts.conversationReadOrigin,
  });
  opts.assertDirectAdapterHandoff?.();
  // Only an explicit per-call timeout may shorten the bridge-send floor.
  const timeoutMs =
    opts.timeoutMs ??
    Math.max(account.config.probeTimeoutMs ?? 0, DEFAULT_IMESSAGE_SEND_TIMEOUT_MS);
  const pendingEchoTtlMs = Math.max(
    MIN_PENDING_PERSISTED_ECHO_TTL_MS,
    Math.max(0, timeoutMs) + PENDING_PERSISTED_ECHO_GRACE_MS,
  );
  const region = opts.region?.trim() || account.config.region?.trim() || "US";
  const maxBytes = opts.maxBytes ?? (account.config.mediaMaxMb ?? 16) * 1024 * 1024;
  let message = opts.approvalPrompt
    ? addApprovalReactionHintToText({
        text,
        allowedDecisions: opts.approvalPrompt.allowedDecisions,
      })
    : text;
  const protectedRoles = protectIMessageFencedRoleMarkers(message);
  message = protectedRoles.text;
  let filePath: string | undefined;
  let mediaContentType: string | undefined;

  if (opts.mediaUrl?.trim()) {
    const resolved = await resolveOutboundAttachmentFromUrl(opts.mediaUrl.trim(), maxBytes, {
      mediaAccess: opts.mediaAccess,
      localRoots: opts.mediaLocalRoots,
      readFile: opts.mediaReadFile,
    });
    filePath = resolved.path;
    mediaContentType = resolved.contentType ?? undefined;
    opts.assertDirectAdapterHandoff?.();
  }

  if (!message.trim() && !filePath) {
    throw new Error("iMessage send requires text or media");
  }
  if (message.trim()) {
    const tableMode = resolveMarkdownTableMode({
      cfg,
      channel: "imessage",
      accountId: account.accountId,
    });
    protectedRoles.verifyProtectedRoles(message);
    message = convertMarkdownTables(message, tableMode);
    protectedRoles.verifyProtectedRoles(message);
  }
  protectedRoles.verifyProtectedRoles(message);
  message = stripInlineDirectiveTagsForDelivery(message).text;
  protectedRoles.verifyProtectedRoles(message);
  if (!message.trim() && !filePath) {
    throw new Error("iMessage send requires text or media");
  }
  // Native attributedBody ranges require macOS 15+; older recipients see plain text.
  const formatted = sanitizeIMessageFinalOutboundText(message, {
    formatMarkdown: true,
    protection: protectedRoles,
  });
  message = formatted.text;
  if (!message.trim() && !filePath) {
    throw new Error("iMessage send requires text or media");
  }
  const echoText = message.trim() || undefined;
  const echoMedia: MediaPlaceholderTextFact | undefined =
    filePath && mediaContentType
      ? { contentType: mediaContentType, kind: kindFromMime(mediaContentType) ?? "unknown" }
      : undefined;
  // Unthreaded fallback must also clear reply metadata from receipts and bindings.
  let effectiveReplyToId = resolvedReplyToId;
  const runCliJson = bindIMessageCliSend(opts, { cliPath, dbPath, timeoutMs });
  const requestOwnedRpc = async (method: string, rpcParams: Record<string, unknown>) => {
    opts.assertDirectAdapterHandoff?.();
    const rpcClient = await createIMessageRpcClient({
      cliPath,
      dbPath,
      remoteHost,
    });
    try {
      return await requestIMessageRpcSend(rpcClient, method, rpcParams, timeoutMs, opts);
    } finally {
      await rpcClient.stop();
    }
  };
  const echoScope =
    target.kind === "chat_id"
      ? `${account.accountId}:${formatIMessageChatTarget(target.chatId)}`
      : target.kind === "chat_guid"
        ? `${account.accountId}:chat_guid:${target.chatGuid}`
        : target.kind === "chat_identifier"
          ? `${account.accountId}:chat_identifier:${target.chatIdentifier}`
          : `${account.accountId}:imessage:${target.to}`;

  async function recordAcceptedSend(
    result: Record<string, unknown>,
    delivery:
      | { kind: "attachment"; chatTarget: string; audioAsVoice?: boolean }
      | { kind: "message"; startedAtMs: number },
  ): Promise<IMessageSendResult> {
    const isMessage = delivery.kind === "message";
    const resolvedId = resolveMessageId(result);
    const messageId =
      resolvedId ??
      (result.ok || result.success || (isMessage && result.status === "sent") ? "ok" : "unknown");
    // Tapbacks identify their target by GUID, never the numeric ROWID some sends return.
    let guid: string | null = null;
    for (const key of ["messageGuid", "guid", "messageId", "message_id", "id"]) {
      guid = normalizeResolvedMessageGuid(result[key]);
      if (guid) {
        break;
      }
    }
    if (!guid) {
      const rowId = resolvedId?.trim();
      if (rowId && isNumericMessageRowId(rowId)) {
        const lookupPath = chatDbLookupPath?.trim();
        if (lookupPath) {
          guid = normalizeResolvedMessageGuid(
            await withIMessageReceiptGuidReader(lookupPath, (read) =>
              read({ type: "messageGuid", input: { messageId: rowId } }),
            ),
          );
        }
      }
    }
    if (!guid && isMessage && opts.approvalPrompt && !filePath && !effectiveReplyToId) {
      guid = await resolveFallbackSentMessageGuid({
        dbPath: chatDbLookupPath,
        target,
        text: message,
        sentAfterMs: delivery.startedAtMs,
      });
    }
    await rememberPersistedIMessageEcho({
      scope: echoScope,
      text: isMessage ? echoText : undefined,
      media: echoMedia,
      messageId: resolvedId ?? undefined,
    });
    const providerChatGuid = isMessage
      ? (stringValue(result.chat_guid) ?? stringValue(result.chatGuid))
      : undefined;
    const confirmedService = isMessage
      ? resolveIMessageDirectChatService(resultService(result.service) ?? service, providerChatGuid)
      : undefined;
    if (resolvedId && normalizeIMessageMessageId(resolvedId)) {
      // Attachment CLI selectors and send RPC service confirmations carry different chat facts.
      const chatContext = isMessage
        ? {
            ...chatContextFromIMessageTarget(target, confirmedService ?? service),
            ...(providerChatGuid ? { chatGuid: providerChatGuid } : {}),
          }
        : {
            chatGuid:
              target.kind === "chat_guid"
                ? target.chatGuid
                : target.kind === "chat_id"
                  ? delivery.chatTarget
                  : undefined,
            chatIdentifier:
              target.kind === "chat_identifier" || target.kind === "handle"
                ? delivery.chatTarget
                : undefined,
            chatId: target.kind === "chat_id" ? target.chatId : undefined,
          };
      await rememberIMessageReplyCache({
        accountId: account.accountId,
        messageId: resolvedId,
        ...chatContext,
        timestamp: Date.now(),
        isFromMe: true,
      });
    }
    if (isMessage && message && guid && opts.approvalPrompt) {
      const handle = target.kind === "handle" ? normalizeIMessageHandle(target.to) : undefined;
      const conversation: IMessageApprovalConversationKey = {
        ...(target.kind === "chat_guid" ? { chatGuid: target.chatGuid } : {}),
        ...(target.kind === "chat_identifier" ? { chatIdentifier: target.chatIdentifier } : {}),
        ...(target.kind === "chat_id" ? { chatId: target.chatId } : {}),
        ...(handle ? { handle } : {}),
      };
      await registerIMessageApprovalReactionTarget({
        accountId: account.accountId,
        conversation,
        messageId: guid,
        approvalId: opts.approvalPrompt.approvalId,
        approvalKind: opts.approvalPrompt.approvalKind,
        allowedDecisions: opts.approvalPrompt.allowedDecisions,
      });
    }
    const replyToId = isMessage ? effectiveReplyToId : resolvedReplyToId;
    const receiptMessageId = messageId.trim();
    const results: MessageReceiptSourceResult[] = normalizeIMessageMessageId(receiptMessageId)
      ? [{ channel: "imessage", messageId: receiptMessageId, meta: { targetKind: target.kind } }]
      : [];
    if (results[0]) {
      if (target.kind === "chat_id") {
        results[0].chatId = String(target.chatId);
      } else if (target.kind === "chat_guid") {
        results[0].conversationId = target.chatGuid;
      } else if (target.kind === "chat_identifier") {
        results[0].conversationId = target.chatIdentifier;
      }
    }
    return {
      messageId,
      ...(guid ? { guid } : {}),
      ...(confirmedService ? { service: confirmedService } : {}),
      ...(providerChatGuid ? { chatGuid: providerChatGuid } : {}),
      sentText: isMessage ? message : "",
      ...(isMessage && echoText ? { echoText } : {}),
      ...(echoMedia ? { echoMedia } : {}),
      receipt: createMessageReceiptFromOutboundResults({
        results,
        kind: isMessage ? (filePath ? "media" : "text") : delivery.audioAsVoice ? "voice" : "media",
        ...(replyToId ? { replyToId } : {}),
      }),
    };
  }

  async function trySendAttachment(attachmentFilePath: string): Promise<IMessageSendResult | null> {
    const { audioAsVoice, assertDirectAdapterHandoff, onPlatformSendDispatch } = opts;
    if (audioAsVoice && sendTransport === "applescript") {
      throw new Error(
        "iMessage voice messages require bridge transport; AppleScript cannot send native voice notes. Set sendTransport to bridge or auto.",
      );
    }
    // Service-qualified handles are not existing chat GUIDs. Let imsg's canonical
    // send RPC resolve them; explicit bridge and native voice retain bridge semantics.
    if (
      target.kind === "handle" &&
      !audioAsVoice &&
      sendTransport !== "bridge" &&
      (service === "sms" || service === "imessage")
    ) {
      return null;
    }
    if (remoteHost && sendTransport === "applescript") {
      return null;
    }
    let attachmentChatTarget: string | null = null;
    if (target.kind === "chat_guid") {
      attachmentChatTarget = target.chatGuid;
    } else if (target.kind === "handle") {
      const rawHandle = target.to.trim();
      // Local imsg only accepts canonical handles; remote resolution accepts aliases.
      if (remoteHost || rawHandle.includes("@") || rawHandle.startsWith("+")) {
        const normalizedHandle = normalizeIMessageHandle(target.to);
        if (normalizedHandle) {
          const attachmentService = target.service !== "auto" ? target.service : service;
          attachmentChatTarget = `${attachmentService === "sms" ? "SMS" : attachmentService === "imessage" ? "iMessage" : "any"};-;${normalizedHandle}`;
        }
      }
    } else if (remoteHost) {
      attachmentChatTarget =
        target.kind === "chat_identifier"
          ? target.chatIdentifier
          : formatIMessageChatTarget(target.chatId);
    } else if (target.kind === "chat_id") {
      try {
        const result = await runCliJson(["group", "--chat-id", String(target.chatId)]);
        attachmentChatTarget = stringValue(result.guid) ?? stringValue(result.chat_guid) ?? null;
      } catch (error) {
        if (!audioAsVoice && isAttachmentCommandFallbackError(error)) {
          return null;
        }
        throw error;
      }
    }
    if (!attachmentChatTarget) {
      if (audioAsVoice) {
        throw new Error("iMessage voice messages require an existing chat and bridge transport.");
      }
      return null;
    }
    assertDirectAdapterHandoff?.();

    let result: Record<string, unknown>;
    let pendingEchoKey: string | undefined;
    try {
      pendingEchoKey = await rememberPersistedIMessageEcho({
        scope: echoScope,
        media: echoMedia,
        ttlMs: pendingEchoTtlMs,
        pending: true,
      });
      result = await withOriginalIMessageAttachmentPath(
        attachmentFilePath,
        async (attachmentPath) => {
          if (remoteHost) {
            return await withIMessageRemoteFile({
              remoteHost,
              localPath: attachmentPath,
              timeoutMs,
              assertDirectAdapterHandoff,
              use: async (remotePath) => {
                const rpcParams: Record<string, unknown> = {
                  file: remotePath,
                  ...(audioAsVoice ? { audio: true } : {}),
                  ...(resolvedReplyToId ? { reply_to: resolvedReplyToId } : {}),
                };
                if (target.kind === "chat_id") {
                  rpcParams.chat_id = target.chatId;
                } else if (target.kind === "chat_guid") {
                  rpcParams.chat_guid = target.chatGuid;
                } else {
                  rpcParams.chat_identifier = attachmentChatTarget;
                }
                return await requestOwnedRpc("send.attachment", rpcParams);
              },
            });
          }
          assertDirectAdapterHandoff?.();
          await onPlatformSendDispatch?.();
          assertDirectAdapterHandoff?.();
          return await runCliJson([
            "send-attachment",
            "--chat",
            attachmentChatTarget,
            "--file",
            attachmentPath,
            ...(audioAsVoice ? ["--audio"] : []),
            ...(resolvedReplyToId ? ["--reply-to", resolvedReplyToId] : []),
            "--transport",
            // One-shot imsg names its private-API transport dylib; JSON-RPC calls it bridge.
            sendTransport === "bridge" ? "dylib" : sendTransport,
          ]);
        },
      );
      const failure = resolveIMessageSendFailure(result);
      if (failure) {
        throw new Error(failure);
      }
    } catch (error) {
      await forgetPersistedIMessageEchoKey(pendingEchoKey);
      if (!audioAsVoice && isAttachmentCommandFallbackError(error)) {
        return null;
      }
      throw error;
    }

    return await recordAcceptedSend(result, {
      kind: "attachment",
      chatTarget: attachmentChatTarget,
      audioAsVoice,
    });
  }

  if (filePath && (!resolvedReplyToId || opts.audioAsVoice)) {
    const attachmentResult = await trySendAttachment(filePath);
    if (attachmentResult) {
      if (!message.trim()) {
        return attachmentResult;
      }
      // Persist canonical provider facts before any later native send can run.
      // A failed custody callback must stop the caption and keep its own error.
      await opts.onDeliveryResult?.({
        ...attachmentResult,
        content: "",
        messageIds: attachmentResult.receipt.platformMessageIds,
        visibleReplySent: true,
        ...(attachmentResult.receipt.replyToId
          ? { replyToId: attachmentResult.receipt.replyToId }
          : {}),
      });
      let captionResult: IMessageSendResult;
      try {
        captionResult = await sendMessageIMessage(to, text, {
          ...opts,
          mediaUrl: undefined,
          onDeliveryResult: undefined,
        });
      } catch (error: unknown) {
        // Only the attachment was visible; never attribute the failed caption to it.
        throw createChannelPartialDeliveryError(error, {
          content: "",
          messageIds: attachmentResult.receipt.platformMessageIds,
          receipt: attachmentResult.receipt,
          visibleReplySent: true,
        });
      }
      const messageId = normalizeIMessageMessageId(attachmentResult.messageId)
        ? attachmentResult.messageId
        : captionResult.messageId;
      return {
        messageId,
        ...((captionResult.guid ?? attachmentResult.guid)
          ? { guid: captionResult.guid ?? attachmentResult.guid }
          : {}),
        sentText: captionResult.sentText,
        ...((captionResult.echoText ?? attachmentResult.echoText)
          ? { echoText: captionResult.echoText ?? attachmentResult.echoText }
          : {}),
        ...(attachmentResult.echoMedia ? { echoMedia: attachmentResult.echoMedia } : {}),
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ receipt: attachmentResult.receipt }, { receipt: captionResult.receipt }],
          sentAt: Math.max(attachmentResult.receipt.sentAt, captionResult.receipt.sentAt),
        }),
      };
    }
  }
  const params: Record<string, unknown> = {
    ...iMessageTargetRpcParams(target),
    text: message,
    service: service || "auto",
    region,
    transport: sendTransport,
  };
  if (resolvedReplyToId) {
    params.reply_to = resolvedReplyToId;
  }
  if (formatted.ranges.length > 0) {
    params.formatting = formatted.ranges;
  }
  if (filePath) {
    params.file = filePath;
  }

  opts.assertDirectAdapterHandoff?.();
  const client = opts.client ?? (await createIMessageRpcClient({ cliPath, dbPath, remoteHost }));
  const shouldClose = !opts.client;
  const requestSuccessfulSend = async (sendParams: Record<string, unknown>) => {
    const request = async (nativeParams: Record<string, unknown>) =>
      await requestIMessageRpcSend(client, "send", nativeParams, timeoutMs, opts);
    const response = filePath
      ? await withOriginalIMessageAttachmentPath(filePath, async (attachmentPath) => {
          if (remoteHost) {
            return await withIMessageRemoteFile({
              remoteHost,
              localPath: attachmentPath,
              timeoutMs,
              assertDirectAdapterHandoff: opts.assertDirectAdapterHandoff,
              use: async (remotePath) => request({ ...sendParams, file: remotePath }),
            });
          }
          return await request({ ...sendParams, file: attachmentPath });
        })
      : await request(sendParams);
    const failure = resolveIMessageSendFailure(response);
    if (failure) {
      throw new Error(failure);
    }
    return response;
  };
  let result: Record<string, unknown>;
  const sendStartedAtMs = Date.now();
  let pendingEchoKey: string | undefined;
  try {
    try {
      pendingEchoKey = await rememberPersistedIMessageEcho({
        scope: echoScope,
        text: echoText,
        media: echoMedia,
        ttlMs: pendingEchoTtlMs,
        pending: true,
      });
      result = await requestSuccessfulSend(params);
    } catch (error) {
      if (resolvedReplyToId && isThreadedReplyUnsupportedError(error)) {
        const plainParams = { ...params };
        delete plainParams.reply_to;
        result = await requestSuccessfulSend(plainParams);
        effectiveReplyToId = undefined;
      } else if (filePath || !isIMessageRpcSendTimeout(error)) {
        throw error;
      } else if (
        !opts.approvalPrompt ||
        resolvedReplyToId ||
        !canResolveLatestSentMessageGuidFromChatDb(chatDbLookupPath)
      ) {
        throw error;
      } else {
        const recoveredGuid = await resolveFallbackSentMessageGuid({
          dbPath: chatDbLookupPath,
          target,
          text: message,
          sentAfterMs: sendStartedAtMs,
        });
        if (recoveredGuid) {
          result = { guid: recoveredGuid, status: "sent" };
        } else {
          throw error;
        }
      }
    }
    return await recordAcceptedSend(result, { kind: "message", startedAtMs: sendStartedAtMs });
  } catch (error) {
    await forgetPersistedIMessageEchoKey(pendingEchoKey);
    throw error;
  } finally {
    if (shouldClose) {
      await client.stop();
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
