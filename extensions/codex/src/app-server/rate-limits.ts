import {
  MAX_DATE_TIMESTAMP_MS,
  resolveExpiresAtMsFromEpochSeconds,
} from "openclaw/plugin-sdk/number-runtime";
import {
  clampPercent,
  PROVIDER_LABELS,
  type ProviderUsageSnapshot,
  type UsageWindow,
} from "openclaw/plugin-sdk/provider-usage";
import {
  normalizeOptionalString,
  parseStrictFiniteNumber,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";
import {
  formatCalendarResetTime,
  formatRelativeDuration,
  formatResetDuration,
} from "./rate-limit-time.js";

const CODEX_LIMIT_ID = "codex";
// Codex exposes Reserve as a distinct backend-authorized route, not ordinary Luna usage.
const CODEX_RESERVE_ROUTE = "gpt-reserve";
const CODEX_RESERVE_USAGE_NOTICE =
  "Luna Reserve is a separate, backend-authorized route. Ordinary Luna does not use this reserve, even with Fast off. An unused reserve does not establish eligibility or per-request billing. Ordinary usage may consume credits after included limits are reached.";
const LIMIT_WINDOW_KEYS = ["primary", "secondary"] as const;
const ONE_DAY_MS = 24 * 60 * 60_000;
const DAY_WINDOW_MINUTES = 24 * 60;
const WEEKLY_WINDOW_MINUTES = 7 * DAY_WINDOW_MINUTES;
const WEEKLY_RESET_GAP_MS = 3 * ONE_DAY_MS;
const CODEX_USAGE_LIMIT_MESSAGE_PREFIX = "You've reached your Codex subscription usage limit.";
const CODEX_USAGE_LIMIT_STATE_MISMATCH_MESSAGE =
  "Codex rejected the request with a usage-limit error, but its current account usage does not report an exhausted limit.";

// Sparse updates may omit fields; an invalid optional value must not discard
// the other window or account metadata.
const optionalNumber = z.number().optional().catch(undefined);
const optionalBoolean = z.boolean().optional().catch(undefined);
const rateLimitWindowSchema = z
  .object({
    usedPercent: optionalNumber,
    resetsAt: optionalNumber,
    windowDurationMins: optionalNumber,
  })
  .transform((window) => ({
    usedPercent: window.usedPercent,
    resetsAtMs:
      resolveExpiresAtMsFromEpochSeconds(window.resetsAt, { maxMs: MAX_DATE_TIMESTAMP_MS }) ?? 0,
    windowDurationMins: window.windowDurationMins,
  }))
  .optional()
  .catch(undefined);
const creditsSchema = z
  .object({
    hasCredits: optionalBoolean,
    unlimited: optionalBoolean,
    balance: z.preprocess(parseStrictFiniteNumber, optionalNumber),
  })
  .optional()
  .catch(undefined);
const rateLimitSnapshotSchema = z
  .looseObject({
    primary: rateLimitWindowSchema,
    secondary: rateLimitWindowSchema,
    credits: creditsSchema,
  })
  .transform((snapshot) => ({
    primary: snapshot.primary,
    secondary: snapshot.secondary,
    credits: snapshot.credits,
    limitId: normalizeOptionalString(snapshot.limitId),
    limitName: normalizeOptionalString(snapshot.limitName),
    planType: normalizeOptionalString(snapshot.planType),
    rateLimitReachedType: normalizeOptionalString(snapshot.rateLimitReachedType),
  }));
type RateLimitSnapshot = z.infer<typeof rateLimitSnapshotSchema>;

type LimitWindowKey = (typeof LIMIT_WINDOW_KEYS)[number];

type RateLimitReset = NonNullable<z.infer<typeof rateLimitWindowSchema>>;

type RateLimitWindowEntry = {
  key: LimitWindowKey;
  window: RateLimitReset;
};

export type CodexAccountUsageSummary = {
  usageLine?: string;
  blocked: boolean;
  blockedUntilMs?: number;
  blockedUntilText?: string;
  blockedResetRelative?: string;
  blockingPeriod?: string;
  blockingReason?: string;
};

export function formatCodexUsageLimitErrorMessage(params: {
  message?: string | null;
  codexErrorInfo?: JsonValue | null;
  rateLimits?: JsonValue;
  rateLimitsAuthoritative?: boolean;
  nowMs?: number;
}): string | undefined {
  const message = normalizeOptionalString(params.message);
  if (params.codexErrorInfo !== "usageLimitExceeded") {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  const ordinaryUsageAllowed = readOrdinaryUsageAllowed(params.rateLimits);
  const snapshots = collectCodexRateLimitSnapshots(params.rateLimits).filter(
    snapshotHasDisplayableData,
  );
  const usageSnapshot = snapshots.find(isCodexLimitSnapshot) ?? snapshots[0];
  const blockingSnapshot = selectBlockingRateLimitSnapshot(snapshots, ordinaryUsageAllowed);
  const usageSummary = usageSnapshot
    ? summarizeRateLimitUsage(usageSnapshot, blockingSnapshot, nowMs)
    : undefined;
  if (
    params.rateLimitsAuthoritative &&
    ((ordinaryUsageAllowed === true && !blockingSnapshot) ||
      (ordinaryUsageAllowed === undefined && usageSummary?.blocked === false))
  ) {
    return [
      CODEX_USAGE_LIMIT_STATE_MISMATCH_MESSAGE,
      "Retry the request, use another Codex account if available, or switch to another configured model/provider.",
    ].join(" ");
  }
  const blockingReset = blockingSnapshot
    ? selectSnapshotBlockingReset(blockingSnapshot, nowMs)
    : undefined;
  const nextReset =
    blockingReset ??
    (ordinaryUsageAllowed === undefined && !usageSummary?.blocked
      ? selectNextRateLimitReset(params.rateLimits, nowMs)
      : undefined);
  const parts = [CODEX_USAGE_LIMIT_MESSAGE_PREFIX];
  let recoveryAction = "Wait until Codex becomes available";
  if (nextReset) {
    parts.push(`Next reset ${formatResetTime(nextReset.resetsAtMs, nowMs)}.`);
    recoveryAction = "Wait until the reset time";
  } else {
    const codexRetryHint = extractCodexRetryHint(message);
    if (codexRetryHint) {
      parts.push(`Codex says to try again ${codexRetryHint}.`);
      recoveryAction = "Wait until the retry time";
    } else {
      if (usageSummary?.blockingPeriod && usageSummary.blockingReason) {
        parts.push(`Your ${usageSummary.blockingReason}.`);
      }
      parts.push("OpenClaw could not determine a reset time from Codex.");
    }
  }
  parts.push(
    `${recoveryAction}, use another Codex account if available, or switch to another configured model/provider.`,
  );
  return parts.join(" ");
}

export function shouldRefreshCodexRateLimitsForUsageLimitMessage(
  message: string | null | undefined,
): boolean {
  const text = normalizeOptionalString(message);
  // Only our formatted prefix is a refresh contract. Provider prose alone is
  // not structural evidence of a Codex usage-limit failure.
  return Boolean(
    text?.startsWith(CODEX_USAGE_LIMIT_MESSAGE_PREFIX) && !text.includes("Next reset "),
  );
}

export function summarizeCodexRateLimits(
  value: JsonValue | undefined,
  nowMs = Date.now(),
): string | undefined {
  const snapshots = collectCodexRateLimitSnapshots(value).filter(snapshotHasDisplayableData);
  if (snapshots.length === 0) {
    return undefined;
  }
  const summaries = snapshots
    .slice(0, 4)
    .map((snapshot) => summarizeRateLimitSnapshot(snapshot, nowMs))
    .filter((summary): summary is string => summary !== undefined);
  if (summaries.length === 0) {
    return undefined;
  }
  return [summaries.join("; "), reserveUsageNotice(snapshots)].filter(Boolean).join(". ");
}

export function hasCodexRateLimitSnapshots(value: JsonValue | undefined): boolean {
  return collectCodexRateLimitSnapshots(value).length > 0;
}

export function summarizeCodexAccountRateLimits(
  value: JsonValue | undefined,
  nowMs = Date.now(),
): string[] | undefined {
  const summary = summarizeCodexAccountUsage(value, nowMs);
  if (!summary) {
    return undefined;
  }
  if (!summary.blocked) {
    return ["Codex is available."];
  }
  return [
    summary.blockedUntilText
      ? `Codex is paused until ${summary.blockedUntilText}.`
      : "Codex is paused by a usage limit.",
    summary.blockingReason
      ? `Your ${summary.blockingReason}.`
      : "Your Codex usage limit is reached.",
  ];
}

export function resolveCodexUsageLimitResetAtMs(
  value: JsonValue | undefined,
  nowMs = Date.now(),
): number | undefined {
  return selectBlockingRateLimitReset(value, nowMs)?.resetsAtMs;
}

export function summarizeCodexAccountUsage(
  value: JsonValue | undefined,
  nowMs = Date.now(),
): CodexAccountUsageSummary | undefined {
  const ordinaryUsageAllowed = readOrdinaryUsageAllowed(value);
  if (ordinaryUsageAllowed === null) {
    return undefined;
  }
  const snapshot = collectCodexRateLimitSnapshots(value).find(isCodexLimitSnapshot);
  if (ordinaryUsageAllowed !== undefined) {
    return {
      usageLine: snapshot ? formatUsageLine(snapshot) : undefined,
      blocked: !ordinaryUsageAllowed,
      ...(!ordinaryUsageAllowed ? { blockingReason: "Codex usage limit is reached" } : {}),
    };
  }
  return snapshot && snapshotHasDisplayableData(snapshot)
    ? summarizeRateLimitUsage(
        snapshot,
        snapshotHasLimitBlock(snapshot) ? snapshot : undefined,
        nowMs,
      )
    : undefined;
}

function summarizeRateLimitUsage(
  usageSnapshot: RateLimitSnapshot,
  blockingSnapshot: RateLimitSnapshot | undefined,
  nowMs: number,
): CodexAccountUsageSummary {
  const blockingEntries = blockingSnapshot ? readWindowEntries(blockingSnapshot) : [];
  const blockingWindowEntry = selectBlockingWindowEntry(blockingEntries, nowMs);
  const blockingWindow = blockingWindowEntry?.window;
  const blockingReset =
    blockingWindow && blockingWindow.resetsAtMs > nowMs ? blockingWindow : undefined;
  const blockingPeriod = formatBlockingLimitPeriod(blockingWindowEntry, blockingEntries);
  const blockedUntilText = blockingReset
    ? formatAccountResetTime(blockingReset.resetsAtMs, nowMs)
    : undefined;
  const blockedResetRelative = blockingReset
    ? `in ${formatRelativeDuration(blockingReset.resetsAtMs - nowMs)}`
    : undefined;
  const blockingReason = blockingPeriod
    ? `${blockingPeriod} Codex usage limit is reached`
    : blockingSnapshot
      ? "Codex usage limit is reached"
      : undefined;
  return {
    usageLine: formatUsageLine(usageSnapshot),
    blocked: Boolean(blockingSnapshot),
    ...(blockingReset ? { blockedUntilMs: blockingReset.resetsAtMs } : {}),
    ...(blockedUntilText ? { blockedUntilText } : {}),
    ...(blockedResetRelative ? { blockedResetRelative } : {}),
    ...(blockingPeriod ? { blockingPeriod } : {}),
    ...(blockingReason ? { blockingReason } : {}),
  };
}

export function buildCodexAppServerUsageSnapshot(
  value: unknown,
  options: { accountDetails?: boolean } = {},
): ProviderUsageSnapshot {
  const snapshots = collectCodexRateLimitSnapshots(value);
  const snapshot = snapshots.find(isCodexLimitSnapshot) ?? snapshots[0];
  const entries = snapshot ? readWindowEntries(snapshot) : [];
  const windows = entries
    .map((entry) => readProviderUsageWindow(entry, entries))
    .filter((window): window is UsageWindow => Boolean(window));
  const summary = reserveUsageNotice(snapshots);
  const result: ProviderUsageSnapshot = {
    ...(summary ? { summary } : {}),
    provider: "openai",
    displayName: PROVIDER_LABELS.openai,
    windows,
    ...(snapshot ? { plan: resolveCodexProviderUsagePlan(snapshot) } : {}),
  };
  if (options.accountDetails && snapshot) {
    result.plan = snapshot.planType;
    for (const extra of snapshots) {
      if (extra === snapshot) {
        continue;
      }
      const extraEntries = readWindowEntries(extra);
      for (const entry of extraEntries) {
        const window = readProviderUsageWindow(entry, extraEntries);
        if (window) {
          windows.push({ ...window, groupLabel: formatLimitLabel(extra) });
        }
      }
    }
    const credits = snapshot.credits;
    const balance = credits?.balance;
    if (balance !== undefined && balance >= 0 && credits?.unlimited !== true) {
      result.billing = [{ type: "balance", amount: balance, unit: "credits" }];
    }
  }
  return result;
}

function selectNextRateLimitReset(
  value: JsonValue | undefined,
  nowMs: number,
): RateLimitReset | undefined {
  const windows = collectCodexRateLimitSnapshots(value).flatMap((snapshot) =>
    LIMIT_WINDOW_KEYS.flatMap((key) => snapshot[key] ?? []),
  );
  const futureWindows = windows.filter((window) => window.resetsAtMs > nowMs);
  if (futureWindows.length === 0) {
    return undefined;
  }
  const exhaustedWindows = futureWindows.filter(
    (window) => window.usedPercent !== undefined && window.usedPercent >= 100,
  );
  const candidates = exhaustedWindows.length > 0 ? exhaustedWindows : futureWindows;
  return candidates.toSorted((left, right) => left.resetsAtMs - right.resetsAtMs)[0];
}

function selectBlockingRateLimitReset(
  value: JsonValue | undefined,
  nowMs: number,
): RateLimitReset | undefined {
  const blockingSnapshot = selectBlockingRateLimitSnapshot(
    collectCodexRateLimitSnapshots(value),
    readOrdinaryUsageAllowed(value),
  );
  return blockingSnapshot ? selectSnapshotBlockingReset(blockingSnapshot, nowMs) : undefined;
}

function selectBlockingRateLimitSnapshot(
  snapshots: RateLimitSnapshot[],
  ordinaryUsageAllowed?: boolean | null,
): RateLimitSnapshot | undefined {
  const blockedSnapshots = snapshots.filter(
    (snapshot) =>
      snapshotHasLimitBlock(snapshot) &&
      ((ordinaryUsageAllowed !== true && ordinaryUsageAllowed !== null) ||
        !isCodexLimitSnapshot(snapshot)),
  );
  return blockedSnapshots.find(isCodexLimitSnapshot) ?? blockedSnapshots[0];
}

function summarizeRateLimitSnapshot(
  snapshot: RateLimitSnapshot,
  nowMs: number,
): string | undefined {
  const label = formatLimitLabel(snapshot);
  const windows = LIMIT_WINDOW_KEYS.flatMap((key) => {
    const window = snapshot[key];
    return window ? [`${key} ${formatRateLimitWindowDetails(window, nowMs)}`] : [];
  });
  const reachedType = snapshot.rateLimitReachedType;
  const suffix = reachedType ? ` (${formatReachedType(reachedType)})` : "";
  if (windows.length > 0) {
    return `${label}: ${windows.join(" · ")}${suffix}`;
  }
  if (reachedType) {
    return `${label}: ${formatReachedType(reachedType)}`;
  }
  return undefined;
}

function collectCodexRateLimitSnapshots(value: unknown): RateLimitSnapshot[] {
  if (!isJsonObject(value)) {
    return [];
  }
  if (isRateLimitSnapshot(value)) {
    return [rateLimitSnapshotSchema.parse(value)];
  }
  const byLimitId = value.rateLimitsByLimitId;
  const snapshots = isJsonObject(byLimitId)
    ? sortedRateLimitKeys(Object.keys(byLimitId)).map((key) => byLimitId[key])
    : [value.rateLimits];
  return snapshots
    .filter(isJsonObject)
    .filter(isRateLimitSnapshot)
    .map((snapshot) => rateLimitSnapshotSchema.parse(snapshot));
}

function readOrdinaryUsageAllowed(value: JsonValue | undefined): boolean | null | undefined {
  const allowed = isJsonObject(value) ? value.ordinaryUsageAllowed : undefined;
  return allowed === null || typeof allowed === "boolean" ? allowed : undefined;
}

function sortedRateLimitKeys(keys: string[]): string[] {
  return keys.toSorted((left, right) => {
    if (left === CODEX_LIMIT_ID) {
      return -1;
    }
    if (right === CODEX_LIMIT_ID) {
      return 1;
    }
    return left.localeCompare(right);
  });
}

function isRateLimitSnapshot(value: JsonObject): boolean {
  return (
    isJsonObject(value.primary) ||
    isJsonObject(value.secondary) ||
    value.rateLimitReachedType !== undefined ||
    value.limitId !== undefined ||
    value.limitName !== undefined
  );
}

function snapshotHasDisplayableData(snapshot: RateLimitSnapshot): boolean {
  return (
    Boolean(snapshot.rateLimitReachedType) ||
    readWindowEntries(snapshot).some(
      (entry) => entry.window.usedPercent !== undefined || entry.window.resetsAtMs > 0,
    )
  );
}

function formatRateLimitWindowDetails(window: RateLimitReset, nowMs: number): string {
  const remainingPercent =
    window.usedPercent === undefined
      ? "usage unknown"
      : `${Math.max(0, 100 - Math.round(window.usedPercent))}% left`;
  const reset =
    window.resetsAtMs > nowMs ? ` ⏱${formatResetDuration(window.resetsAtMs, nowMs)}` : "";
  return `${remainingPercent}${reset}`;
}

function reserveUsageNotice(snapshots: RateLimitSnapshot[]): string | undefined {
  return snapshots.some(isReserveSnapshot) ? CODEX_RESERVE_USAGE_NOTICE : undefined;
}

function isReserveSnapshot(snapshot: RateLimitSnapshot): boolean {
  return snapshot.limitName === CODEX_RESERVE_ROUTE || snapshot.limitId === CODEX_RESERVE_ROUTE;
}

function formatLimitLabel(snapshot: RateLimitSnapshot): string {
  if (isReserveSnapshot(snapshot)) {
    return "Luna Reserve (separate route)";
  }
  const label = snapshot.limitName ?? snapshot.limitId;
  if (!label || label === CODEX_LIMIT_ID) {
    return "Codex";
  }
  return formatReachedType(label);
}

function formatReachedType(value: string): string {
  return value.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function formatResetTime(resetsAtMs: number, nowMs: number): string {
  return `in ${formatRelativeDuration(resetsAtMs - nowMs)}, ${formatCalendarResetTime(
    resetsAtMs,
    nowMs,
  )}`;
}

function formatAccountResetTime(resetsAtMs: number, nowMs: number): string {
  return `${formatCalendarResetTime(resetsAtMs, nowMs)} (in ${formatRelativeDuration(
    resetsAtMs - nowMs,
  )})`;
}

function snapshotHasLimitBlock(snapshot: RateLimitSnapshot): boolean {
  return Boolean(
    snapshot.rateLimitReachedType ??
    readWindowEntries(snapshot).some(
      (entry) => entry.window.usedPercent !== undefined && entry.window.usedPercent >= 100,
    ),
  );
}

function isCodexLimitSnapshot(snapshot: RateLimitSnapshot): boolean {
  return !snapshot.limitId || snapshot.limitId === CODEX_LIMIT_ID;
}

function readProviderUsageWindow(
  entry: RateLimitWindowEntry,
  entries: RateLimitWindowEntry[],
): UsageWindow | undefined {
  const { window } = entry;
  if (window.usedPercent === undefined && window.resetsAtMs <= 0) {
    return undefined;
  }
  return {
    label: formatProviderUsageWindowLabel(entry, entries),
    usedPercent: clampPercent(window.usedPercent ?? 0),
    resetAt: window.resetsAtMs > 0 ? window.resetsAtMs : undefined,
  };
}

function formatProviderUsageWindowLabel(
  entry: RateLimitWindowEntry,
  entries: RateLimitWindowEntry[],
): string {
  const minutes = entry.window.windowDurationMins;
  if (minutes === WEEKLY_WINDOW_MINUTES || hasWeeklySecondaryResetCadence(entry, entries)) {
    return "Week";
  }
  if (minutes === DAY_WINDOW_MINUTES) {
    return "Day";
  }
  if (minutes !== undefined && minutes > 0 && minutes < DAY_WINDOW_MINUTES) {
    return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
  }
  if (minutes !== undefined && minutes > 0 && minutes % DAY_WINDOW_MINUTES === 0) {
    return `${minutes / DAY_WINDOW_MINUTES}d`;
  }
  if (minutes !== undefined && minutes > 0 && minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return entry.key === "primary" ? "Short" : "Long";
}

function resolveCodexProviderUsagePlan(snapshot: RateLimitSnapshot): string | undefined {
  const plan = snapshot.planType;
  const creditSummary = formatCodexCreditSummary(snapshot.credits);
  if (!creditSummary) {
    return plan;
  }
  return plan ? `${plan} (${creditSummary})` : creditSummary;
}

function formatCodexCreditSummary(credits: RateLimitSnapshot["credits"]): string | undefined {
  if (!credits || credits.hasCredits === false) {
    return undefined;
  }
  if (credits.unlimited) {
    return "Unlimited credits";
  }
  const balance = credits.balance;
  if (balance === undefined || balance <= 0) {
    return undefined;
  }
  const roundedBalance = Math.round(balance);
  return roundedBalance > 0 ? `${roundedBalance} credits` : undefined;
}

function selectSnapshotBlockingReset(
  snapshot: RateLimitSnapshot,
  nowMs: number,
): RateLimitReset | undefined {
  const window = selectBlockingWindowEntry(readWindowEntries(snapshot), nowMs)?.window;
  return window && window.resetsAtMs > nowMs ? window : undefined;
}

function selectBlockingWindowEntry(
  entries: RateLimitWindowEntry[],
  nowMs: number,
): RateLimitWindowEntry | undefined {
  const futureEntries = entries.filter((entry) => entry.window.resetsAtMs > nowMs);
  const exhaustedFutureEntries = futureEntries.filter(
    (entry) => entry.window.usedPercent !== undefined && entry.window.usedPercent >= 100,
  );
  const resetCandidates =
    exhaustedFutureEntries.length > 0 ? exhaustedFutureEntries : futureEntries;
  if (resetCandidates.length > 0) {
    const resetSort =
      exhaustedFutureEntries.length > 0
        ? (left: RateLimitWindowEntry, right: RateLimitWindowEntry) =>
            right.window.resetsAtMs - left.window.resetsAtMs
        : (left: RateLimitWindowEntry, right: RateLimitWindowEntry) =>
            left.window.resetsAtMs - right.window.resetsAtMs;
    return resetCandidates.toSorted(resetSort)[0];
  }
  const exhaustedEntries = entries.filter(
    (entry) => entry.window.usedPercent !== undefined && entry.window.usedPercent >= 100,
  );
  return exhaustedEntries.toSorted(
    (left, right) => (right.window.windowDurationMins ?? 0) - (left.window.windowDurationMins ?? 0),
  )[0];
}

function readWindowEntries(snapshot: RateLimitSnapshot): RateLimitWindowEntry[] {
  return LIMIT_WINDOW_KEYS.flatMap((key) => {
    const window = snapshot[key];
    return window ? [{ key, window }] : [];
  });
}

function formatBlockingLimitPeriod(
  entry: RateLimitWindowEntry | undefined,
  entries: RateLimitWindowEntry[],
): string | undefined {
  const minutes = entry?.window.windowDurationMins;
  if (
    entry &&
    (minutes === WEEKLY_WINDOW_MINUTES || hasWeeklySecondaryResetCadence(entry, entries))
  ) {
    return "weekly";
  }
  if (minutes === DAY_WINDOW_MINUTES) {
    return "daily";
  }
  if (minutes !== undefined && minutes > 0 && minutes < DAY_WINDOW_MINUTES) {
    return "short-term";
  }
  return undefined;
}

function formatUsageLine(snapshot: RateLimitSnapshot): string | undefined {
  const entries = readWindowEntries(snapshot);
  const windows = entries
    .filter((entry) => entry.window.usedPercent !== undefined)
    .toSorted(
      (left, right) =>
        (right.window.windowDurationMins ?? 0) - (left.window.windowDurationMins ?? 0),
    )
    .map((entry) => {
      const label = formatUsageWindowLabel(entry, entries);
      return `${label} ${Math.round(entry.window.usedPercent ?? 0)}%`;
    });
  return windows.length > 0 ? windows.join(" \u00b7 ") : undefined;
}

function formatUsageWindowLabel(
  entry: RateLimitWindowEntry,
  entries: RateLimitWindowEntry[],
): string {
  const period = formatBlockingLimitPeriod(entry, entries);
  if (period) {
    return period;
  }
  const minutes = entry.window.windowDurationMins;
  if (minutes !== undefined && minutes > 0 && minutes % DAY_WINDOW_MINUTES === 0) {
    const days = minutes / DAY_WINDOW_MINUTES;
    return `${days}-day`;
  }
  if (minutes !== undefined && minutes > 0 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours}-hour`;
  }
  return "usage";
}

function hasWeeklySecondaryResetCadence(
  entry: RateLimitWindowEntry,
  entries: RateLimitWindowEntry[],
): boolean {
  if (entry.key !== "secondary" || entry.window.windowDurationMins !== DAY_WINDOW_MINUTES) {
    return false;
  }
  const primaryResetMs = entries.find((candidate) => candidate.key === "primary")?.window
    .resetsAtMs;
  return (
    typeof primaryResetMs === "number" &&
    primaryResetMs > 0 &&
    entry.window.resetsAtMs > 0 &&
    entry.window.resetsAtMs - primaryResetMs >= WEEKLY_RESET_GAP_MS
  );
}

function extractCodexRetryHint(message: string | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  const tryAgainAt = /\btry again\s+(at\s+[^.!?\n]+)(?:[.!?]|$)/iu.exec(message);
  if (tryAgainAt?.[1]) {
    return tryAgainAt[1].trim();
  }
  const tryAgainRelative = /\btry again\s+((?:tomorrow|in\s+[^.!?\n]+)[^.!?\n]*)(?:[.!?]|$)/iu.exec(
    message,
  );
  return tryAgainRelative?.[1]?.trim();
}
