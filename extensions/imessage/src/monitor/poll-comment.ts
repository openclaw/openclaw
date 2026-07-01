// A native iMessage poll's comment/caption is delivered as a separate inbound
// message that is an INLINE REPLY to the poll balloon (its `reply_to_id` points
// at the poll). Modern imsg emits balloon metadata, so the same-sender coalesce
// path deliberately flushes the poll and the reply separately — which means the
// caption reaches the agent as its own message. The agent then votes on the
// poll AND answers the caption in prose, a redundant restatement of the vote.
//
// This tracker lets the monitor fold the caption into the poll: the poll message
// already renders the options + vote cue, so a reply to a just-seen poll is
// dropped instead of delivered standalone. Best-effort and TTL-bounded — the
// poll normally arrives just before its caption; a miss simply falls back to the
// prior behavior (caption delivered).

const DEFAULT_POLL_REF_TTL_MS = 5 * 60_000;

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

export function createPollCommentFolder(options?: { ttlMs?: number; now?: () => number }) {
  const ttlMs = options?.ttlMs ?? DEFAULT_POLL_REF_TTL_MS;
  const now = options?.now ?? (() => Date.now());
  const seenPolls = new Map<string, number>();

  function prune(at: number): void {
    for (const [key, ts] of seenPolls) {
      if (at - ts > ttlMs) {
        seenPolls.delete(key);
      }
    }
  }

  return {
    // Remember a native poll balloon so its later caption reply can be folded.
    rememberPoll(id?: number | string | null, guid?: string | null): void {
      const at = now();
      prune(at);
      for (const key of pollRefKeys(id, guid)) {
        seenPolls.set(key, at);
      }
    },
    // True when `replyToId` targets a recently-seen poll — i.e. the message is
    // that poll's comment and should be folded, not delivered standalone.
    isPollComment(replyToId?: number | string | null): boolean {
      if (replyToId == null) {
        return false;
      }
      const at = now();
      return replyTargetKeys(replyToId).some((key) => {
        const ts = seenPolls.get(key);
        return ts != null && at - ts <= ttlMs;
      });
    },
  };
}

export type PollCommentFolder = ReturnType<typeof createPollCommentFolder>;
