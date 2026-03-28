#!/usr/bin/env node
/**
 * Opta-like live events → commentaryPack (filtered + context + persona hints).
 *
 *   node opta-live-pack.mjs --file events.json [--persona data|passion|poetic|neutral]
 *   cat events.ndjson | node opta-live-pack.mjs --stdin
 *
 * Input: JSON array of events, or NDJSON (one object per line) with --stdin.
 */

import fs from "node:fs";
import { buildCommentaryPack, PERSONAS } from "./lib/opta-commentary-pack.mjs";

function parseArgs(argv) {
  const out = {
    file: null,
    stdin: false,
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
    else if (a === "--persona") out.persona = String(argv[++i] ?? "neutral").toLowerCase();
    else if (a === "--home-name") out.homeName = argv[++i];
    else if (a === "--away-name") out.awayName = argv[++i];
    else if (a === "--home-id") out.homeId = argv[++i];
    else if (a === "--away-id") out.awayId = argv[++i];
    else if (a === "--pass-chain") out.passChain = Number(argv[++i]) || 15;
    else if (a === "--help" || a === "-h") {
      console.error(`Usage:
  node opta-live-pack.mjs --file events.json [--persona neutral|data|passion|poetic] [--home-name "A"] [--away-name "B"]
  node opta-live-pack.mjs --stdin < events.ndjson

Persona aliases: zhanjun→data, huang|huangjianxiang→passion, hewei→poetic

${Object.keys(PERSONAS).join(", ")}
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
      /* skip bad line */
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  let text = "";

  if (args.stdin || (!args.file && process.stdin.isTTY === false)) {
    const chunks = [];
    for await (const ch of process.stdin) chunks.push(ch);
    text = Buffer.concat(chunks).toString("utf8");
  } else if (args.file) {
    text = fs.readFileSync(args.file, "utf8");
  } else {
    console.error("Provide --file path.json or pipe JSON/NDJSON on stdin.");
    process.exit(1);
  }

  const events = parseJsonInput(text);
  const pack = buildCommentaryPack(events, {
    persona: resolvePersona(args.persona),
    homeName: args.homeName ?? undefined,
    awayName: args.awayName ?? undefined,
    homeId: args.homeId ?? undefined,
    awayId: args.awayId ?? undefined,
    passChainThreshold: args.passChain,
  });

  console.log(JSON.stringify(pack, null, 2));
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
