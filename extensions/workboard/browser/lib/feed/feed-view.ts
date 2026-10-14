import type {
  WorkboardCard,
  WorkboardComment,
  WorkboardFeed,
  WorkboardFeedAction,
  WorkboardPriority,
} from "@openclaw/workboard-contract";
import { t } from "../../i18n/index.ts";

export type FeedIconName =
  | "mail"
  | "calendar"
  | "megaphone"
  | "gitPullRequest"
  | "dollar"
  | "trendingUp"
  | "signpost"
  | "shield"
  | "fileText"
  | "inbox";

/** Everything the Feed renders for one card, derived from the card and its feed metadata. */
export type FeedItem = {
  card: WorkboardCard;
  feed: WorkboardFeed;
  tag: string;
  icon: FeedIconName;
  title: string;
  summary?: string;
  body?: string;
  actions: WorkboardFeedAction[];
  comments: WorkboardComment[];
  /** The newest comment is an agent reply the owner has not answered or acked. */
  unread: boolean;
  /** Snoozed until this future time; the card waits in the snoozed list. */
  snoozedUntil?: number;
  /** The snooze ran out and the owner has not touched the card since. */
  woke: boolean;
  open: boolean;
  handledAt?: number;
  doneLabel: string;
  sortAt: number;
};

export type FeedView = {
  open: FeedItem[];
  snoozed: FeedItem[];
  handled: FeedItem[];
  /** The next time a snoozed card comes back, so the view can refresh then. */
  nextWakeAt?: number;
};

export type FeedSnoozeOption = { id: "hour" | "hours3" | "tomorrow" | "nextWeek"; until: number };

const PRIORITY_RANK: Record<WorkboardPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const TAG_ICONS: ReadonlyArray<[RegExp, FeedIconName]> = [
  [/\b(e-?mail|gmail|outlook|inbox|reply)\b/i, "mail"],
  [/\b(calendar|meeting|call|invite|schedule)\b/i, "calendar"],
  [/\b(security|soc ?2|audit|compliance|incident)\b/i, "shield"],
  [/\b(legal|contract|dpa|nda|sign|signature|terms)\b/i, "fileText"],
  [/\b(linkedin|post|tweet|social|content|blog|newsletter|website|copy)\b/i, "megaphone"],
  [/\b(github|pr|pull request|code|deploy|bug)\b/i, "gitPullRequest"],
  [/\b(revenue|deal|invoice|pricing|quote|billing|payment|sales)\b/i, "dollar"],
  [/\b(metric|report|summary|numbers|kpi|arr|growth)\b/i, "trendingUp"],
  [/\b(decide|decision|choose|approve|review)\b/i, "signpost"],
];

const LABEL_TAGS: Record<string, string> = {
  send: "TO SEND",
  decide: "NEEDS A DECISION",
  review: "TO REVIEW",
  call: "CALL",
};

export function feedIconFor(text: string): FeedIconName {
  return TAG_ICONS.find(([pattern]) => pattern.test(text))?.[1] ?? "inbox";
}

/** "Email: send the deck" becomes lane "Email" and title "Send the deck". */
function splitLaneTitle(title: string): { lane?: string; title: string } {
  const match = /^([\p{L}\p{N}][\p{L}\p{N} &./-]{0,23}):\s+(.+)$/u.exec(title);
  if (!match?.[1] || !match[2]) {
    return { title };
  }
  const rest = match[2];
  return { lane: match[1], title: rest.charAt(0).toUpperCase() + rest.slice(1) };
}

function firstLineAndRest(notes: string | undefined): { first?: string; rest?: string } {
  const text = notes?.trim();
  if (!text) {
    return {};
  }
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.trim());
  const first = lines[index]?.trim().replace(/^[-*#>\s]+/, "");
  const rest = lines
    .slice(index + 1)
    .join("\n")
    .trim();
  return { first: first || undefined, rest: rest || undefined };
}

function latestOwnerTouch(feed: WorkboardFeed, comments: readonly WorkboardComment[]): number {
  let latest = feed.ackedAt ?? 0;
  for (const comment of comments) {
    if (comment.author?.kind === "owner") {
      latest = Math.max(latest, comment.createdAt);
    }
  }
  return latest;
}

function latestAgentReply(comments: readonly WorkboardComment[]): number {
  let latest = 0;
  for (const comment of comments) {
    if (comment.author?.kind === "agent") {
      latest = Math.max(latest, comment.createdAt);
    }
  }
  return latest;
}

function primaryAction(feed: WorkboardFeed) {
  return feed.actions?.find((entry) => entry.style === "primary") ?? feed.actions?.[0];
}

/**
 * The line shown under Handled. feed.doneLabel describes the outcome of the primary
 * action, so it is used only when that action was taken or the agent closed the card.
 * A reply or a plain Done must not claim an outcome that did not happen.
 */
function handledLabel(params: {
  feed: WorkboardFeed;
  action: WorkboardFeedAction | undefined;
  done: boolean;
  title: string;
  comments: readonly WorkboardComment[];
}): string {
  const { feed, action, done, title, comments } = params;
  if (action) {
    return action.id === primaryAction(feed)?.id && feed.doneLabel
      ? feed.doneLabel
      : `${action.doneLabel ?? action.label}: ${title}`;
  }
  if (done) {
    return feed.doneLabel ?? title;
  }
  const ackedAt = feed.ackedAt ?? 0;
  const repliedOnAck = comments.some(
    (comment) => comment.author?.kind === "owner" && Math.abs(comment.createdAt - ackedAt) < 5000,
  );
  return repliedOnAck ? `${t("feed.replied")}: ${title}` : title;
}

export function toFeedItem(card: WorkboardCard, now = Date.now()): FeedItem {
  const feed = card.metadata?.feed ?? {};
  const comments = card.metadata?.comments ?? [];
  const split = splitLaneTitle(card.title);
  const notes = firstLineAndRest(card.notes);
  const labelTag = card.labels.map((label) => LABEL_TAGS[label.toLowerCase()]).find(Boolean);
  const tag = feed.tag ?? [split.lane?.toUpperCase(), labelTag].filter(Boolean).join(" · ");
  const agentReplyAt = latestAgentReply(comments);
  const ownerTouchAt = latestOwnerTouch(feed, comments);
  const unread = agentReplyAt > ownerTouchAt;
  const done = card.status === "done";
  const snoozed = !done && feed.snoozedUntil !== undefined && feed.snoozedUntil > now;
  // The server clears the snooze on any owner decision or agent reply, so a stored past
  // snooze means the reminder fired and still waits for the owner.
  const woke = !done && feed.snoozedUntil !== undefined && !snoozed;
  const open = !done && !snoozed && (!feed.ackedAt || unread || woke);
  const action = feed.actions?.find((entry) => entry.id === feed.ackedAction);
  const handledAt = done ? (card.completedAt ?? card.updatedAt) : feed.ackedAt;
  return {
    card,
    feed,
    tag,
    icon: feedIconFor(`${tag} ${card.title} ${card.labels.join(" ")}`),
    title: feed.tag ? card.title : split.title,
    summary: feed.summary ?? notes.first,
    body: feed.body ?? (feed.summary ? card.notes : notes.rest),
    actions: feed.actions ?? [],
    comments,
    unread,
    ...(snoozed ? { snoozedUntil: feed.snoozedUntil } : {}),
    woke,
    open,
    ...(handledAt ? { handledAt } : {}),
    doneLabel: handledLabel({ feed, action, done, title: split.title, comments }),
    sortAt: Math.max(card.createdAt, agentReplyAt, woke ? (feed.snoozedUntil ?? 0) : 0),
  };
}

function compareOpen(left: FeedItem, right: FeedItem): number {
  const leftNew = left.unread || left.woke;
  if (leftNew !== (right.unread || right.woke)) {
    return leftNew ? -1 : 1;
  }
  const rank = PRIORITY_RANK[left.card.priority] - PRIORITY_RANK[right.card.priority];
  return rank !== 0 ? rank : right.sortAt - left.sortAt;
}

function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Open cards first (unread replies and ended snoozes, then priority, then newest), then the
 * snoozed cards by wake time, then what was handled today.
 */
export function buildFeedView(cards: readonly WorkboardCard[], now = Date.now()): FeedView {
  const items = cards.map((card) => toFeedItem(card, now));
  const today = startOfDay(now);
  const snoozed = items
    .filter((item) => item.snoozedUntil !== undefined)
    .toSorted((left, right) => (left.snoozedUntil ?? 0) - (right.snoozedUntil ?? 0));
  return {
    open: items.filter((item) => item.open).toSorted(compareOpen),
    snoozed,
    ...(snoozed[0]?.snoozedUntil ? { nextWakeAt: snoozed[0].snoozedUntil } : {}),
    handled: items
      .filter((item) => !item.open && !item.snoozedUntil && (item.handledAt ?? 0) >= today)
      .toSorted((left, right) => (right.handledAt ?? 0) - (left.handledAt ?? 0)),
  };
}

export function feedGreeting(now = Date.now()): "morning" | "afternoon" | "evening" {
  const hour = new Date(now).getHours();
  return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}

function atNineOn(now: number, addDays: number): number {
  const date = new Date(now);
  date.setDate(date.getDate() + addDays);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

/** Snooze choices in the viewer's local time: 1 hour, 3 hours, tomorrow 9:00, next Monday 9:00. */
export function feedSnoozeOptions(now = Date.now()): FeedSnoozeOption[] {
  const hour = 60 * 60 * 1000;
  const daysToMonday = (8 - new Date(now).getDay()) % 7 || 7;
  return [
    { id: "hour", until: now + hour },
    { id: "hours3", until: now + 3 * hour },
    { id: "tomorrow", until: atNineOn(now, 1) },
    { id: "nextWeek", until: atNineOn(now, daysToMonday) },
  ];
}
