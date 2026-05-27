/**
 * Format utilities for Nextcloud Talk messages.
 *
 * Nextcloud Talk supports markdown natively, so most formatting passes through.
 * This module handles any edge cases or transformations needed.
 */

/**
 * Convert markdown to Nextcloud Talk compatible format.
 * Nextcloud Talk supports standard markdown, so minimal transformation needed.
 */
export function markdownToNextcloudTalk(text: string): string {
  return text.trim();
}

/**
 * Escape special characters in text to prevent markdown interpretation.
 */
export function escapeNextcloudTalkMarkdown(text: string): string {
  return text.replace(/([*_`~[\]()#>+\-=|{}!\\])/g, "\\$1");
}

/**
 * Format a mention for a Nextcloud user.
 * Nextcloud Talk uses @user format for mentions.
 */
export function formatNextcloudTalkMention(userId: string): string {
  return `@${userId.replace(/^@/, "")}`;
}

/**
 * Format a code block for Nextcloud Talk.
 */
export function formatNextcloudTalkCodeBlock(code: string, language?: string): string {
  const lang = language ?? "";
  return `\`\`\`${lang}\n${code}\n\`\`\``;
}

/**
 * Format inline code for Nextcloud Talk.
 */
export function formatNextcloudTalkInlineCode(code: string): string {
  if (code.includes("`")) {
    return `\`\` ${code} \`\``;
  }
  return `\`${code}\``;
}

/**
 * Strip Nextcloud Talk specific formatting from text.
 * Useful for extracting plain text content.
 */
export function stripNextcloudTalkFormatting(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Truncate text to a maximum length, preserving word boundaries.
 */
export function truncateNextcloudTalkText(text: string, maxLength: number, suffix = "..."): string {
  if (text.length <= maxLength) {
    return text;
  }
  const truncated = text.slice(0, maxLength - suffix.length);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.7) {
    return truncated.slice(0, lastSpace) + suffix;
  }
  return truncated + suffix;
}
