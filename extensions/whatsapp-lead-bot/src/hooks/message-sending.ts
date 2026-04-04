/**
 * message_sending hook - detects human agent takeover + handles multi-message responses
 */

import type { WhatsAppLeadBotConfig } from "../config/schema.js";
import type { Database } from "../database.js";
import type { HandoffManager } from "../handoff/manager.js";
import type {
  PluginHookMessageSendingEvent,
  PluginHookMessageContext,
  PluginHookMessageSendingResult,
} from "../types.js";
import type { MessageQueue } from "./message-queue.js";
import { splitAgentResponse } from "./multi-message-splitter.js";

export interface MessageSendingHandlerDeps {
  db: Database;
  config: WhatsAppLeadBotConfig;
  handoffManager: HandoffManager;
  messageQueue: MessageQueue;
}

export function createMessageSendingHandler(deps: MessageSendingHandlerDeps) {
  return async function onMessageSending(
    event: PluginHookMessageSendingEvent,
    ctx: PluginHookMessageContext,
  ): Promise<PluginHookMessageSendingResult> {
    const { to, content, metadata } = event;
    const { channelId, accountId } = ctx;

    console.log(
      `[message-sending] Event: channelId=${channelId}, to=${to}, contentLen=${content?.length}, isOpenclaw=${metadata?.openclawInitiated}`,
    );

    // Only handle WhatsApp messages
    if (channelId !== "whatsapp") {
      return {};
    }

    // Filter by WhatsApp account if configured
    if (deps.config.whatsappAccounts.length > 0 && accountId) {
      if (!deps.config.whatsappAccounts.includes(accountId)) {
        console.log(`[message-sending] Skipping - accountId ${accountId} not in config`);
        return {};
      }
    }

    const lead = await deps.db.getLeadByPhone(to);
    if (!lead) {
      console.log(`[message-sending] No lead found for ${to}`);
      return {};
    }

    // Check if message was initiated by OpenClaw (the bot)
    // - openclawInitiated === true → Message from OpenClaw bot → NO handoff
    // - openclawInitiated === false/undefined → Message from human → HANDOFF!
    const isOpenClawMessage = metadata?.openclawInitiated === true;

    if (!isOpenClawMessage && lead.status !== "handed_off") {
      await deps.handoffManager.triggerHumanMessageHandoff(lead.id);
    }

    // Output filter: check for content that should never reach leads
    // LOG-ONLY mode — monitor for false positives before enabling blocking
    if (isOpenClawMessage && content) {
      const matched = checkLeadContentFilter(content);
      if (matched) {
        console.warn(`[message-sending:filter] WOULD BLOCK to ${lead.id}: matched="${matched}"`);
      }
    }

    // Handle multi-message responses from agent
    if (isOpenClawMessage && content) {
      console.log(`[message-sending] Checking for multi-message content (${content.length} chars)`);
      const split = splitAgentResponse(content);
      console.log(
        `[message-sending] Split result: isMulti=${split.isMulti}, strategy=${split.strategy}, count=${split.messages.length}`,
      );

      if (split.isMulti && split.messages.length > 1) {
        console.log(
          `[message-sending] Detected ${split.messages.length} messages in agent response`,
        );

        for (let i = 1; i < split.messages.length; i++) {
          deps.messageQueue.add(to, {
            to,
            content: split.messages[i],
            metadata: { openclawInitiated: true },
            accountId,
            delayMs: i * 1000,
          });
        }

        console.log(`[message-sending] Queued ${split.messages.length - 1} additional messages`);
        return { content: split.messages[0] };
      }
    }

    return {};
  };
}

/**
 * Patterns that should never appear in messages sent to leads.
 * Returns the matched pattern string if found, null otherwise.
 */
const LEAD_BLOCKED_PATTERNS: RegExp[] = [
  /\bsoy (un |una )?(bot|asistente virtual|ia|inteligencia artificial|agente automatizado|sistema automatizado|programa|software)\b/i,
  /\b(robot|chatbot|machine|máquina)\b/i,
  /\basistente (virtual|automatizado|digital)\b/i,
  /\b(openclaw|whatsapp-lead-bot|supabase|handoff)\b/i,
  /\bcfe_download|parse-cfe-receipt|calculate-quote\b/i,
  /\bopenclaw\.json\b/i,
  /\bplugin\b/i,
  /\bwebhook\b/i,
];

export function checkLeadContentFilter(content: string): string | null {
  for (const pattern of LEAD_BLOCKED_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      return match[0];
    }
  }
  return null;
}
