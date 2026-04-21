/**
 * Target parsing module.
 *
 * Parse various user-input target formats into standardized send targets.
 * Also provides target string normalization, message tool hints, and other helper functions.
 */

import { resolveUsername } from "./directory.js";

/**
 * Check if a raw string looks like a platform user ID.
 *
 * Yuanbao platform user IDs have two formats:
 *   1. Pure numeric ID (IM account format), e.g. "123456789"
 *   2. 32+ char alphanumeric mixed ID (Base64 encoded format), e.g. "xqfNihe1yIVQyNwb..."
 */
export function looksLikeYuanbaoId(raw: string): boolean {
  const trimmed = raw.trim();

  // UserID format validation (inferred from Base64 format)

  // Length must be at least 24 characters
  if (trimmed.length < 24) {
    return false;
  }

  // Must contain uppercase, lowercase, and numbers
  // Only allows Base64 character set A-Z a-z 0-9 + / =
  // = can only appear at the end, and at most 2
  if (!/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?!.*=.+)[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    return false;
  }

  return true;
}

export interface MessagingTarget {
  isGroup: boolean;
  target: string;
  sessionKey: string;
}

/**
 * Parse raw target string into standardized MessagingTarget.
 *
 * Supported formats:
 *   "<userId>"
 *   "group:<groupId>"
 */
export function parseTarget(to: string, accountId = "default", groupCode = ""): MessagingTarget {
  to = to.trim().replace(/^yuanbao:/, "");

  if (to.startsWith("group:")) {
    return { isGroup: true, target: to.slice("group:".length), sessionKey: to };
  }

  to = to.replace(/^user:/, "").replace(/^direct:/, "");

  if (!looksLikeYuanbaoId(to)) {
    const { userId } = resolveUsername(to, accountId, groupCode) || { userId: to };
    return { isGroup: false, target: userId, sessionKey: `direct:${userId}` };
  }

  return { isGroup: false, target: to, sessionKey: `direct:${to}` };
}

/**
 * Normalize Yuanbao message target string.
 * Strips "yuanbao:" prefix and trims; returns undefined for empty strings.
 */
export function normalizeTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^(yuanbao):/i, "").trim() || undefined;
}

/**
 * Build Yuanbao channel message tool hints for injection into Agent system prompt.
 * Constrains model behavior for file/image and sticker sending, aligned with registered message actions.
 */
export function buildMessageToolHints(): string[] {
  return [
    // ── Sticker flow (self-contained, `to` param managed by Target routing below) ──
    "react = sticker = 发贴纸 (NOT a message reaction). Flow: sticker-search → pick sticker_id → call sticker/react with sticker_id. No bare Unicode emoji.",
    // ── File/image sending ──
    "File/image: use media/mediaUrls with real URLs or absolute paths (e.g. /tmp/file.md). Never use relative paths.",
    // ── DM routing (only when user explicitly requests DM in group chat) ──
    'DM/私信: set `to="<userId>"` only when the user explicitly asks to send a DM/私信/direct message in a group chat. ' +
      "To resolve a userId, call query_session_members first. If the recipient is ambiguous, ask for clarification.",
  ];
}
