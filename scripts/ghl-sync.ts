#!/usr/bin/env -S node --import tsx
/**
 * Go High Level (GHL) Data Sync
 *
 * Pulls data from the GHL / LeadConnector API and writes JSON snapshots
 * to ~/.openclaw/cache/ghl/ for downstream consumers (JR, reports).
 *
 * Usage (from repo root):
 *   pnpm exec tsx scripts/ghl-sync.ts              # sync all configured endpoints
 *   pnpm exec tsx scripts/ghl-sync.ts --only calendars,contacts   # sync specific resources
 *
 * Requires: GHL_API_KEY + GHL_LOCATION_ID in env or ~/.openclaw/.env
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ghl, ghlPaginate, getLocationId } from "./ghl-client.js";

const CACHE_DIR = join(homedir(), ".openclaw", "cache", "ghl");

function writeJson(filename: string, data: unknown): void {
  const path = join(CACHE_DIR, filename);
  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`  wrote ${path}`);
}

function formatCaught(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Endpoint config — each resource declares its path, API version, data key,
// and whether it paginates. Add new resources here; versions can differ.
// ---------------------------------------------------------------------------

interface EndpointConfig {
  /** Path template — use __LOCATION_ID__ for path-level substitution */
  path: string;
  version: string;
  dataKey: string;
  /** Single-page response (no pagination). Default: false */
  single?: boolean;
  /** Extra query params beyond locationId */
  params?: Record<string, string | number | boolean>;
  /** Skip automatic locationId query param (use when it's already in the path) */
  skipLocationId?: boolean;
  /** Output filename (defaults to <key>.json) */
  file?: string;
}

const ENDPOINTS: Record<string, EndpointConfig> = {
  // ── Brand Boards ── version 2021-07-28
  "brand-boards": {
    path: "/brand-boards/__LOCATION_ID__",
    version: "2021-07-28",
    dataKey: "brandBoards",
    single: true,
    skipLocationId: true,
  },

  // ── Businesses ── version 2021-07-28
  businesses: {
    path: "/businesses/",
    version: "2021-07-28",
    dataKey: "businesses",
    single: true,
  },

  // ── Calendars ── version 2021-04-15
  calendars: {
    path: "/calendars/",
    version: "2021-04-15",
    dataKey: "calendars",
    single: true,
  },
  "calendar-groups": {
    path: "/calendars/groups",
    version: "2021-04-15",
    dataKey: "groups",
    single: true,
  },
  "calendar-services": {
    path: "/calendars/services/catalog",
    version: "2021-04-15",
    dataKey: "services",
    single: true,
  },
  "service-locations": {
    path: "/calendars/services/locations",
    version: "2021-04-15",
    dataKey: "locations",
    single: true,
  },
  // blocked-slots, calendar-events, and bookings require per-calendar iteration
  // — handled in syncCalendarDependents() below, not in the generic config.

  // ── Campaigns ── version 2021-07-28
  campaigns: {
    path: "/campaigns/",
    version: "2021-07-28",
    dataKey: "campaigns",
    single: true,
  },

  // ── Contacts ── version 2021-07-28
  contacts: {
    path: "/contacts/",
    version: "2021-07-28",
    dataKey: "contacts",
  },

  // ── Funnels ── version 2021-07-28
  funnels: {
    path: "/funnels/funnel/list",
    version: "2021-07-28",
    dataKey: "funnels",
    single: true,
  },

  // ── Forms ── version 2021-07-28
  forms: {
    path: "/forms/",
    version: "2021-07-28",
    dataKey: "forms",
    single: true,
  },
  "form-submissions": {
    path: "/forms/submissions",
    version: "2021-07-28",
    dataKey: "submissions",
    single: true,
    params: { limit: 100 },
  },

  // ── Opportunities ── version 2021-07-28
  opportunities: {
    path: "/opportunities/search",
    version: "2021-07-28",
    dataKey: "opportunities",
    skipLocationId: true,
    params: { location_id: "__LOCATION_ID__" },
  },
  pipelines: {
    path: "/opportunities/pipelines",
    version: "2021-07-28",
    dataKey: "pipelines",
    single: true,
  },

  // ── Conversations ── version 2021-04-15
  conversations: {
    path: "/conversations/search",
    version: "2021-04-15",
    dataKey: "conversations",
    single: true,
    params: { limit: 100 },
  },
  "messages-export": {
    path: "/conversations/messages/export",
    version: "2021-04-15",
    dataKey: "messages",
    params: { type: "all" },
  },

  // ── Users ── version 2021-04-15
  users: {
    path: "/users/",
    version: "2021-04-15",
    dataKey: "users",
    single: true,
  },
};

const DAY_MS = 24 * 60 * 60 * 1000;

const DYNAMIC_VALUES: Record<string, () => string | number> = {
  __LOCATION_ID__: () => getLocationId(),
  __90_DAYS_AGO__: () => String(Date.now() - 90 * DAY_MS),
  __30_DAYS_AHEAD__: () => String(Date.now() + 30 * DAY_MS),
};

function resolveParams(
  params: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> {
  if (!params) {
    return {};
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(params)) {
    const resolver = typeof v === "string" ? DYNAMIC_VALUES[v] : undefined;
    out[k] = resolver ? resolver() : v;
  }
  return out;
}

function resolvePath(path: string): string {
  return path.replace(/__LOCATION_ID__/g, getLocationId());
}

async function syncResource(key: string, cfg: EndpointConfig): Promise<unknown[]> {
  console.log(`Syncing ${key}...`);
  const path = resolvePath(cfg.path);
  const params = resolveParams(cfg.params);

  let items: unknown[];
  if (cfg.single) {
    const res = await ghl<Record<string, unknown>>(path, {
      version: cfg.version,
      params,
      skipLocationId: cfg.skipLocationId,
    });
    items = (res[cfg.dataKey] ?? []) as unknown[];
  } else {
    items = await ghlPaginate(path, {
      dataKey: cfg.dataKey,
      params,
      version: cfg.version,
      skipLocationId: cfg.skipLocationId,
    });
  }

  console.log(`  fetched ${items.length} ${key}`);
  writeJson(cfg.file ?? `${key}.json`, items);
  return items;
}

/**
 * Endpoints that require a calendarId: blocked-slots, calendar-events, bookings.
 * We read the already-synced calendars.json, then iterate each calendar.
 * Bookings has a 31-day max window so we chunk into 30-day slices.
 */
async function syncCalendarDependents(): Promise<Record<string, number>> {
  const calPath = join(CACHE_DIR, "calendars.json");
  let calendars: Array<{ id: string; name?: string }>;
  try {
    calendars = JSON.parse(readFileSync(calPath, "utf-8"));
  } catch {
    console.log("  skipping calendar-dependents — no calendars.json yet");
    return {};
  }
  if (calendars.length === 0) {
    console.log("  skipping calendar-dependents — 0 calendars");
    return {};
  }

  const calVersion = "2021-04-15";
  const now = Date.now();
  const allBlockedSlots: unknown[] = [];
  const allEvents: unknown[] = [];
  const allBookings: unknown[] = [];

  for (const cal of calendars) {
    const calId = cal.id;

    // blocked-slots
    try {
      const res = await ghl<Record<string, unknown>>("/calendars/blocked-slots", {
        version: calVersion,
        params: {
          calendarId: calId,
          startTime: String(now - 90 * DAY_MS),
          endTime: String(now + 30 * DAY_MS),
        },
      });
      const items = (res.events ?? []) as unknown[];
      allBlockedSlots.push(...items);
    } catch (err) {
      console.error(`  blocked-slots (${calId}): ${formatCaught(err)}`);
    }

    // calendar-events
    try {
      const res = await ghl<Record<string, unknown>>("/calendars/events", {
        version: calVersion,
        params: {
          calendarId: calId,
          startTime: String(now - 90 * DAY_MS),
          endTime: String(now + 30 * DAY_MS),
        },
      });
      const items = (res.events ?? []) as unknown[];
      allEvents.push(...items);
    } catch (err) {
      console.error(`  calendar-events (${calId}): ${formatCaught(err)}`);
    }

    // bookings — 30-day chunks (API max 31 days)
    try {
      let chunkStart = now - 90 * DAY_MS;
      const end = now + 30 * DAY_MS;
      while (chunkStart < end) {
        const chunkEnd = Math.min(chunkStart + 30 * DAY_MS, end);
        const res = await ghl<Record<string, unknown>>("/calendars/services/bookings", {
          version: calVersion,
          params: {
            calendarId: calId,
            startTime: String(chunkStart),
            endTime: String(chunkEnd),
            timezone: "America/Denver",
          },
        });
        const items = (res.bookings ?? []) as unknown[];
        allBookings.push(...items);
        chunkStart = chunkEnd;
      }
    } catch (err) {
      console.error(`  bookings (${calId}): ${formatCaught(err)}`);
    }
  }

  console.log(
    `  fetched ${allBlockedSlots.length} blocked-slots, ${allEvents.length} calendar-events, ${allBookings.length} bookings`,
  );
  writeJson("blocked-slots.json", allBlockedSlots);
  writeJson("calendar-events.json", allEvents);
  writeJson("bookings.json", allBookings);

  return {
    "blocked-slots": allBlockedSlots.length,
    "calendar-events": allEvents.length,
    bookings: allBookings.length,
  };
}

async function main() {
  const startMs = Date.now();
  console.log(`GHL Sync — ${new Date().toISOString()}`);
  console.log(`Cache dir: ${CACHE_DIR}`);
  mkdirSync(CACHE_DIR, { recursive: true });

  // Parse --only flag
  const onlyIdx = process.argv.indexOf("--only");
  const selectedKeys =
    onlyIdx >= 0
      ? process.argv[onlyIdx + 1].split(",").map((s) => s.trim())
      : Object.keys(ENDPOINTS);

  const counts: Record<string, number> = {};

  for (const key of selectedKeys) {
    const cfg = ENDPOINTS[key];
    if (!cfg) {
      console.warn(`  unknown resource "${key}" — skipping`);
      continue;
    }
    try {
      const items = await syncResource(key, cfg);
      counts[key] = items.length;
    } catch (err) {
      console.error(`  ${key}: FAILED — ${formatCaught(err)}`);
      counts[key] = -1;
    }
  }

  // Calendar-dependent endpoints (need calendarId, custom time windows)
  const skipCalDeps =
    onlyIdx >= 0 &&
    !["blocked-slots", "calendar-events", "bookings"].some((k) => selectedKeys.includes(k));
  if (!skipCalDeps) {
    try {
      const calCounts = await syncCalendarDependents();
      Object.assign(counts, calCounts);
    } catch (err) {
      console.error(`  calendar-dependents: FAILED — ${formatCaught(err)}`);
    }
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

  const meta = {
    lastSyncAt: new Date().toISOString(),
    elapsedSeconds: Number(elapsed),
    counts,
  };
  writeJson("meta.json", meta);

  console.log(`\nDone in ${elapsed}s`);
  console.log(JSON.stringify(meta, null, 2));
}

main().catch((err) => {
  console.error("GHL sync failed:", err);
  process.exit(1);
});
