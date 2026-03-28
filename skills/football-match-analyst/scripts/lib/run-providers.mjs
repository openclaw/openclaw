/**
 * Dispatch single-provider runs for match-context.mjs (single + multi mode).
 */

import { runApiFootball } from "./api-football.mjs";
import { runFootballDataCsv } from "./football-data-csv.mjs";
import { runNami } from "./nami.mjs";
import { runOpta } from "./opta.mjs";
import { runSportmonks } from "./sportmonks.mjs";

const ALIASES = {
  nanomi: "nami",
  statsperform: "opta",
  "api-football": "api-football",
  apifootball: "api-football",
  fd: "football-data",
  "football-data-co-uk": "football-data",
  "football-local-data": "football-data",
  footballdatacouk: "football-data",
};

/** Stable key for JSON output */
export function canonicalProvider(p) {
  const s = String(p ?? "")
    .trim()
    .toLowerCase();
  return ALIASES[s] ?? s;
}

/**
 * @param {string} csv e.g. "api-football,sportmonks"
 * @returns {string[]} deduped canonical ids, order preserved
 */
export function parseProvidersList(csv) {
  const seen = new Set();
  const out = [];
  for (const part of String(csv).split(/[,;]+/)) {
    const c = canonicalProvider(part);
    if (!c) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

const KNOWN = new Set(["api-football", "sportmonks", "nami", "opta", "football-data"]);

export function validateProviderList(list) {
  const bad = list.filter((p) => !KNOWN.has(p));
  if (bad.length) {
    throw new Error(
      `Unknown provider(s): ${bad.join(", ")}. Expected: api-football, sportmonks, nami, opta, football-data`,
    );
  }
}

/**
 * @returns {Promise<{ ok: boolean, llmPack: object | null, meta: object, query?: object, raw?: object }>}
 */
export async function runOneProvider(name, args) {
  const n = canonicalProvider(name);
  try {
    if (n === "sportmonks") {
      const token =
        process.env.SPORTMONKS_TOKEN?.trim() || process.env.SPORTMONKS_API_TOKEN?.trim();
      if (!token) {
        return {
          ok: false,
          llmPack: null,
          meta: {
            source: "sportmonks v3",
            warnings: [],
            error: "Missing SPORTMONKS_TOKEN or SPORTMONKS_API_TOKEN",
          },
          query: null,
          raw: null,
        };
      }
      return await runSportmonks(args, token);
    }

    if (n === "opta") {
      const base = process.env.OPTA_API_BASE?.trim();
      const key = process.env.OPTA_API_KEY?.trim();
      if (!base || !key) {
        return {
          ok: false,
          llmPack: null,
          meta: {
            source: "opta-configurable",
            warnings: [],
            error: "Missing OPTA_API_BASE or OPTA_API_KEY",
          },
          query: null,
          raw: null,
        };
      }
      return await runOpta(args);
    }

    if (n === "nami") {
      const user = process.env.NAMI_USER?.trim();
      const secret = process.env.NAMI_SECRET?.trim();
      if (!user || !secret) {
        return {
          ok: false,
          llmPack: null,
          meta: {
            source: "nami-v5-archive",
            warnings: [],
            error: "Missing NAMI_USER or NAMI_SECRET",
          },
          query: null,
          raw: null,
        };
      }
      return await runNami(args, user, secret);
    }

    if (n === "api-football") {
      const key = process.env.API_FOOTBALL_KEY?.trim();
      if (!key) {
        return {
          ok: false,
          llmPack: null,
          meta: {
            source: "api-football v3",
            warnings: [],
            error: "Missing API_FOOTBALL_KEY",
          },
          query: null,
          raw: null,
        };
      }
      return await runApiFootball(args, key);
    }

    if (n === "football-data") {
      const csv =
        args.csv?.trim() ||
        process.env.FOOTBALL_DATA_CSV?.trim() ||
        process.env.FOOTBALL_DATA_CSV_PATH?.trim();
      return await runFootballDataCsv(args, csv);
    }

    return {
      ok: false,
      llmPack: null,
      meta: { source: n, warnings: [], error: `Unhandled provider: ${n}` },
      query: null,
      raw: null,
    };
  } catch (e) {
    return {
      ok: false,
      llmPack: null,
      meta: {
        source: n,
        warnings: [],
        error: String(e?.message ?? e),
      },
      query: null,
      raw: null,
    };
  }
}

/**
 * @param {string[]} providers canonical list, length >= 2
 */
export async function runMultiProviders(args, providers, primaryHint) {
  const results = await Promise.all(providers.map((p) => runOneProvider(p, args)));

  /** @type {Record<string, typeof results[0]>} */
  const bySource = {};
  for (let i = 0; i < providers.length; i++) {
    bySource[providers[i]] = results[i];
  }

  const anyOk = results.some((r) => r.ok);
  const primaryCanon = canonicalProvider(primaryHint ?? "");
  let primaryPack = null;
  let primaryName = null;
  if (primaryCanon && providers.includes(primaryCanon)) {
    const r = bySource[primaryCanon];
    if (r?.ok && r.llmPack) {
      primaryPack = r.llmPack;
      primaryName = primaryCanon;
    }
  }
  if (!primaryName) {
    for (const p of providers) {
      const r = bySource[p];
      if (r?.ok && r.llmPack) {
        primaryName = p;
        primaryPack = r.llmPack;
        break;
      }
    }
  }

  const combinedWarnings = [];
  for (const p of providers) {
    const r = bySource[p];
    const w = r?.meta?.warnings;
    if (Array.isArray(w) && w.length) {
      for (const x of w) combinedWarnings.push(`[${p}] ${x}`);
    }
    const err = r?.meta?.error;
    if (err) combinedWarnings.push(`[${p}] ${err}`);
  }

  return {
    ok: anyOk,
    multiSource: true,
    multiOutputSchemaVersion: 1,
    providers,
    primaryProvider: primaryName,
    /** Same shape as single-provider success: prefer this for quick reads when multi. */
    llmPack: primaryPack,
    bySource,
    meta: {
      source: "football-match-analyst multi",
      note: "Multi-source: each bySource entry is independent; metrics may disagree across vendors. Prefer comparing side-by-side or use primaryProvider / llmPack as a single default slice.",
      combinedWarnings,
    },
    query: Number.isFinite(args.fixture)
      ? { fixture: args.fixture, providers, multiSource: true }
      : { date: args.date, home: args.home, away: args.away, providers, multiSource: true },
  };
}
