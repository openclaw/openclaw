#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

export function parseArgs(argv) {
  const args = { file: null, strict: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--strict') args.strict = true;
    else if (t === '--json') args.json = true;
    else if (!args.file) args.file = t;
  }
  return args;
}

function summarizeEvent(event, index) {
  const ts = event.timestamp || event.time || event.ts || `line#${index}`;
  const type = event.type || event.event || 'unknown';
  const tool = event.tool || event.name || '-';
  return { ts, type, tool };
}

export function parseJsonl(content) {
  const lines = content.split(/\r?\n/);
  const events = [];
  const malformed = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      events.push(summarizeEvent(obj, i + 1));
    } catch {
      malformed.push(i + 1);
    }
  }
  return { events, malformed };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.file) {
    console.error('Usage: node scripts/experimental/replay-trace.mjs <trace.jsonl> [--strict] [--json]');
    process.exit(2);
  }

  const text = await readFile(args.file, 'utf8');
  const out = parseJsonl(text);

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`Replay timeline (${out.events.length} events)`);
    out.events.forEach((e, i) => {
      console.log(`${String(i + 1).padStart(3, ' ')}. ${e.ts} | ${e.type} | ${e.tool}`);
    });
    if (out.malformed.length) {
      console.log(`Malformed lines: ${out.malformed.join(', ')}`);
    }
  }

  if (args.strict && out.malformed.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
