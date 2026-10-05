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
  type MessageReceiptPartKind,
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
  resolveAttachmentImpl?: (
    mediaUrl: string,
    maxBytes: number,
    options?: Parameters<typeof resolveOutboundAttachmentFromUrl>[2],
  ) => Promise<{ path: string; contentType?: string }>;
  createClient?: (params: {
    cliPath: string;
    dbPath?: string;
    remoteHost?: string;
  }) => Promise<IMessageRpcClient>;
  withRemoteFile?: typeof withIMessageRemoteFile;
  runCliJson?: (args: readonly string[]) => Promise<Record<string, unknown>>;
  onDeliveryResult?: (result: IMessageDeliveryProgress) => Promise<void> | void;
  resolveMessageGuidImpl?: (params: {
    dbPath?: string;
    messageId: string;
  }) => Promise<string | null> | string | null;
  resolveSentMessageGuidImpl?: (params: {
    dbPath?: string;
    target: ParsedIMessageTarget;
    text: string;
    sentAfterMs?: number;
  }) => Promise<string | null> | string | null;
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

// Tapbacks identify their target by GUID, never the numeric ROWID some sends return.
function resolveOutboundMessageGuid(
  result: Record<string, unknown> | null | undefined,
): string | null {
  if (!result) {
    return null;
  }
  for (const key of ["messageGuid", "guid", "messageId", "message_id", "id"]) {
    const guid = normalizeResolvedMessageGuid(result[key]);
    if (guid) {
      return guid;
    }
  }
  return null;
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

async function resolveMessageGuidFromChatDb(params: {
  dbPath?: string;
  messageId: string;
}): Promise<string | null> {
  const dbPath = params.dbPath?.trim();
  const messageId = params.messageId.trim();
  if (!dbPath || !isNumericMessageRowId(messageId)) {
    return null;
  }
  return normalizeResolvedMessageGuid(
    await withIMessageReceiptGuidReader(dbPath, (read) =>
      read({ type: "messageGuid", input: { messageId } }),
    ),
  );
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

async function resolveApprovalBindingMessageGuid(params: {
  dbPath?: string;
  messageId: string | null;
  result: Record<string, unknown> | null | undefined;
  resolveMessageGuidImpl?: IMessageSendOpts["resolveMessageGuidImpl"];
}): Promise<string | null> {
  const immediateGuid = resolveOutboundMessageGuid(params.result);
  if (immediateGuid) {
    return immediateGuid;
  }
  const messageId = params.messageId?.trim();
  if (!messageId || !isNumericMessageRowId(messageId)) {
    return null;
  }
  const resolver = params.resolveMessageGuidImpl ?? resolveMessageGuidFromChatDb;
  return normalizeResolvedMessageGuid(
    await resolver({
      dbPath: params.dbPath,
      messageId,
    }),
  );
}

async function resolveFallbackSentMessageGuid(params: {
  dbPath?: string;
  target: ParsedIMessageTarget;
  text: string;
  sentAfterMs?: number;
  resolveSentMessageGuidImpl?: IMessageSendOpts["resolveSentMessageGuidImpl"];
}): Promise<string | null> {
  const dbPath = params.dbPath?.trim();
  if (!params.resolveSentMessageGuidImpl && !canResolveLatestSentMessageGuidFromChatDb(dbPath)) {
    return null;
  }
  const deadlineMs = Date.now() + 5_000;
  const poll = async (
    resolver: NonNullable<IMessageSendOpts["resolveSentMessageGuidImpl"]>,
  ): Promise<string | null> => {
    while (Date.now() <= deadlineMs) {
      const resolved = normalizeResolvedMessageGuid(
        await resolver({
          dbPath: params.dbPath,
          target: params.target,
          text: params.text,
          sentAfterMs: params.sentAfterMs,
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
  };
  if (params.resolveSentMessageGuidImpl) {
    return await poll(params.resolveSentMessageGuidImpl);
  }
  if (!dbPath) {
    return null;
  }
  return await withIMessageReceiptGuidReader(dbPath, (read) =>
    poll(({ target, text, sentAfterMs }) =>
      read({ type: "latestSentGuid", input: { target, text, sentAfterMs } }),
    ),
  );
}

function createIMessageSendReceipt(params: {
  messageId: string;
  target: ReturnType<typeof parseIMessageTarget>;
  kind: MessageReceiptPartKind;
  replyToId?: string;
}): MessageReceipt {
  const messageId = params.messageId.trim();
  const results: MessageReceiptSourceResult[] = normalizeIMessageMessageId(messageId)
    ? [
        {
          channel: "imessage",
          messageId,
          meta: {
            targetKind: params.target.kind,
          },
        },
      ]
    : [];
  if (results[0]) {
    if (params.target.kind === "chat_id") {
      results[0].chatId = String(params.target.chatId);
    } else if (params.target.kind === "chat_guid") {
      results[0].conversationId = params.target.chatGuid;
    } else if (params.target.kind === "chat_identifier") {
      results[0].conversationId = params.target.chatIdentifier;
    }
  }
  return createMessageReceiptFromOutboundResults({
    results,
    kind: params.kind,
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
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

function resolveOutboundEchoScope(params: {
  accountId: string;
  target: ReturnType<typeof parseIMessageTarget>;
}): string {
  if (params.target.kind === "chat_id") {
    return `${params.accountId}:${formatIMessageChatTarget(params.target.chatId)}`;
  }
  if (params.target.kind === "chat_guid") {
    return `${params.accountId}:chat_guid:${params.target.chatGuid}`;
  }
  if (params.target.kind === "chat_identifier") {
    return `${params.accountId}:chat_identifier:${params.target.chatIdentifier}`;
  }
  return `${params.accountId}:imessage:${params.target.to}`;
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
  const maxBytes =
    typeof opts.maxBytes === "number"
      ? opts.maxBytes
      : typeof account.config.mediaMaxMb === "number"
        ? account.config.mediaMaxMb * 1024 * 1024
        : 16 * 1024 * 1024;
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
    const resolveAttachmentFn = opts.resolveAttachmentImpl ?? resolveOutboundAttachmentFromUrl;
    const resolved = await resolveAttachmentFn(opts.mediaUrl.trim(), maxBytes, {
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
    const rpcClient = await (opts.createClient ?? createIMessageRpcClient)({
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
  const withRemoteFile = opts.withRemoteFile ?? withIMessageRemoteFile;

  async function trySendAttachment(attachmentFilePath: string): Promise<IMessageSendResult | null> {
    const {
      audioAsVoice,
      resolveMessageGuidImpl,
      assertDirectAdapterHandoff,
      onPlatformSendDispatch,
    } = opts;
    const accountId = account.accountId;
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
    if (remoteHost) {
      if (target.kind === "chat_guid") {
        attachmentChatTarget = target.chatGuid;
      } else if (target.kind === "chat_identifier") {
        attachmentChatTarget = target.chatIdentifier;
      } else if (target.kind === "handle") {
        const normalizedHandle = normalizeIMessageHandle(target.to);
        if (normalizedHandle) {
          const attachmentService = target.service !== "auto" ? target.service : service;
          attachmentChatTarget = `${attachmentService === "sms" ? "SMS" : attachmentService === "imessage" ? "iMessage" : "any"};-;${normalizedHandle}`;
        }
      } else {
        attachmentChatTarget = formatIMessageChatTarget(target.chatId);
      }
    } else {
      try {
        if (target.kind === "chat_guid") {
          attachmentChatTarget = target.chatGuid;
        } else if (target.kind === "handle") {
          const rawHandle = target.to.trim();
          if (rawHandle.includes("@") || rawHandle.startsWith("+")) {
            const normalizedHandle = normalizeIMessageHandle(target.to);
            if (normalizedHandle) {
              const attachmentService = target.service !== "auto" ? target.service : service;
              attachmentChatTarget = `${attachmentService === "sms" ? "SMS" : attachmentService === "imessage" ? "iMessage" : "any"};-;${normalizedHandle}`;
            }
          }
        } else if (target.kind === "chat_id") {
          const result = await runCliJson(["group", "--chat-id", String(target.chatId)]);
          attachmentChatTarget = stringValue(result.guid) ?? stringValue(result.chat_guid) ?? null;
        }
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

    const echoScope = resolveOutboundEchoScope({
      accountId,
      target,
    });
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
            return await withRemoteFile({
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

    const resolvedId = resolveMessageId(result);
    const approvalBindingMessageId = await resolveApprovalBindingMessageGuid({
      dbPath: chatDbLookupPath,
      messageId: resolvedId,
      result,
      resolveMessageGuidImpl,
    });
    const messageId = resolvedId ?? (result.ok || result.success ? "ok" : "unknown");
    await rememberPersistedIMessageEcho({
      scope: echoScope,
      media: echoMedia,
      messageId: resolvedId ?? undefined,
    });
    if (resolvedId && normalizeIMessageMessageId(resolvedId)) {
      await rememberIMessageReplyCache({
        accountId,
        messageId: resolvedId,
        chatGuid:
          target.kind === "chat_guid"
            ? target.chatGuid
            : target.kind === "chat_id"
              ? attachmentChatTarget
              : undefined,
        chatIdentifier:
          target.kind === "chat_identifier" || target.kind === "handle"
            ? attachmentChatTarget
            : undefined,
        chatId: target.kind === "chat_id" ? target.chatId : undefined,
        timestamp: Date.now(),
        isFromMe: true,
      });
    }
    return {
      messageId,
      ...(approvalBindingMessageId ? { guid: approvalBindingMessageId } : {}),
      sentText: "",
      ...(echoMedia ? { echoMedia } : {}),
      receipt: createIMessageSendReceipt({
        messageId,
        target,
        kind: audioAsVoice ? "voice" : "media",
        ...(resolvedReplyToId ? { replyToId: resolvedReplyToId } : {}),
      }),
    };
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

  if (target.kind === "chat_id") {
    params.chat_id = target.chatId;
  } else if (target.kind === "chat_guid") {
    params.chat_guid = target.chatGuid;
  } else if (target.kind === "chat_identifier") {
    params.chat_identifier = target.chatIdentifier;
  } else {
    params.to = target.to;
  }

  const echoScope = resolveOutboundEchoScope({ accountId: account.accountId, target });

  opts.assertDirectAdapterHandoff?.();
  const client =
    opts.client ??
    (await (opts.createClient ?? createIMessageRpcClient)({ cliPath, dbPath, remoteHost }));
  const shouldClose = !opts.client;
  const requestSuccessfulSend = async (sendParams: Record<string, unknown>) => {
    const request = async (nativeParams: Record<string, unknown>) =>
      await requestIMessageRpcSend(client, "send", nativeParams, timeoutMs, opts);
    const response = filePath
      ? await withOriginalIMessageAttachmentPath(filePath, async (attachmentPath) => {
          if (remoteHost) {
            return await withRemoteFile({
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
        !(
          opts.resolveSentMessageGuidImpl ||
          canResolveLatestSentMessageGuidFromChatDb(chatDbLookupPath)
        )
      ) {
        throw error;
      } else {
        const recoveredGuid = await resolveFallbackSentMessageGuid({
          dbPath: chatDbLookupPath,
          target,
          text: message,
          sentAfterMs: sendStartedAtMs,
          resolveSentMessageGuidImpl: opts.resolveSentMessageGuidImpl,
        });
        if (recoveredGuid) {
          result = { guid: recoveredGuid, status: "sent" };
        } else {
          throw error;
        }
      }
    }
    const resolvedId = resolveMessageId(result);
    const messageId =
      resolvedId ?? (result?.ok || result?.success || result?.status === "sent" ? "ok" : "unknown");
    // Recover numeric ROWIDs through chat.db before binding tapback GUIDs.
    let approvalBindingMessageId = await resolveApprovalBindingMessageGuid({
      dbPath: chatDbLookupPath,
      messageId: resolvedId,
      result,
      resolveMessageGuidImpl: opts.resolveMessageGuidImpl,
    });
    if (!approvalBindingMessageId && opts.approvalPrompt && !filePath && !effectiveReplyToId) {
      approvalBindingMessageId = await resolveFallbackSentMessageGuid({
        dbPath: chatDbLookupPath,
        target,
        text: message,
        sentAfterMs: sendStartedAtMs,
        resolveSentMessageGuidImpl: opts.resolveSentMessageGuidImpl,
      });
    }
    await rememberPersistedIMessageEcho({
      scope: echoScope,
      text: echoText,
      media: echoMedia,
      messageId: resolvedId ?? undefined,
    });
    // Outbound provenance authorizes later edit/unsend; inbound cache entries cannot.
    const providerChatGuid = stringValue(result.chat_guid) ?? stringValue(result.chatGuid);
    const confirmedService = resolveIMessageDirectChatService(
      resultService(result.service) ?? service,
      providerChatGuid,
    );
    if (resolvedId && normalizeIMessageMessageId(resolvedId)) {
      const chatContext = chatContextFromIMessageTarget(target, confirmedService ?? service);
      await rememberIMessageReplyCache({
        accountId: account.accountId,
        messageId: resolvedId,
        ...chatContext,
        ...(providerChatGuid ? { chatGuid: providerChatGuid } : {}),
        timestamp: Date.now(),
        isFromMe: true,
      });
    }
    if (message && approvalBindingMessageId && opts.approvalPrompt) {
      const handleForKey =
        target.kind === "handle" ? normalizeIMessageHandle(target.to) : undefined;
      const conversation: IMessageApprovalConversationKey = {
        ...(target.kind === "chat_guid" ? { chatGuid: target.chatGuid } : {}),
        ...(target.kind === "chat_identifier" ? { chatIdentifier: target.chatIdentifier } : {}),
        ...(target.kind === "chat_id" ? { chatId: target.chatId } : {}),
        ...(handleForKey ? { handle: handleForKey } : {}),
      };
      await registerIMessageApprovalReactionTarget({
        accountId: account.accountId,
        conversation,
        messageId: approvalBindingMessageId,
        approvalId: opts.approvalPrompt.approvalId,
        approvalKind: opts.approvalPrompt.approvalKind,
        allowedDecisions: opts.approvalPrompt.allowedDecisions,
      });
    }
    return {
      messageId,
      ...(approvalBindingMessageId ? { guid: approvalBindingMessageId } : {}),
      ...(confirmedService ? { service: confirmedService } : {}),
      ...(providerChatGuid ? { chatGuid: providerChatGuid } : {}),
      sentText: message,
      ...(echoText ? { echoText } : {}),
      ...(echoMedia ? { echoMedia } : {}),
      receipt: createIMessageSendReceipt({
        messageId,
        target,
        kind: filePath ? "media" : "text",
        ...(effectiveReplyToId ? { replyToId: effectiveReplyToId } : {}),
      }),
    };
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
