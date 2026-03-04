/**
 * Regex matching the synthetic `:reaction:<emoji>:<uuid>` suffix appended by
 * {@link resolveReactionSyntheticEvent} in `monitor.account.ts`.
 *
 * These suffixed IDs are necessary for internal dedup and session tracking, but
 * must be stripped before passing the message_id to Feishu API endpoints which
 * expect a raw Feishu message ID.
 *
 * @see https://github.com/openclaw/openclaw/issues/34528
 */
const REACTION_SUFFIX_RE =
  /:reaction:[^:]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Strip the synthetic `:reaction:<emoji>:<uuid>` suffix from a Feishu message
 * ID. Returns the ID unchanged when no suffix is present.
 */
export function stripReactionSuffix(messageId: string): string {
  return messageId.replace(REACTION_SUFFIX_RE, "");
}
