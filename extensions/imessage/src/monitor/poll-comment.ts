// A native iMessage poll's comment/caption is delivered as a separate inbound
// message that is an INLINE REPLY to the poll balloon (its `reply_to_id` points
// at the poll). Modern imsg emits balloon metadata, so the same-sender coalesce
// path deliberately flushes the poll and the reply separately — which means the
// caption reaches the agent as its own message. The agent then votes on the
// poll AND answers the caption in prose, a redundant restatement of the vote.
//
// This tracker lets the monitor fold the caption into the poll: the poll message
// already renders the options + vote cue, so a reply that arrives WITH the poll
// is dropped instead of delivered standalone.
//
// The caption is sent as part of composing the poll, so its timestamp is
// essentially the poll's. We only fold a reply whose own timestamp lands within
// a short window of the poll; a deliberate later inline reply to the poll (e.g.
// "I can't make it") falls outside the window and is delivered normally.

// The caption ships with the poll, so it lands within a couple seconds; a short
// window keeps genuine later replies out. Generous enough to absorb clock/queue
// skew, tight enough that a human's read-then-type reply falls outside.
const DEFAULT_COMMENT_WINDOW_MS = 15_000;

function pollRefKeys(id?: number | string | null, guid?: string | null): string[] {
  const keys: string[] = [];
  if (typeof id === "number" && Number.isFinite(id)) {
    keys.push(`ref:${id}`);
  }
  const guidValue = guid?.trim();
  if (guidValue) {
    keys.push(`ref:${guidValue}`);
  }
  return keys;
}

// imsg reports a reply target as `reply_to_id`, which can be the numeric rowid
// or the guid string depending on build; match either against remembered polls.
function replyTargetKeys(replyToId?: number | string | null): string[] {
  if (replyToId == null) {
    return [];
  }
  const keys: string[] = [];
  if (typeof replyToId === "number" && Number.isFinite(replyToId)) {
    keys.push(`ref:${replyToId}`);
  }
  const asString = String(replyToId).trim();
  if (asString) {
    keys.push(`ref:${asString}`);
  }
  return keys;
}

function normalizeSender(sender?: string | null): string {
  return sender?.trim().toLowerCase() ?? "";
}

type SeenPoll = { atMs: number; sender: string };

export function createPollCommentFolder(options?: { windowMs?: number }) {
  const windowMs = options?.windowMs ?? DEFAULT_COMMENT_WINDOW_MS;
  // ref -> the poll's send time + creator. Bounded: pruned on every write against
  // the newest poll time, so at most the polls seen within `windowMs` are kept.
  const seenPolls = new Map<string, SeenPoll>();

  function prune(referenceMs: number): void {
    for (const [key, seen] of seenPolls) {
      if (referenceMs - seen.atMs > windowMs) {
        seenPolls.delete(key);
      }
    }
  }

  return {
    // Remember a native poll balloon (send time + creator) so a caption reply
    // that lands within the window from the same sender can be folded. `atMs` is
    // the poll's created_at; without a usable timestamp the poll is not tracked
    // (fold stays disabled — messages deliver normally).
    rememberPoll(
      id: number | string | null | undefined,
      guid: string | null | undefined,
      atMs: number,
      sender?: string | null,
    ): void {
      if (!Number.isFinite(atMs)) {
        return;
      }
      prune(atMs);
      const seen: SeenPoll = { atMs, sender: normalizeSender(sender) };
      for (const key of pollRefKeys(id, guid)) {
        seenPolls.set(key, seen);
      }
    },
    // True only for the poll's caption: a reply that targets a remembered poll,
    // lands within the window after it, AND comes from the poll's creator. A
    // deliberate later reply, or any reply from someone else (e.g. a group
    // member), falls through and is delivered normally.
    isPollComment(
      replyToId: number | string | null | undefined,
      atMs: number,
      sender?: string | null,
    ): boolean {
      if (replyToId == null || !Number.isFinite(atMs)) {
        return false;
      }
      const replySender = normalizeSender(sender);
      return replyTargetKeys(replyToId).some((key) => {
        const seen = seenPolls.get(key);
        if (!seen || atMs < seen.atMs || atMs - seen.atMs > windowMs) {
          return false;
        }
        // Same-sender only. If either sender is unknown, fall back to timing
        // alone rather than deliver a duplicate for the common 1:1 caption.
        return !seen.sender || !replySender || seen.sender === replySender;
      });
    },
  };
}

export type PollCommentFolder = ReturnType<typeof createPollCommentFolder>;
