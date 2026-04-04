/**
 * message_sent hook - processes queued multi-messages after initial message is sent
 */

import { getContext } from "../context.js";
import type { PluginHookMessageSentEvent, PluginHookMessageContext } from "../types.js";
import type { MessageQueue } from "./message-queue.js";

export interface MessageSentHandlerDeps {
  messageQueue: MessageQueue;
}

export function createMessageSentHandler(deps: MessageSentHandlerDeps) {
  return async function onMessageSent(
    event: PluginHookMessageSentEvent,
    ctx: PluginHookMessageContext,
  ): Promise<void> {
    const { to, success } = event;
    const { channelId, accountId } = ctx;

    if (channelId !== "whatsapp") return;

    if (!success) {
      console.log(`[message-sent] Message sending failed for ${to}, skipping queue processing`);
      return;
    }

    const { messageQueue } = deps;

    if (!messageQueue.hasQueued(to, accountId)) return;

    const { runtime } = getContext();

    const drainQueue = async () => {
      while (messageQueue.hasQueued(to, accountId)) {
        const nextMsg = messageQueue.pop(to, accountId);
        if (!nextMsg) break;

        console.log(
          `[message-sent] Sending queued message to ${to}: ${nextMsg.content.substring(0, 50)}...`,
        );

        if (nextMsg.delayMs && nextMsg.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, nextMsg.delayMs));
        }

        try {
          await runtime.sendMessage(to, {
            text: nextMsg.content,
            metadata: nextMsg.metadata,
          });
          console.log(
            `[message-sent] Queued messages remaining for ${to}: ${messageQueue.queueSize(to, accountId)}`,
          );
        } catch (error) {
          console.error(`[message-sent] Failed to send queued message to ${to}:`, error);
          break;
        }
      }
    };

    void drainQueue();
  };
}
