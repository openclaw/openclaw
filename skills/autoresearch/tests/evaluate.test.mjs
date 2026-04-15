import { describe, it, expect } from 'vitest';
import { computeMetrics, cacheKeyFromSkills } from '../evaluate.mjs';

describe('evaluate — pure functions', () => {
  describe('computeMetrics', () => {
    it('computes F1 for perfect predictions', () => {
      const results = [
        { expected: 'gog', predicted: 'gog' },
        { expected: 'gog', predicted: 'gog' },
      ];
      const m = computeMetrics(results);
      expect(m.per_skill.gog.f1).toBe(1.0);
      expect(m.global_f1).toBe(1.0);
    });

    it('computes F1 for mixed predictions', () => {
      const results = [
        { expected: 'gog', predicted: 'gog' },     // TP gog
        { expected: 'gog', predicted: 'himalaya' }, // FN gog, FP himalaya
        { expected: 'himalaya', predicted: 'himalaya' }, // TP himalaya
      ];
      const m = computeMetrics(results);
      // gog: precision=1/1=1.0, recall=1/2=0.5, F1 = 2*1*0.5/(1+0.5) = 0.667
      expect(m.per_skill.gog.f1).toBeCloseTo(0.667, 2);
    });

    it('handles skill with zero predictions (no FP, no TP)', () => {
      const results = [{ expected: 'unused', predicted: 'other' }];
      const m = computeMetrics(results);
      expect(m.per_skill.unused.f1).toBe(0);
    });
  });

  describe('cacheKeyFromSkills', () => {
    it('same skills → same key', () => {
      const a = [{ name: 'x', description: 'foo' }];
      const b = [{ name: 'x', description: 'foo' }];
      expect(cacheKeyFromSkills(a)).toBe(cacheKeyFromSkills(b));
    });

    it('different description → different key', () => {
      const a = [{ name: 'x', description: 'foo' }];
      const b = [{ name: 'x', description: 'bar' }];
      expect(cacheKeyFromSkills(a)).not.toBe(cacheKeyFromSkills(b));
    });

    it('order-independent', () => {
      const a = [{ name: 'x', description: 'foo' }, { name: 'y', description: 'bar' }];
      const b = [{ name: 'y', description: 'bar' }, { name: 'x', description: 'foo' }];
      expect(cacheKeyFromSkills(a)).toBe(cacheKeyFromSkills(b));
    });
  });
});
