import type { TopicInfo } from "./topic-resolver.js";

/** Minimum contiguous-character overlap to treat a title as referenced. */
const MIN_MATCH_CHARS = 2;

/**
 * Length of the longest common contiguous substring of two strings. Chinese
 * topic titles have no word boundaries, so a substring metric (not token
 * overlap) is what reliably catches "南方基金" inside both "南方基金" and a
 * requirement like "做一个南方基金6月的报告". O(m*n) with rolling rows — titles
 * and requirements are short, and there are only a handful of topics.
 */
export function longestCommonSubstringLength(a: string, b: string): number {
  if (!a || !b) {
    return 0;
  }
  const m = a.length;
  const n = b.length;
  let prev = Array.from<number>({ length: n + 1 }).fill(0);
  let best = 0;
  for (let i = 1; i <= m; i++) {
    const cur = Array.from<number>({ length: n + 1 }).fill(0);
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) {
          best = cur[j];
        }
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * Pick the topic whose title best matches the requirement text, scoped to the
 * topics the user is ALREADY authorized to view (callers must pass the
 * entity_auth/superuser-resolved set — never the whole feed_topic table, or a
 * user could generate reports for projects they don't own).
 *
 * Scores each titled topic by longest-common-substring length with the
 * requirement and returns the best, tie-broken toward the more specific
 * (longer) title. Returns null when nothing clears MIN_MATCH_CHARS — the caller
 * then keeps its default (the user's primary topic).
 */
export function pickTopicByName(requirement: string, topics: TopicInfo[]): TopicInfo | null {
  const req = requirement?.trim();
  if (!req) {
    return null;
  }

  let best: TopicInfo | null = null;
  let bestScore = 0;
  for (const topic of topics) {
    const name = topic.topicName?.trim();
    if (!name) {
      continue;
    }
    const score = longestCommonSubstringLength(req, name);
    const isBetter =
      score > bestScore ||
      (score === bestScore && best !== null && name.length > (best.topicName?.length ?? 0));
    if (isBetter) {
      bestScore = score;
      best = topic;
    }
  }

  return bestScore >= MIN_MATCH_CHARS ? best : null;
}
