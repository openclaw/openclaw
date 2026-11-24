/**
 * Discord-local classifier for the core reply-session initialization conflict.
 * Mirrors the load-bearing core error name and message shape so the extended-stable
 * line does not grow the public Plugin SDK surface for this backport.
 */
const SESSION_INIT_CONFLICT_MESSAGE_RE =
  /^reply session initialization conflicted for \S+(?:; please retry your message\.)?$/u;

export function isDiscordReplySessionInitConflictError(error: unknown): boolean {
  if (error instanceof Error && error.name === "ReplySessionInitConflictError") {
    return true;
  }
  return SESSION_INIT_CONFLICT_MESSAGE_RE.test(
    error instanceof Error ? error.message : String(error),
  );
}
