// usage.mjs — read skill usage counts from ~/.autoresearch/usage.json
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const USAGE_PATH = join(homedir(), '.autoresearch', 'usage.json');

export function readUsage(path = USAGE_PATH) {
  if (!existsSync(path)) return { counts: {}, window_days: 30, generated_at: null, source: 'missing' };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return {
      counts: raw.counts || {},
      window_days: raw.window_days ?? 30,
      generated_at: raw.generated_at || null,
      source: raw.source || 'unknown',
    };
  } catch {
    return { counts: {}, window_days: 30, generated_at: null, source: 'invalid' };
  }
}

export function getCount(usage, skill) {
  return usage.counts[skill] || 0;
}
