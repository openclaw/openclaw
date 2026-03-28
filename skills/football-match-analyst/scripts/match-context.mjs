#!/usr/bin/env node
/**
 * Match context → token-efficient `llmPack` (API-Football, Sportmonks, Nami, Opta).
 *
 * Single source: `--provider <name>` (default api-football).
 * Multi source: `--providers api-football,sportmonks` (parallel; requires credentials per source).
 * Optional: `--primary-provider api-football` — which `llmPack` mirrors at top level when multi.
 *
 * Providers:
 *   api-football (default) — env: API_FOOTBALL_KEY
 *   sportmonks            — env: SPORTMONKS_TOKEN or SPORTMONKS_API_TOKEN
 *   nami                  — env: NAMI_USER + NAMI_SECRET
 *   opta                  — env: OPTA_API_BASE + OPTA_API_KEY
 *   football-data         — local CSV from Football-Data.co.uk: --csv path or FOOTBALL_DATA_CSV (no API key)
 * Kaggle CSVs: use scripts/kaggle-fetch.mjs (KAGGLE_USERNAME + KAGGLE_KEY), then --provider football-data --csv <file>
 *
 * Options: --last N (5–100), --verbose, --provider, --providers, --primary-provider, --csv ...
 */

import {
  canonicalProvider,
  parseProvidersList,
  runMultiProviders,
  runOneProvider,
  validateProviderList,
} from "./lib/run-providers.mjs";

function parseArgs(argv) {
  const out = {
    date: null,
    home: null,
    away: null,
    fixture: null,
    last: 50,
    verbose: false,
    provider: "api-football",
    providersCsv: null,
    primaryProvider: null,
    csv: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--date") out.date = argv[++i];
    else if (a === "--home") out.home = argv[++i];
    else if (a === "--away") out.away = argv[++i];
    else if (a === "--fixture") {
      const v = argv[++i];
      out.fixture = v === undefined ? null : Number(v);
    } else if (a === "--last") out.last = Math.min(100, Math.max(5, Number(argv[++i]) || 50));
    else if (a === "--verbose") out.verbose = true;
    else if (a === "--provider") out.provider = String(argv[++i] ?? "").toLowerCase();
    else if (a === "--providers") out.providersCsv = String(argv[++i] ?? "");
    else if (a === "--primary-provider")
      out.primaryProvider = String(argv[++i] ?? "").toLowerCase();
    else if (a === "--csv") out.csv = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.error(`Usage:
  Single: API_FOOTBALL_KEY=key node match-context.mjs [--provider api-football] --date YYYY-MM-DD --home "A" --away "B" [--last 50] [--verbose]
  Multi:  node match-context.mjs --providers api-football,sportmonks --date YYYY-MM-DD --home "A" --away "B" [--primary-provider api-football]
  Football-Data CSV: --provider football-data --csv path/to/E0.csv --date YYYY-MM-DD --home "A" --away "B"
  node match-context.mjs --fixture ID [--provider ... | --providers a,b]
`);
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.providersCsv != null && String(args.providersCsv).trim() !== "") {
    const list = parseProvidersList(args.providersCsv);
    validateProviderList(list);
    if (list.length === 0) {
      console.error("Empty --providers list.");
      process.exit(1);
    }
    if (list.length === 1) {
      const result = await runOneProvider(list[0], args);
      console.log(JSON.stringify(result, null, 2));
      if (result.ok === false) process.exit(0);
      return;
    }
    const primary = args.primaryProvider ? canonicalProvider(args.primaryProvider) : null;
    if (primary && !list.includes(primary)) {
      console.error(`--primary-provider "${primary}" is not in --providers (${list.join(", ")}).`);
      process.exit(1);
    }
    const result = await runMultiProviders(args, list, primary || undefined);
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exit(0);
    return;
  }

  const p = canonicalProvider(args.provider);

  const result = await runOneProvider(p, args);
  console.log(JSON.stringify(result, null, 2));
  if (result.ok === false) process.exit(0);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
