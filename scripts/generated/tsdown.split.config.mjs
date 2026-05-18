import { defineConfig } from 'tsdown';
import base from '../..//tsdown.config.ts';

const cfg = Array.isArray(base) ? base[0] : base;
const entries = cfg.entry;
const keys = Object.keys(entries).sort();
const mid = Math.ceil(keys.length/2);
const pick = (ks) => Object.fromEntries(ks.map(k => [k, entries[k]]));

export default defineConfig([
  { ...cfg, clean: true, entry: pick(keys.slice(0, mid)) },
  { ...cfg, clean: false, entry: pick(keys.slice(mid)) },
]);
