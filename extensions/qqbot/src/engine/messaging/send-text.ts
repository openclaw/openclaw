/**
 * Unified text message sending — route text to the correct QQ target type.
 *
 * Replaces the C2C/Group/Channel/DM branching scattered across `outbound.ts`,
 * `outbound-deliver.ts`, and `reply-dispatcher.ts` with a single function.
 *
 * This module only depends on `core/api/` and `core/messaging/target-parser.ts`.
 * It does NOT import any `src/` root files.
 */

import type { MessageApi, Credentials } from "../api/messages.js";
import type { TokenManager } from "../api/token.js";
import type { ChatScope, MessageResponse, ApiLogger } from "../types.js";
import type { ParsedTarget } from "./target-parser.js";

/** Target context for text delivery, already parsed. */
export interface TextSendTarget {
  /** Parsed target (c2c/group/channel). */
  target: ParsedTarget;
  /** Credentials for API authentication. */
  creds: Credentials;
  /** Original inbound message ID for passive reply. Omit for proactive. */
  msgId?: string;
  /** Message reference ID for quoting. */
  messageReference?: string;
}

/**
 * Send a text message to any QQ target type using the core MessageApi.
 *
 * Automatically routes to the correct API method based on target type:
 * - c2c / group → `messageApi.sendMessage(scope, ...)`
 * - channel → `messageApi.sendChannelMessage(...)`
 *
 * When `msgId` is omitted, sends as a proactive message.
 */
export async function sendTextToTarget(
  messageApi: MessageApi,
  target: TextSendTarget,
  content: string,
  _logger?: ApiLogger,
): Promise<MessageResponse> {
  const { target: parsed, creds, msgId, messageReference } = target;

  if (parsed.type === "c2c" || parsed.type === "group") {
    const scope: ChatScope = parsed.type;
    if (msgId) {
      return messageApi.sendMessage(scope, parsed.id, content, creds, {
        msgId,
        messageReference,
      });
    }
    return messageApi.sendProactiveMessage(scope, parsed.id, content, creds);
  }

  // Channel messages (no C2C/Group scope distinction).
  return messageApi.sendChannelMessage(parsed.id, content, creds, msgId);
}

/**
 * Send text with automatic token-retry on 401 errors.
 *
 * Combines `sendTextToTarget` with the token-retry wrapper.
 */
export async function sendTextWithTokenRetry(
  messageApi: MessageApi,
  tokenManager: TokenManager,
  target: TextSendTarget,
  content: string,
  logger?: ApiLogger,
): Promise<MessageResponse> {
  const { sendWithTokenRetry } = await import("./token-retry.js");
  return sendWithTokenRetry(
    tokenManager,
    target.creds.appId,
    target.creds.clientSecret,
    async () => sendTextToTarget(messageApi, target, content, logger),
    logger,
  );
}
