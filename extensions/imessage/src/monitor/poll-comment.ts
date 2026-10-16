// imsg delivers poll captions as separate inline replies. Fold only the creator's
// near-simultaneous caption, keeping later discussion as ordinary inbound messages.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_COMMENT_WINDOW_MS = 15_000;

type SeenPoll = { atMs: number; sender: string };

export function createPollCommentFolder(options?: { windowMs?: number }) {
  const windowMs = options?.windowMs ?? DEFAULT_COMMENT_WINDOW_MS;
  const seenPolls = new Map<string, SeenPoll>();

  function prune(referenceMs: number): void {
    for (const [key, seen] of seenPolls) {
      if (referenceMs - seen.atMs > windowMs) {
        seenPolls.delete(key);
      }
    }
  }

  return {
    rememberPoll(guid: string | null | undefined, atMs: number, sender?: string | null): void {
      const key = guid?.trim();
      if (!key || !Number.isFinite(atMs)) {
        return;
      }
      prune(atMs);
      seenPolls.set(key, { atMs, sender: normalizeLowercaseStringOrEmpty(sender) });
    },
    isPollComment(
      replyToGuid: string | null | undefined,
      atMs: number,
      sender?: string | null,
    ): boolean {
      const key = replyToGuid?.trim();
      if (!key || !Number.isFinite(atMs)) {
        return false;
      }
      const seen = seenPolls.get(key);
      if (!seen || atMs < seen.atMs || atMs - seen.atMs > windowMs) {
        return false;
      }
      const replySender = normalizeLowercaseStringOrEmpty(sender);
      // Folding precedes the sender gate: unknown identities must fall through
      // or another participant's real reply could be mistaken for the caption.
      return seen.sender.length > 0 && replySender.length > 0 && seen.sender === replySender;
    },
  };
}
