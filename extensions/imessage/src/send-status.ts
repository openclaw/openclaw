import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelGatewayContextV2 } from "openclaw/plugin-sdk/channel-contract";
import { normalizeIMessageMessageId } from "./message-guid.js";
import { rememberIMessageReplyCache } from "./monitor-reply-cache.js";
import { normalizeIMessageAutomationError } from "./process-diagnostics.js";
import { getOptionalIMessageRuntime } from "./runtime.js";

type SendStatus = Pick<ChannelGatewayContextV2, "getStatus" | "setStatus">;
const SEND_STATUS_CAPABILITY = "imessage-send-status";

export function registerIMessageSendStatus(
  ctx: SendStatus & Pick<ChannelGatewayContextV2, "accountId" | "channelRuntime" | "abortSignal">,
) {
  return ctx.channelRuntime?.runtimeContexts.register({
    channelId: "imessage",
    accountId: ctx.accountId,
    capability: SEND_STATUS_CAPABILITY,
    context: { getStatus: ctx.getStatus, setStatus: ctx.setStatus } satisfies SendStatus,
    abortSignal: ctx.abortSignal,
  });
}

function getSendStatus(accountId: string): SendStatus | undefined {
  return getOptionalIMessageRuntime()?.channel.runtimeContexts.get<SendStatus>({
    channelId: "imessage",
    accountId,
    capability: SEND_STATUS_CAPABILITY,
  });
}

function recordIMessageSendFailure(accountId: string, error: unknown): void {
  const guidance =
    error instanceof Error ? normalizeIMessageAutomationError(error.message) : undefined;
  if (guidance) {
    getSendStatus(accountId)?.setStatus({ accountId, lastError: guidance });
  }
}

export async function withIMessageSendFailureStatus<T>(
  accountId: string,
  send: () => Promise<T>,
): Promise<T> {
  try {
    return await send();
  } catch (error) {
    recordIMessageSendFailure(accountId, error);
    throw error;
  }
}

export function clearIMessageSendFailure(accountId: string, messageId: string): void {
  if (messageId === "unknown") {
    return;
  }
  const status = getSendStatus(accountId);
  // Reading chats proves inbound access, not outbound Automation. Only a real
  // successful send clears our warning; leave unrelated monitor errors alone.
  if (status && normalizeIMessageAutomationError(status.getStatus().lastError ?? "")) {
    status.setStatus({ accountId, lastError: null });
  }
}

export async function completeIMessageBridgeSend(
  accountId: string,
  result: { messageId: string },
  targetChatGuid: string,
  details?: Record<string, unknown>,
) {
  const messageId = normalizeIMessageMessageId(result.messageId);
  if (messageId) {
    await rememberIMessageReplyCache({
      accountId,
      messageId,
      chatGuid: targetChatGuid,
      timestamp: Date.now(),
      isFromMe: true,
    });
  }
  clearIMessageSendFailure(accountId, result.messageId);
  return jsonResult({ ok: true, messageId: result.messageId, ...details });
}

export function assertIMessageSendSucceeded(result: Record<string, unknown>): void {
  if (result.success === false) {
    throw new Error(
      typeof result.error === "string" && result.error.trim()
        ? result.error.trim()
        : "iMessage action failed",
    );
  }
}
