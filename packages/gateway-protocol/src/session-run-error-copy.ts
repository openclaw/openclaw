const WORKTREE_UNAVAILABLE_COPY =
  "This session's worktree is unavailable. Restore it in Worktrees, then retry, or start a new session in the source repository. Your transcript is preserved.";
const RUNTIME_DISCONNECTED_COPY =
  "The agent runtime disconnected. Check the task before retrying. If its worktree was removed, restore it in Worktrees or start a new session.";

// These are recorded owner diagnostics, not evidence that a request is safe to replay.
const WORKTREE_UNAVAILABLE_RE =
  /(?:^|:\s*|\|\s*)managed worktree (?:was removed|checkout is missing):/iu;
const BROKEN_PIPE_RE = /(?:^|:\s*|\|\s*)(?:write EPIPE|EPIPE)(?=$|[\s|])/u;

/** The same recovery copy serves live errors, stored transcripts, and session previews. */
export function resolveSessionRuntimeErrorCopy(message: string): string | undefined {
  if (message.includes(WORKTREE_UNAVAILABLE_COPY) || WORKTREE_UNAVAILABLE_RE.test(message)) {
    return WORKTREE_UNAVAILABLE_COPY;
  }
  if (message.includes(RUNTIME_DISCONNECTED_COPY) || BROKEN_PIPE_RE.test(message)) {
    return RUNTIME_DISCONNECTED_COPY;
  }
  return undefined;
}

/** Keep operator diagnostics without duplicating recovery at later display boundaries. */
export function formatSessionRuntimeErrorForDisplay(message: string): string {
  const copy = resolveSessionRuntimeErrorCopy(message);
  return copy && !message.includes(copy) ? `${copy}\n\n${message}` : message;
}
