import type { StravaActivity, StravaActivityDetail, StravaAthleteStats } from "./types.js";

const BASE_URL = "https://www.strava.com/api/v3";

export class StravaApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "StravaApiError";
  }
}

async function stravaFetch<T>(
  token: string,
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    throw new StravaApiError(
      401,
      "Strava token expired or revoked. Please reconnect your Strava account.",
    );
  }
  if (res.status === 429) {
    throw new StravaApiError(429, "Strava rate limit reached. Try again in a few minutes.");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new StravaApiError(res.status, `Strava API error (${res.status}): ${text}`);
  }

  // Rewrite numeric "id" values to JSON strings before parsing so float64
  // never touches them — Strava IDs are 64-bit and can exceed Number.MAX_SAFE_INTEGER.
  const raw = await res.text();
  const safe = raw.replace(/"id"\s*:\s*(\d+)/g, '"id":"$1"');
  return JSON.parse(safe) as T;
}

export interface GetActivitiesOpts {
  page?: number;
  perPage?: number;
  /** ISO date string — only activities after this date. */
  after?: string;
  /** ISO date string — only activities before this date. */
  before?: string;
}

/** List the authenticated athlete's activities. */
export async function getActivities(
  token: string,
  opts: GetActivitiesOpts = {},
): Promise<StravaActivity[]> {
  const params: Record<string, string> = {};
  if (opts.perPage) params.per_page = String(opts.perPage);
  if (opts.page) params.page = String(opts.page);
  if (opts.after) {
    const ts = new Date(opts.after).getTime();
    if (Number.isNaN(ts)) throw new Error(`Invalid "after" date: ${opts.after}`);
    params.after = String(Math.floor(ts / 1000));
  }
  if (opts.before) {
    const ts = new Date(opts.before).getTime();
    if (Number.isNaN(ts)) throw new Error(`Invalid "before" date: ${opts.before}`);
    params.before = String(Math.floor(ts / 1000));
  }

  return stravaFetch<StravaActivity[]>(token, "/athlete/activities", params);
}

/** Get full details for a single activity. */
export async function getActivity(
  token: string,
  activityId: string,
): Promise<StravaActivityDetail> {
  return stravaFetch<StravaActivityDetail>(token, `/activities/${activityId}`);
}

/** Lightweight check that the token is still valid (calls /athlete). */
export async function verifyToken(token: string): Promise<boolean> {
  try {
    await stravaFetch<unknown>(token, "/athlete");
    return true;
  } catch (err) {
    if (err instanceof StravaApiError && err.status === 401) return false;
    throw err;
  }
}

/** Get aggregated stats for an athlete. */
export async function getAthleteStats(
  token: string,
  athleteId: string,
): Promise<StravaAthleteStats> {
  return stravaFetch<StravaAthleteStats>(token, `/athletes/${athleteId}/stats`);
}

// --- Formatting helpers ---

/** Convert m/s to pace string like "5:30 /km". */
export function formatPace(metersPerSecond: number): string {
  if (metersPerSecond <= 0) return "N/A";
  const totalSec = Math.round(1000 / metersPerSecond);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, "0")} /km`;
}

/** Convert seconds to a readable duration like "1h 23m 45s". */
export function formatDuration(seconds: number): string {
  // Round to nearest second first to avoid fractional-second rollover (e.g. 59.7s → 60s).
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Convert meters to km string like "10.50 km". */
export function formatDistance(meters: number): string {
  return `${(meters / 1000).toFixed(2)} km`;
}
