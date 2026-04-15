import { describe, it, expect } from 'vitest';
import { scoreSkills, selectPool, TARGET_F1, MIN_USAGE } from '../lib/pool-selector.mjs';

const skills = ['a', 'b', 'c', 'd', 'e'];
const metrics = {
  a: { f1: 0.10 }, // heavy use, big gap → top EVI
  b: { f1: 0.50 }, // heavy use, medium gap
  c: { f1: 0.30 }, // low use, dropped by threshold
  d: { f1: 0.98 }, // graduated
  e: { f1: 0.00 }, // no usage, dropped
};
const usage = { a: 100, b: 80, c: 2, d: 50, e: 0 };

describe('scoreSkills', () => {
  it('computes EVI as usage × gap', () => {
    const scored = scoreSkills({ perSkillMetrics: metrics, usageCounts: usage, skills });
    const a = scored.find(s => s.name === 'a');
    expect(a.evi).toBeCloseTo(100 * (0.95 - 0.10), 5);
  });

  it('flags graduated skills', () => {
    const scored = scoreSkills({ perSkillMetrics: metrics, usageCounts: usage, skills });
    expect(scored.find(s => s.name === 'd').graduated).toBe(true);
  });

  it('flags below-threshold usage', () => {
    const scored = scoreSkills({ perSkillMetrics: metrics, usageCounts: usage, skills });
    expect(scored.find(s => s.name === 'c').below_threshold).toBe(true);
  });

  it('handles missing metrics and missing usage as zero', () => {
    const scored = scoreSkills({ perSkillMetrics: { a: { f1: 0.5 } }, usageCounts: { a: 10 }, skills: ['a', 'z'] });
    const z = scored.find(s => s.name === 'z');
    expect(z.current_f1).toBe(0);
    expect(z.usage_count).toBe(0);
    expect(z.evi).toBe(0);
  });
});

describe('selectPool', () => {
  it('excludes graduated, low-usage, and zero-EVI skills', () => {
    const scored = scoreSkills({ perSkillMetrics: metrics, usageCounts: usage, skills });
    const pool = selectPool(scored, 10);
    const names = pool.map(p => p.name);
    expect(names).not.toContain('d'); // graduated
    expect(names).not.toContain('c'); // below threshold
    expect(names).not.toContain('e'); // zero usage
  });

  it('sorts by EVI descending', () => {
    const scored = scoreSkills({ perSkillMetrics: metrics, usageCounts: usage, skills });
    const pool = selectPool(scored, 10);
    for (let i = 1; i < pool.length; i++) {
      expect(pool[i - 1].evi).toBeGreaterThanOrEqual(pool[i].evi);
    }
  });

  it('respects size cap', () => {
    const pool = selectPool(scoreSkills({ perSkillMetrics: metrics, usageCounts: usage, skills }), 1);
    expect(pool).toHaveLength(1);
    expect(pool[0].name).toBe('a');
  });

  it('preserves pool entry shape expected by loop.mjs', () => {
    const pool = selectPool(scoreSkills({ perSkillMetrics: metrics, usageCounts: usage, skills }), 10);
    const entry = pool[0];
    expect(entry).toHaveProperty('name');
    expect(entry).toHaveProperty('baseline_f1');
    expect(entry).toHaveProperty('current_f1');
    expect(entry).toHaveProperty('exhausted', false);
    expect(entry).toHaveProperty('graduated', false);
  });
});

describe('constants', () => {
  it('TARGET_F1 matches graduation bar', () => {
    expect(TARGET_F1).toBe(0.95);
  });

  it('MIN_USAGE is 5', () => {
    expect(MIN_USAGE).toBe(5);
  });
});
