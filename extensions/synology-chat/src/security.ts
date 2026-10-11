import type { ChannelIngressContextBinding } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { getSynologyRuntime } from "./runtime.js";

/**
 * Validate webhook token using constant-time comparison.
 * Reject empty tokens explicitly; use shared constant-time comparison otherwise.
 */
export function validateToken(received: string, expected: string): boolean {
  if (!received || !expected) {
    return false;
  }
  return safeEqualSecret(received, expected);
}

export async function authorizeUserForDmWithIngress(params: {
  accountId: string;
  userId: string;
  dmPolicy: "open" | "allowlist" | "disabled";
  allowedUserIds: string[];
  contextBinding?: ChannelIngressContextBinding;
}) {
  return await getSynologyRuntime().channel.inbound.ingress.resolveStable({
    channelId: "synology-chat",
    accountId: params.accountId,
    identity: {
      key: "sender-id",
      entryIdPrefix: "synology-chat-entry",
    },
    subject: { stableId: params.userId },
    conversation: {
      kind: "direct",
      id: params.userId,
    },
    contextBinding: params.contextBinding,
    event: { mayPair: false },
    dmPolicy: params.dmPolicy,
    allowFrom: params.allowedUserIds,
  });
}

/**
 * Sanitize user input to prevent prompt injection attacks.
 * Filters known dangerous patterns and truncates long messages.
 */
export function sanitizeInput(text: string): string {
  const dangerousPatterns = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/gi,
    /you\s+are\s+now\s+/gi,
    // Word boundary keeps "filesystem:" and "ecosystem:" readable.
    /\bsystem:\s*/gi,
    /<\|.*?\|>/g, // special tokens
  ];

  let sanitized = text;
  for (const pattern of dangerousPatterns) {
    sanitized = sanitized.replace(pattern, "[FILTERED]");
  }

  const maxLength = 4000;
  if (sanitized.length > maxLength) {
    sanitized = truncateUtf16Safe(sanitized, maxLength) + "... [truncated]";
  }

  return sanitized;
}
