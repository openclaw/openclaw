const HTTP_DATE_MONTH_INDEX = new Map(
  ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map(
    (month, index) => [month, index],
  ),
);
const HTTP_DATE_SHORT_WEEKDAY_INDEX = new Map(
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((weekday, index) => [weekday, index]),
);

const IMF_FIXDATE_RE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const OBSOLETE_RFC850_DATE_RE =
  /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const OBSOLETE_ASCTIME_DATE_RE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}| \d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

type HttpDateComponents = {
  weekday: number | undefined;
  year: number;
  month: number | undefined;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
};

type HttpDateInstant = {
  timestampMs: number;
  // Date cannot represent :60; its following timestamp is an exclusive upper bound.
  leapSecond: boolean;
};

function ownDataValue(value: unknown, key: string): unknown {
  return value && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

// OpenAI and Anthropic publish each bucket's remaining capacity and full-refill time.
const QUOTA_RESET_HEADERS = [
  ...["tokens", "requests", "project-tokens"].map((dimension) => ({
    remaining: `x-ratelimit-remaining-${dimension}`,
    reset: `x-ratelimit-reset-${dimension}`,
    parseResetSeconds: parseQuotaResetSeconds,
  })),
  ...["requests", "tokens", "input-tokens", "output-tokens"].map((dimension) => ({
    remaining: `anthropic-ratelimit-${dimension}-remaining`,
    reset: `anthropic-ratelimit-${dimension}-reset`,
    parseResetSeconds: parseRfc3339ResetSeconds,
  })),
];
const TIMING_HEADER_NAMES = new Set([
  "retry-after",
  "retry-after-ms",
  ...QUOTA_RESET_HEADERS.flatMap(({ remaining, reset }) => [remaining, reset]),
]);

/**
 * Provider retry timing split by authority: an explicit instruction for this request
 * (Retry-After, retry-after-ms) versus an exhausted bucket's full-refill time.
 */
export type RetryAfterTiming = { explicitSeconds?: number; resetSeconds?: number };

function maxDefined(...values: Array<number | undefined>): number | undefined {
  let floor: number | undefined;
  for (const value of values) {
    if (value !== undefined) {
      floor = Math.max(floor ?? 0, value);
    }
  }
  return floor;
}

/** Reads only retry timing metadata, without invoking provider getters or serialization hooks. */
export function parseRetryAfterHeadersSeconds(
  headers: unknown,
  nowMs = Date.now(),
  status?: number,
): number | undefined {
  const timing = parseRetryAfterHeadersTiming(headers, nowMs, status);
  return timing?.explicitSeconds ?? timing?.resetSeconds;
}

/** Header timing with explicit retry instructions kept apart from bucket refills. */
export function parseRetryAfterHeadersTiming(
  headers: unknown,
  nowMs = Date.now(),
  status?: number,
): RetryAfterTiming | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  try {
    let entries: Array<[string, unknown]>;
    try {
      entries = [...TIMING_HEADER_NAMES].map<[string, unknown]>((key) => [
        key,
        Headers.prototype.get.call(headers, key),
      ]);
    } catch {
      entries = Object.getOwnPropertyNames(headers).flatMap<[string, unknown]>((key) => {
        const name = key.toLowerCase();
        return TIMING_HEADER_NAMES.has(name) ? [[name, ownDataValue(headers, key)]] : [];
      });
    }
    let floor: number | undefined;
    for (const [key, value] of entries) {
      if (key !== "retry-after" && key !== "retry-after-ms") {
        continue;
      }
      const text =
        typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
      const milliseconds = key === "retry-after-ms";
      const numeric =
        typeof value === "number"
          ? value >= 0 && (milliseconds || Number.isInteger(value) || value === Infinity)
          : (milliseconds ? /^\d+(?:\.\d+)?$/ : /^\d+$/).test(text);
      const number = typeof value === "number" ? value : Number(text);
      const retryAt =
        !numeric && !milliseconds ? parseRetryAfterHttpDateMs(text, nowMs) : undefined;
      const seconds = numeric
        ? Number.isFinite(number) && number <= Number.MAX_SAFE_INTEGER
          ? number / (milliseconds ? 1000 : 1)
          : Infinity
        : retryAt === undefined
          ? undefined
          : Math.max(0, (retryAt - nowMs) / 1000);
      if (seconds !== undefined) {
        floor = Math.max(floor ?? 0, seconds);
      }
    }
    // Reset headers describe a full quota refill. Callers apply them only without an
    // explicit instruction, and only for a rejected request whose bucket is exhausted.
    let resetFloor: number | undefined;
    if (status === 429) {
      const values = new Map(entries);
      for (const {
        remaining: remainingKey,
        reset: resetKey,
        parseResetSeconds,
      } of QUOTA_RESET_HEADERS) {
        const remaining = values.get(remainingKey);
        const numericRemaining =
          typeof remaining === "number"
            ? remaining
            : typeof remaining === "string" && /^-?\d+(?:\.\d+)?$/.test(remaining.trim())
              ? Number(remaining)
              : Number.NaN;
        if (!Number.isFinite(numericRemaining) || numericRemaining > 0) {
          continue;
        }
        const reset = values.get(resetKey);
        const seconds = typeof reset === "string" ? parseResetSeconds(reset, nowMs) : undefined;
        resetFloor = maxDefined(resetFloor, seconds);
      }
    }
    return floor === undefined && resetFloor === undefined
      ? undefined
      : {
          ...(floor === undefined ? {} : { explicitSeconds: floor }),
          ...(resetFloor === undefined ? {} : { resetSeconds: resetFloor }),
        };
  } catch {
    return undefined;
  }
}

/** Anthropic reports bucket resets as RFC 3339 instants. */
function parseRfc3339ResetSeconds(value: string, nowMs: number): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return undefined;
  }
  const resetAtMs = Date.parse(value);
  return Number.isFinite(resetAtMs) ? Math.max(0, (resetAtMs - nowMs) / 1000) : undefined;
}

function parseQuotaResetSeconds(value: string): number | undefined {
  if (!/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(value)) {
    return undefined;
  }
  const scales: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 };
  let seconds = 0;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    const scale = scales[match[2] ?? ""];
    if (scale === undefined) {
      return undefined;
    }
    seconds += Number(match[1]) * scale;
  }
  return Number.isFinite(seconds) && seconds <= Number.MAX_SAFE_INTEGER ? seconds : Infinity;
}

/** SDK errors carry native response headers separately from their error body. */
export function parseRetryAfterErrorSeconds(
  error: unknown,
  nowMs = Date.now(),
): number | undefined {
  const timing = parseRetryAfterErrorTiming(error, nowMs);
  return timing?.explicitSeconds ?? timing?.resetSeconds;
}

/** Header timing from an SDK error and its response, merged per authority. */
export function parseRetryAfterErrorTiming(
  error: unknown,
  nowMs = Date.now(),
): RetryAfterTiming | undefined {
  try {
    const status = ownDataValue(error, "status") ?? ownDataValue(error, "statusCode");
    const response = ownDataValue(error, "response");
    const responseStatus = ownDataValue(response, "status") ?? ownDataValue(response, "statusCode");
    const direct = parseRetryAfterHeadersTiming(
      ownDataValue(error, "headers"),
      nowMs,
      typeof status === "number" ? status : undefined,
    );
    const responseTiming = parseRetryAfterHeadersTiming(
      ownDataValue(response, "headers"),
      nowMs,
      typeof responseStatus === "number"
        ? responseStatus
        : typeof status === "number"
          ? status
          : undefined,
    );
    const explicitSeconds = maxDefined(direct?.explicitSeconds, responseTiming?.explicitSeconds);
    const resetSeconds = maxDefined(direct?.resetSeconds, responseTiming?.resetSeconds);
    return explicitSeconds === undefined && resetSeconds === undefined
      ? undefined
      : {
          ...(explicitSeconds === undefined ? {} : { explicitSeconds }),
          ...(resetSeconds === undefined ? {} : { resetSeconds }),
        };
  } catch {
    return undefined;
  }
}

/** Provider prose such as "Please try again in 6s", "retry in 32s" or "Retry-After: 7". */
export const RETRY_AFTER_TEXT_RE =
  /\b(?:retry[- ]after\b\s*:?\s*(?:in\b\s*)?|(?:please\s+)?(?:try again|retry) in\s+)([^\r\n;]+)/i;

const RETRY_TEXT_NUMBER_RE = /^(\d+(?:\.\d+)?|Infinity)\s*([a-z]+)?\b/i;
const MS_PER_SECOND = 1000;
const RETRY_TEXT_UNIT_MS = new Map<string, number>(
  (
    [
      ["milliseconds millisecond msecs msec ms", 1],
      ["seconds second secs sec s", MS_PER_SECOND],
      ["minutes minute mins min m", 60 * MS_PER_SECOND],
      ["hours hour hrs hr h", 60 * 60 * MS_PER_SECOND],
      ["days day d", 24 * 60 * 60 * MS_PER_SECOND],
    ] as const
  ).flatMap(([aliases, milliseconds]) =>
    aliases.split(" ").map((alias) => [alias, milliseconds] as const),
  ),
);

/** Seconds named by a captured retry-text value: a number with an optional time unit, or an HTTP-date. */
export function parseRetryAfterTextSeconds(
  valueText: string,
  nowMs = Date.now(),
): number | undefined {
  const secondsMatch = RETRY_TEXT_NUMBER_RE.exec(valueText);
  if (secondsMatch?.[1]) {
    const value = /^infinity$/i.test(secondsMatch[1]) ? Infinity : Number(secondsMatch[1]);
    if (Number.isNaN(value) || value < 0) {
      return undefined;
    }
    const unitMilliseconds = RETRY_TEXT_UNIT_MS.get(secondsMatch[2]?.toLowerCase() ?? "s");
    if (unitMilliseconds === undefined) {
      return undefined;
    }
    return unitMilliseconds === 1
      ? value / MS_PER_SECOND
      : value * (unitMilliseconds / MS_PER_SECOND);
  }
  const retryAtMs = parseRetryAfterHttpDateMs(valueText, nowMs);
  return retryAtMs === undefined ? undefined : Math.max(0, (retryAtMs - nowMs) / MS_PER_SECOND);
}

/** Whether text carries an explicit retry instruction that parseRetryAfterTextSeconds accepts. */
export function hasExplicitRetryText(text: unknown, nowMs = Date.now()): boolean {
  if (typeof text !== "string" || !text) {
    return false;
  }
  for (const match of text.matchAll(new RegExp(RETRY_AFTER_TEXT_RE, "gi"))) {
    if (parseRetryAfterTextSeconds(match[1]?.trim() ?? "", nowMs) !== undefined) {
      return true;
    }
  }
  return false;
}

// Only google.rpc.RetryInfo defines retryDelay; protobuf Duration JSON is decimal seconds.
const GOOGLE_RETRY_DELAY_TEXT_RE = /"retryDelay"\s*:\s*"(\d+(?:\.\d{1,9})?)s"/g;
const GOOGLE_RETRY_DELAY_VALUE_RE = /^(\d+(?:\.\d{1,9})?)s$/;
const GOOGLE_RETRY_INFO_TYPE = "type.googleapis.com/google.rpc.RetryInfo";
const MAX_GOOGLE_ERROR_DETAILS = 16;

function googleRetryDelayTextSeconds(text: string): number | undefined {
  let floor: number | undefined;
  for (const match of text.matchAll(GOOGLE_RETRY_DELAY_TEXT_RE)) {
    floor = maxDefined(floor, Number(match[1]));
  }
  return floor;
}

function googleStatusRetryDelaySeconds(status: unknown): number | undefined {
  if (typeof status === "string") {
    return googleRetryDelayTextSeconds(status);
  }
  const details = ownDataValue(status, "details");
  if (!Array.isArray(details)) {
    return undefined;
  }
  let floor: number | undefined;
  for (let index = 0; index < Math.min(details.length, MAX_GOOGLE_ERROR_DETAILS); index += 1) {
    const detail = ownDataValue(details, String(index));
    if (ownDataValue(detail, "@type") !== GOOGLE_RETRY_INFO_TYPE) {
      continue;
    }
    const delay = ownDataValue(detail, "retryDelay");
    const match = typeof delay === "string" ? GOOGLE_RETRY_DELAY_VALUE_RE.exec(delay) : null;
    floor = maxDefined(floor, match?.[1] ? Number(match[1]) : undefined);
  }
  return floor;
}

/**
 * Reads google.rpc.RetryInfo delays from raw error text or a google.rpc.Status-shaped body
 * in any key order, with a fixed number of descriptor reads and no getters. Pass the
 * untruncated body: Gemini puts RetryInfo after its QuotaFailure details.
 */
export function parseGoogleRetryDelaySeconds(value: unknown): number | undefined {
  try {
    if (typeof value === "string") {
      return googleRetryDelayTextSeconds(value);
    }
    const response = ownDataValue(value, "response");
    const candidates = [
      value,
      ownDataValue(value, "error"),
      ownDataValue(value, "message"),
      ownDataValue(value, "errorBody"),
      ownDataValue(value, "body"),
      ownDataValue(response, "body"),
      ownDataValue(response, "data"),
    ];
    return maxDefined(
      ...candidates.flatMap((candidate) => [
        googleStatusRetryDelaySeconds(candidate),
        // google.rpc.Status is usually wrapped as { error: Status }.
        typeof candidate === "string"
          ? undefined
          : googleStatusRetryDelaySeconds(ownDataValue(candidate, "error")),
      ]),
    );
  } catch {
    // Hostile proxies and exotic objects carry no trusted timing.
    return undefined;
  }
}

/**
 * Retry time for one thrown provider error, before any lossy projection.
 * Explicit instructions (Retry-After headers, Google RetryInfo) win; prose timing is left
 * for text consumers; an exhausted-bucket refill applies only when neither is present.
 */
export function resolveProviderErrorRetrySeconds(
  error: unknown,
  nowMs = Date.now(),
): number | undefined {
  try {
    const timing = parseRetryAfterErrorTiming(error, nowMs);
    const explicitSeconds = maxDefined(
      timing?.explicitSeconds,
      parseGoogleRetryDelaySeconds(error),
    );
    if (explicitSeconds !== undefined || timing?.resetSeconds === undefined) {
      return explicitSeconds;
    }
    const response = ownDataValue(error, "response");
    const textSources = [
      ownDataValue(error, "message"),
      ownDataValue(error, "errorBody"),
      ownDataValue(error, "body"),
      ownDataValue(response, "body"),
      ownDataValue(response, "data"),
      ownDataValue(ownDataValue(error, "error"), "message"),
    ];
    return textSources.some((source) => hasExplicitRetryText(source, nowMs))
      ? undefined
      : timing.resetSeconds;
  } catch {
    return undefined;
  }
}

/** Round leap seconds forward for Retry-After so an unrepresentable instant cannot retry early. */
export function parseRetryAfterHttpDateMs(value: string, nowMs = Date.now()): number | undefined {
  return parseHttpDateInstant(value, nowMs)?.timestampMs;
}

/** Parse all three HTTP-date forms while retaining leap-second ordering. */
export function parseHttpDateInstant(
  value: string,
  nowMs = Date.now(),
): HttpDateInstant | undefined {
  let fields: readonly (string | undefined)[] | undefined = (
    IMF_FIXDATE_RE.exec(value) ?? OBSOLETE_RFC850_DATE_RE.exec(value)
  )?.slice(1);
  if (!fields) {
    const asctimeDate = OBSOLETE_ASCTIME_DATE_RE.exec(value);
    if (!asctimeDate) {
      return undefined;
    }
    const [, weekday, month, day, hours, minutes, seconds, year] = asctimeDate;
    fields = [weekday, day, month, year, hours, minutes, seconds];
  }
  const [weekday, day, month, year, hours, minutes, seconds] = fields;
  const components: HttpDateComponents = {
    weekday: HTTP_DATE_SHORT_WEEKDAY_INDEX.get((weekday ?? "").slice(0, 3)),
    year: Number.parseInt(year ?? "", 10),
    month: HTTP_DATE_MONTH_INDEX.get(month ?? ""),
    day: Number.parseInt(day ?? "", 10),
    hours: Number.parseInt(hours ?? "", 10),
    minutes: Number.parseInt(minutes ?? "", 10),
    seconds: Number.parseInt(seconds ?? "", 10),
  };
  if (year?.length === 2) {
    const now = new Date(nowMs);
    if (Number.isNaN(now.getTime())) {
      return undefined;
    }
    components.year += Math.floor(now.getUTCFullYear() / 100) * 100;
    const candidate = parseHttpDateCalendarMs(components);
    if (candidate === undefined) {
      return undefined;
    }
    // RFC 9110 resolves two-digit years against the current century, then rolls
    // dates more than 50 years ahead back by 100 years.
    const fiftyYearsFromNow = Date.UTC(
      now.getUTCFullYear() + 50,
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    );
    if (candidate > fiftyYearsFromNow) {
      components.year -= 100;
    }
  }
  return parseHttpDateComponents(components);
}

function parseHttpDateComponents(components: HttpDateComponents): HttpDateInstant | undefined {
  const timestamp = parseHttpDateCalendarMs(components);
  if (timestamp === undefined) {
    return undefined;
  }
  const leapSecond = components.seconds === 60;
  const weekdayTimestamp = leapSecond ? timestamp - 1_000 : timestamp;
  if (new Date(weekdayTimestamp).getUTCDay() !== components.weekday) {
    return undefined;
  }
  return { timestampMs: timestamp, leapSecond };
}

function parseHttpDateCalendarMs(
  components: Omit<HttpDateComponents, "weekday">,
): number | undefined {
  const { year, month, day, hours, minutes, seconds } = components;
  // Grammar supplies decimal integers; the UTC round trip rejects calendar overflow.
  if (month === undefined || year < 1900 || seconds > 60) {
    return undefined;
  }

  const calendarSecond = Math.min(seconds, 59);
  // JavaScript Date has no :60 representation. Validate the stated calendar
  // second against :59, then advance to the leap-second instant.
  const timestamp = Date.UTC(year, month, day, hours, minutes, calendarSecond);
  const parsedDate = new Date(timestamp);
  if (
    parsedDate.getUTCFullYear() !== year ||
    parsedDate.getUTCMonth() !== month ||
    parsedDate.getUTCDate() !== day ||
    parsedDate.getUTCHours() !== hours ||
    parsedDate.getUTCMinutes() !== minutes ||
    parsedDate.getUTCSeconds() !== calendarSecond
  ) {
    return undefined;
  }
  return seconds === 60 ? timestamp + 1_000 : timestamp;
}
