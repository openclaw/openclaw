import { jsonResult, readPositiveIntegerParam } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { captureChannelReadAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listIMessageAccountIds, resolveIMessageAccount } from "./accounts.js";
import { createIMessageRpcClient, IMessageRpcRequestError } from "./client.js";
import { projectIMessageReadResult } from "./read-result.js";
import { resolveIMessageRemoteHost } from "./remote-host.js";

const UNSUPPORTED_READ_PARAMS = [
  "chatGuid",
  "chatIdentifier",
  "messageId",
  "threadId",
  "before",
  "after",
  "around",
  "cursor",
  "start",
  "end",
  "participants",
  "attachments",
  "includeAttachments",
  "includeThread",
  "service",
  "query",
  "search",
] as const;

function readChatId(params: Record<string, unknown>): number {
  if (UNSUPPORTED_READ_PARAMS.some((key) => params[key] !== undefined)) {
    throw new Error("iMessage read supports only one explicit chat_id target and limit.");
  }
  // Core owns target-alias precedence and trusted-current target normalization.
  const target = params.to ?? params.target;
  if (
    typeof target !== "string" ||
    !/^chat_id:[1-9]\d*$/.test(target.trim()) ||
    params.chatId !== undefined
  ) {
    throw new Error("iMessage read requires a numeric target in the form chat_id:<positive ID>.");
  }
  const chatId = Number(target.trim().slice("chat_id:".length));
  if (!Number.isSafeInteger(chatId) || chatId <= 0) {
    throw new Error("iMessage read requires a positive safe-integer chat_id.");
  }
  return chatId;
}

function assertDirectChat(value: unknown, chatId: number): void {
  const metadata = asOptionalRecord(value);
  // The native provider owns chat classification; do not rederive it from handles.
  if (metadata?.id !== chatId || metadata.is_group !== false) {
    throw new Error("iMessage read requires verified one-to-one chat metadata.");
  }
}

export async function readIMessageAction(context: ChannelMessageActionContext) {
  const assertReadAuthority = captureChannelReadAuthority();
  const assertCurrent = () => {
    assertReadAuthority?.();
    context.assertDirectAdapterHandoff?.();
  };
  assertCurrent();
  // Only trusted host context can authorize access to the Messages identity.
  // dmPolicy/groupPolicy govern intake, not this explicit owner-requested read.
  if (context.senderIsOwner !== true && !context.gatewayClientScopes?.includes("operator.admin")) {
    throw new Error("iMessage read requires an owner or operator.admin requester.");
  }
  const account = resolveIMessageAccount({ cfg: context.cfg, accountId: context.accountId });
  if (
    !account.enabled ||
    !account.configured ||
    !listIMessageAccountIds(context.cfg).includes(account.accountId)
  ) {
    throw new Error("iMessage read requires an existing, enabled, configured account.");
  }
  const chatId = readChatId(context.params);
  const currentProvider = context.toolContext?.currentChannelProvider?.trim().toLowerCase();
  if (
    context.conversationReadOrigin !== "direct-operator" &&
    currentProvider === "imessage" &&
    (context.toolContext?.currentChatType !== "direct" ||
      context.toolContext.currentChannelId?.trim() !== `chat_id:${chatId}` ||
      context.requesterAccountId !== account.accountId)
  ) {
    throw new Error(
      "Delegated iMessage read requires the trusted current direct chat and account.",
    );
  }
  const limit = readPositiveIntegerParam(context.params, "limit") ?? 10;
  if (!Number.isSafeInteger(limit) || limit > 50) {
    throw new Error("iMessage read limit must be an integer from 1 to 50.");
  }
  if (Object.hasOwn(account.config.groups ?? {}, String(chatId))) {
    throw new Error("iMessage read does not support configured group conversations.");
  }
  if (context.dryRun) {
    return jsonResult({ ok: true, dryRun: true, chatId, limit });
  }
  const cliPath = account.config.cliPath?.trim() || "imsg";
  const dbPath = account.config.dbPath?.trim() || undefined;
  const timeoutMs = account.config.probeTimeoutMs;
  try {
    const remoteHost = await resolveIMessageRemoteHost({
      cliPath,
      remoteHost: account.config.remoteHost,
    });
    assertCurrent();
    const client = await createIMessageRpcClient({ cliPath, dbPath, remoteHost });
    try {
      assertCurrent();
      const metadata = await client.request(
        "chats.get",
        { chat_id: chatId },
        { timeoutMs, assertCurrent },
      );
      assertCurrent();
      assertDirectChat(metadata, chatId);
      const response = await client.request(
        "messages.history",
        { chat_id: chatId, limit, attachments: false },
        { timeoutMs, assertCurrent },
      );
      assertCurrent();
      return projectIMessageReadResult({ result: response, chatId, limit });
    } finally {
      await client.stop();
      assertCurrent();
    }
  } catch (error) {
    // Retirement/cancellation fences provider errors as well as successful content.
    assertCurrent();
    if (error instanceof IMessageRpcRequestError && error.code === -32601) {
      throw new Error(
        "iMessage read requires an imsg build with chats.get. Update imsg on the Messages Mac and refresh channel status.",
        { cause: error },
      );
    }
    throw error;
  }
}
