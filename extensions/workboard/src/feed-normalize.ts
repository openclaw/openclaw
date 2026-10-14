// Workboard plugin module normalizes agent-authored Feed presentation metadata.
import type {
  WorkboardCommentAuthor,
  WorkboardFeed,
  WorkboardFeedAction,
  WorkboardFeedLink,
  WorkboardFeedMetric,
} from "@openclaw/workboard-contract";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const MAX_FEED_ACTIONS = 4;
export const MAX_FEED_LINKS = 6;
const MAX_FEED_METRIC_BARS = 12;

const FEED_TEXT_LIMITS = {
  tag: 60,
  summary: 300,
  body: 4000,
  draft: 6000,
  draftHeader: 400,
  doneLabel: 200,
  notify: 300,
} as const;

type FeedTextField = keyof typeof FEED_TEXT_LIMITS;
const FEED_TEXT_FIELDS = Object.keys(FEED_TEXT_LIMITS) as FeedTextField[];

function boundedText(value: unknown, max: number, field: string): string | undefined {
  // Drafts keep their own line breaks and indentation; only trim the outer edges.
  const text = typeof value === "string" ? value.replace(/^\s*\n|\s+$/g, "") : undefined;
  if (!text?.trim()) {
    return undefined;
  }
  if (text.length > max) {
    throw new Error(`feed.${field} must be ${max} characters or fewer (got ${text.length}).`);
  }
  return text;
}

function slugActionId(label: string, used: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "action";
  let id = base;
  for (let suffix = 2; used.has(id); suffix += 1) {
    id = `${base}-${suffix}`;
  }
  return id;
}

function normalizeAction(value: unknown, used: Set<string>): WorkboardFeedAction | null {
  if (!isRecord(value)) {
    return null;
  }
  const label = boundedText(value.label, 40, "actions.label");
  if (!label) {
    throw new Error("feed.actions entries need a label.");
  }
  const message = boundedText(value.message, 1000, "actions.message") ?? label;
  const requestedId = normalizeOptionalString(value.id)?.slice(0, 40);
  const id = requestedId && !used.has(requestedId) ? requestedId : slugActionId(label, used);
  used.add(id);
  const doneLabel = boundedText(value.doneLabel, 40, "actions.doneLabel");
  const style = value.style === "primary" || value.style === "secondary" ? value.style : undefined;
  return {
    id,
    label,
    message,
    ...(style ? { style } : {}),
    ...(doneLabel ? { doneLabel } : {}),
  };
}

function normalizeActions(value: unknown): WorkboardFeedAction[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  if (value.length > MAX_FEED_ACTIONS) {
    throw new Error(`feed.actions accepts at most ${MAX_FEED_ACTIONS} buttons.`);
  }
  const used = new Set<string>();
  const actions = value
    .map((entry) => normalizeAction(entry, used))
    .filter((entry): entry is WorkboardFeedAction => entry !== null);
  return actions.length > 0 ? actions : undefined;
}

function normalizeLinks(value: unknown): WorkboardFeedLink[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const links: WorkboardFeedLink[] = [];
  for (const entry of value.slice(0, MAX_FEED_LINKS)) {
    if (!isRecord(entry)) {
      continue;
    }
    const url = boundedText(entry.url, 2000, "links.url");
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new Error("feed.links entries need an http(s) url.");
    }
    links.push({ label: boundedText(entry.label, 80, "links.label") ?? url, url });
  }
  return links.length > 0 ? links : undefined;
}

function normalizeMetric(value: unknown): WorkboardFeedMetric | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const metricValue = boundedText(value.value, 40, "metric.value");
  if (!metricValue) {
    return undefined;
  }
  const delta = boundedText(value.delta, 60, "metric.delta");
  const caption = boundedText(value.caption, 200, "metric.caption");
  const bars = Array.isArray(value.bars)
    ? value.bars
        .slice(0, MAX_FEED_METRIC_BARS)
        .flatMap((bar): NonNullable<WorkboardFeedMetric["bars"]> =>
          isRecord(bar) && typeof bar.value === "number" && Number.isFinite(bar.value)
            ? [{ label: boundedText(bar.label, 20, "metric.bars.label") ?? "", value: bar.value }]
            : [],
        )
    : [];
  return {
    value: metricValue,
    ...(delta ? { delta } : {}),
    ...(caption ? { caption } : {}),
    ...(bars.length > 0 ? { bars } : {}),
  };
}

function normalizeTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

/** Snoozes reach at most a year out; past times are refused so a card never hides by mistake. */
export const FEED_MAX_SNOOZE_MS = 366 * 24 * 60 * 60 * 1000;

/** Check a snooze wake time: a future epoch ms within a year. */
export function checkFeedSnoozeTime(until: number, now: number, field = "until"): number {
  if (!Number.isFinite(until)) {
    throw new Error(`${field} must be a time in epoch milliseconds or ISO-8601.`);
  }
  if (until <= now) {
    throw new Error(`${field}: pick a snooze time in the future.`);
  }
  if (until - now > FEED_MAX_SNOOZE_MS) {
    throw new Error(`${field}: snooze for at most a year.`);
  }
  return Math.trunc(until);
}

/**
 * Read an agent's `snoozeUntil`: an ISO-8601 string or epoch ms. `null` or an empty
 * string clears the snooze; `undefined` means the agent did not set it.
 */
export function parseFeedSnoozeUntil(value: unknown, now: number): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || (typeof value === "string" && !value.trim())) {
    return null;
  }
  if (typeof value === "string") {
    const text = value.trim();
    const time = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
    return checkFeedSnoozeTime(time, now, "snoozeUntil");
  }
  if (typeof value === "number") {
    return checkFeedSnoozeTime(value, now, "snoozeUntil");
  }
  throw new Error("snoozeUntil must be an ISO-8601 time or epoch milliseconds.");
}

/** Validate a whole Feed record. Over-limit text throws so the authoring agent sees why. */
export function normalizeFeed(value: unknown): WorkboardFeed | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const feed: WorkboardFeed = {};
  for (const field of FEED_TEXT_FIELDS) {
    const text = boundedText(value[field], FEED_TEXT_LIMITS[field], field);
    if (text) {
      feed[field] = text;
    }
  }
  const metric = normalizeMetric(value.metric);
  const links = normalizeLinks(value.links);
  const actions = normalizeActions(value.actions);
  const ackedAt = normalizeTimestamp(value.ackedAt);
  const ackedAction = ackedAt ? normalizeOptionalString(value.ackedAction) : undefined;
  const snoozedUntil = normalizeTimestamp(value.snoozedUntil);
  return {
    ...feed,
    ...(metric ? { metric } : {}),
    ...(links ? { links } : {}),
    ...(actions ? { actions } : {}),
    ...(feed.draft && value.draftEdited === true ? { draftEdited: true } : {}),
    ...(ackedAt ? { ackedAt } : {}),
    ...(ackedAction ? { ackedAction: ackedAction.slice(0, 40) } : {}),
    ...(snoozedUntil ? { snoozedUntil } : {}),
  };
}

export function feedIsEmpty(feed: WorkboardFeed | undefined): boolean {
  return !feed || Object.keys(feed).length === 0;
}

/** Fields an agent sets to show a card in the Feed; ack state and routing do not count. */
export function feedHasPresentation(feed: WorkboardFeed | undefined): boolean {
  return Boolean(
    feed &&
    (feed.tag ||
      feed.summary ||
      feed.body ||
      feed.draft ||
      feed.metric ||
      feed.links?.length ||
      feed.actions?.length),
  );
}

// Owner state that an agent patch never sets directly, plus the controls handled below.
const OWNER_FEED_FIELDS = new Set([
  "reopen",
  "ackedAt",
  "ackedAction",
  "draftEdited",
  "snoozedUntil",
  "snoozeUntil",
]);

/**
 * Merge an agent patch into the stored Feed record. A `null` field clears it;
 * omitted fields keep their value. `reopen: true` clears the owner's ack and snooze;
 * `snoozeUntil` in the same patch then snoozes the card again until that time.
 */
export function mergeFeedPatch(
  existing: WorkboardFeed | undefined,
  patch: unknown,
  now = Date.now(),
): WorkboardFeed | undefined {
  if (!isRecord(patch)) {
    throw new Error("feed must be an object.");
  }
  const next: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (OWNER_FEED_FIELDS.has(key)) {
      continue;
    }
    if (key === "draft") {
      // A new agent draft replaces the owner's edit.
      delete next.draftEdited;
    }
    if (value === null) {
      delete next[key];
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  if (patch.reopen === true) {
    delete next.ackedAt;
    delete next.ackedAction;
    delete next.snoozedUntil;
  }
  const snoozeUntil = parseFeedSnoozeUntil(patch.snoozeUntil, now);
  if (snoozeUntil === null) {
    delete next.snoozedUntil;
  } else if (snoozeUntil !== undefined) {
    next.snoozedUntil = snoozeUntil;
  }
  const normalized = normalizeFeed(next);
  return feedIsEmpty(normalized) ? undefined : normalized;
}

export function normalizeCommentAuthor(value: unknown): WorkboardCommentAuthor | undefined {
  if (!isRecord(value) || (value.kind !== "owner" && value.kind !== "agent")) {
    return undefined;
  }
  const id = normalizeOptionalString(value.id)?.slice(0, 120);
  return { kind: value.kind, ...(id ? { id } : {}) };
}
