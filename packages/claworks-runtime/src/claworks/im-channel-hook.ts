/**
 * OpenClaw message_received → ClaWorks IM 桥（可选自动转发）。
 */

import { bridgeImMessage } from "./im-bridge.js";
import type { ClaworksRuntime } from "./runtime-types.js";

export async function bridgeChannelMessageReceived(
  runtime: ClaworksRuntime,
  params: {
    channelId: string;
    conversationId?: string;
    senderId?: string;
    messageId?: string;
    text: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const userId = params.senderId ?? params.conversationId ?? "unknown";
  const messageId = params.messageId ?? `hook-${Date.now()}`;
  const text = params.text.trim();
  if (!text) {
    return;
  }

  await bridgeImMessage(runtime, {
    channel: params.channelId,
    messageId,
    userId,
    text,
    groupId: params.conversationId,
    extra: params.metadata,
  });
}
