#!/usr/bin/env node
/**
 * 纳米数据 — 足球实时事件 → commentaryPack（与 opta-live-pack 共用分级与 persona）。
 *
 * 文档: https://www.nami.com/zh/details/j3ry6iztqltnwe0
 * 环境: NAMI_USER, NAMI_SECRET；可选 NAMI_API_BASE、NAMI_PATH_LIVE_EVENTS、NAMI_PARAM_LIVE_MATCH_ID、NAMI_LIVE_EXTRA(JSON)
 *
 *   node nami-live-pack.mjs --file events.json [--persona data]
 *   node nami-live-pack.mjs --fetch --match-id 12345 [--persona poetic]
 */

import fs from "node:fs";
import { fetchNamiLiveEventList } from "./lib/nami-live-fetch.mjs";
import { normalizeNamiLiveBatch } from "./lib/nami-live-normalize.mjs";
import { buildCommentaryPack, PERSONAS } from "./lib/opta-commentary-pack.mjs";

function parseArgs(argv) {
  const out = {
    file: null,
    stdin: false,
    fetch: false,
    matchId: null,
    persona: "neutral",
    homeName: null,
    awayName: null,
    homeId: null,
    awayId: null,
    passChain: 15,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") out.file = argv[++i];
    else if (a === "--stdin") out.stdin = true;
    else if (a === "--fetch") out.fetch = true;
    else if (a === "--match-id") out.matchId = argv[++i];
    else if (a === "--persona") out.persona = String(argv[++i] ?? "neutral").toLowerCase();
    else if (a === "--home-name") out.homeName = argv[++i];
    else if (a === "--away-name") out.awayName = argv[++i];
    else if (a === "--home-id") out.homeId = argv[++i];
    else if (a === "--away-id") out.awayId = argv[++i];
    else if (a === "--pass-chain") out.passChain = Number(argv[++i]) || 15;
    else if (a === "--help" || a === "-h") {
      console.error(`Nami live events → commentaryPack (see docs: https://www.nami.com/zh/details/j3ry6iztqltnwe0)

Usage:
  node nami-live-pack.mjs --file events.json [--persona neutral|data|passion|poetic] ...
  cat events.ndjson | node nami-live-pack.mjs --stdin ...
  NAMI_USER=u NAMI_SECRET=s node nami-live-pack.mjs --fetch --match-id 12345 ...

Env overrides:
  NAMI_API_BASE, NAMI_PATH_LIVE_EVENTS, NAMI_PARAM_LIVE_MATCH_ID (default match_id), NAMI_LIVE_EXTRA (JSON object)
`);
      process.exit(0);
    }
  }
  return out;
}

const PERSONA_ALIASES = {
  zhanjun: "data",
  data: "data",
  huang: "passion",
  huangjianxiang: "passion",
  passion: "passion",
  hewei: "poetic",
  poetic: "poetic",
  neutral: "neutral",
};

function resolvePersona(p) {
  const k = String(p ?? "neutral").toLowerCase();
  return PERSONA_ALIASES[k] ?? (PERSONAS[k] ? k : "neutral");
}

function parseJsonInput(text) {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    const j = JSON.parse(t);
    return Array.isArray(j) ? j : [];
  }
  const lines = t.split(/\n+/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  let rawRecords = [];

  if (args.fetch) {
    const user = process.env.NAMI_USER?.trim();
    const secret = process.env.NAMI_SECRET?.trim();
    const mid = args.matchId ?? process.env.NAMI_LIVE_MATCH_ID?.trim();
    if (!user || !secret) {
      console.error("Missing NAMI_USER or NAMI_SECRET.");
      process.exit(1);
    }
    if (!mid) {
      console.error("Provide --match-id or NAMI_LIVE_MATCH_ID for --fetch.");
      process.exit(1);
    }
    rawRecords = await fetchNamiLiveEventList({ matchId: mid, user, secret });
  } else if (args.stdin || (!args.file && process.stdin.isTTY === false)) {
    const chunks = [];
    for await (const ch of process.stdin) chunks.push(ch);
    rawRecords = parseJsonInput(Buffer.concat(chunks).toString("utf8"));
  } else if (args.file) {
    rawRecords = parseJsonInput(fs.readFileSync(args.file, "utf8"));
  } else {
    console.error("Use --file, --stdin, or --fetch with NAMI_USER/NAMI_SECRET.");
    process.exit(1);
  }

  const events = normalizeNamiLiveBatch(rawRecords);
  const pack = buildCommentaryPack(events, {
    persona: resolvePersona(args.persona),
    homeName: args.homeName ?? undefined,
    awayName: args.awayName ?? undefined,
    homeId: args.homeId ?? undefined,
    awayId: args.awayId ?? undefined,
    passChainThreshold: args.passChain,
    dataSource: "nami-live",
  });

  if (args.fetch) {
    pack.metaFetch = {
      matchId: String(args.matchId ?? process.env.NAMI_LIVE_MATCH_ID ?? ""),
      path: process.env.NAMI_PATH_LIVE_EVENTS || "/api/v5/football/match/live",
      note: "Tune NAMI_PATH_LIVE_EVENTS / NAMI_PARAM_LIVE_MATCH_ID / NAMI_LIVE_EXTRA per your contract (see Nami 足球实时数据 documentation).",
    };
  }

  console.log(JSON.stringify(pack, null, 2));
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
