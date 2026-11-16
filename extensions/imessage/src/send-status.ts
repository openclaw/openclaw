import type { ChannelGatewayContextV2 } from "openclaw/plugin-sdk/channel-contract";
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

export function clearIMessageSendFailure(accountId: string): void {
  const status = getSendStatus(accountId);
  // Reading chats proves inbound access, not outbound Automation. Only a real
  // successful send clears our warning; leave unrelated monitor errors alone.
  if (status && normalizeIMessageAutomationError(status.getStatus().lastError ?? "")) {
    status.setStatus({ accountId, lastError: null });
  }
}
