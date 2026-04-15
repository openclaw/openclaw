// bootstrap-usage.mjs — best-effort scan for skill usage signals.
//
// OpenClaw does not currently emit skill-activation telemetry, so this
// scans log sources for substring mentions of each skill name within a
// time window (default 30 days). Fuzzy signal — documented as seed data
// for EVI pool selection until a proper PostToolUse hook ships.
//
// Sources scanned:
//   ~/.openclaw/agents/**/sessions/*.jsonl  (OpenClaw gateway sessions)
//   ~/.openclaw/cron/runs/*.jsonl           (scheduled tasks)
//   ~/.claude/projects/*/*.jsonl            (Claude Code sessions — Skill tool calls)

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { listSkills } from './lib/skills-io.mjs';
import { USAGE_PATH } from './lib/usage.mjs';

const SKILLS_DIR = join(dirname(new URL(import.meta.url).pathname.slice(1)), '..');
const WINDOW_DAYS = Number(process.env.USAGE_WINDOW_DAYS || 30);

function walkJsonl(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonl(p));
    else if (entry.isFile() && /\.jsonl(\.reset\..+)?$/.test(entry.name)) out.push(p);
  }
  return out;
}

function withinWindow(filePath, cutoffMs) {
  try { return statSync(filePath).mtimeMs >= cutoffMs; } catch { return false; }
}

function scanFile(filePath, counts, skillNames, claudeSkillPattern) {
  let content;
  try { content = readFileSync(filePath, 'utf8'); } catch { return; }

  // Claude Code: structured Skill tool calls — high-precision signal (weight 3)
  for (const match of content.matchAll(claudeSkillPattern)) {
    const raw = match[1];
    // Strip plugin prefix: "superpowers:brainstorming" → "brainstorming"
    const bare = raw.includes(':') ? raw.split(':').pop() : raw;
    if (skillNames.has(bare)) counts[bare] = (counts[bare] || 0) + 3;
  }

  // Substring fallback — fuzzy signal (weight 1), word-boundary to reduce noise
  for (const skill of skillNames) {
    if (skill.length < 4) continue; // avoid false positives on short names
    const re = new RegExp(`\\b${skill.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'gi');
    const hits = (content.match(re) || []).length;
    if (hits) counts[skill] = (counts[skill] || 0) + hits;
  }
}

function main() {
  const skills = new Set(listSkills(SKILLS_DIR).filter(s => s !== 'autoresearch'));
  const cutoffMs = Date.now() - WINDOW_DAYS * 86400_000;
  const counts = {};

  const sources = [
    join(homedir(), '.openclaw', 'agents'),
    join(homedir(), '.openclaw', 'cron', 'runs'),
    join(homedir(), '.openclaw-quinn-co', 'agents'),
    join(homedir(), '.claude', 'projects'),
  ];

  const claudeSkillPattern = /"name":"Skill","input":\{"skill":"([^"]+)"/g;
  let filesScanned = 0;
  for (const src of sources) {
    for (const f of walkJsonl(src)) {
      if (!withinWindow(f, cutoffMs)) continue;
      scanFile(f, counts, skills, claudeSkillPattern);
      filesScanned++;
    }
  }

  mkdirSync(dirname(USAGE_PATH), { recursive: true });
  writeFileSync(USAGE_PATH, JSON.stringify({
    counts,
    window_days: WINDOW_DAYS,
    generated_at: new Date().toISOString(),
    source: 'bootstrap-usage-scan',
    files_scanned: filesScanned,
  }, null, 2));

  const top = Object.entries(counts).sort(([, a], [, b]) => b - a);
  console.log(`Scanned ${filesScanned} jsonl files across ${sources.length} sources.`);
  console.log(`Skills with usage signal: ${top.length}`);
  console.log('Top 20 by count:');
  for (const [skill, n] of top.slice(0, 20)) console.log(`  ${n.toString().padStart(5)}  ${skill}`);
  console.log(`\nWrote ${USAGE_PATH}`);
}

main();
