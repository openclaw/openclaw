import { describe, it, expect } from 'vitest';
import { buildMarkdownReport } from '../report-generator.mjs';

describe('report-generator', () => {
  it('renders header with date and counts', () => {
    const experiments = [
      { exp: 1, skill: 'gog', model: 'opus', old_f1: 0.7, new_f1: 0.8, delta: 0.1, outcome: 'commit', cost_usd: 0 },
      { exp: 2, skill: 'gog', model: 'sonnet', old_f1: 0.8, new_f1: 0.75, delta: -0.05, outcome: 'reset', cost_usd: 0.12 },
    ];
    const token = 'abcd1234';
    const md = buildMarkdownReport({ date: '2026-04-15', experiments, token, totalCost: 0.12, flags: [] });
    expect(md).toContain('2026-04-15');
    expect(md).toContain('localhost:9876/approve?token=abcd1234');
    expect(md).toContain('localhost:9876/reject?token=abcd1234');
    expect(md).toContain('Experiments: 2');
    expect(md).toContain('Wins: 1');
    expect(md).toContain('gog');
  });

  it('flags reward hacks prominently', () => {
    const md = buildMarkdownReport({ date: '2026-04-15', experiments: [], token: 't', totalCost: 0, flags: [{ skill: 'gog', type: 'reward_hack_suspected' }] });
    expect(md).toMatch(/🚩/);
  });
});
