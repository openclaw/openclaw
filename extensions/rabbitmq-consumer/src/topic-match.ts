import type { TopicInfo } from "./topic-resolver.js";

/** Minimum contiguous-character overlap to treat a title as referenced. */
const MIN_MATCH_CHARS = 2;

/**
 * Generic monitoring-domain words that show up in BOTH report requests and many
 * topic titles ("舆情日报", "网络动态参阅"). Scoring on them produces spurious
 * matches — e.g. "深圳农行的舆情日报" shares "舆情" with "涉深舆情-网络动态参阅"
 * (2 chars), tying the real "…深圳…农行…" topic and then losing the longer-title
 * tie-break. We strip these from both sides before scoring so only the entity
 * overlap (深圳/农行/南方基金…) counts. This mirrors what the LLM picker's prompt
 * already does; the deterministic fallback must not re-introduce the noise.
 */
const DOMAIN_STOPWORDS = [
  "舆情",
  "日报",
  "周报",
  "月报",
  "速报",
  "简报",
  "专报",
  "快报",
  "报告",
  "监测",
  "监控",
  "预警",
  "参阅",
  "网络",
  "动态",
  "资讯",
  "信息",
  "分析",
  "今日",
  "本周",
  "本月",
  "昨日",
  "当日",
];

const STOPWORD_RE = new RegExp(DOMAIN_STOPWORDS.join("|"), "g");

/**
 * Drop generic domain words and separators so only entity characters remain for
 * scoring. Pure: returns a new string. An all-generic title collapses to "" and
 * thus can never clear MIN_MATCH_CHARS — exactly what we want for a noise topic.
 */
function stripGeneric(text: string): string {
  return text.replace(STOPWORD_RE, "").replace(/[\s\-_·、，,。./]+/g, "");
}

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

  // Score on the entity-only forms so generic domain words ("舆情/日报/网络…")
  // can't drive a match; keep the original title for the length tie-break.
  const strippedReq = stripGeneric(req);

  let best: TopicInfo | null = null;
  let bestScore = 0;
  for (const topic of topics) {
    const name = topic.topicName?.trim();
    if (!name) {
      continue;
    }
    const score = longestCommonSubstringLength(strippedReq, stripGeneric(name));
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
