import { describe, it, expect } from 'vitest';
import { createBudgetTracker } from '../lib/budget.mjs';

describe('budget', () => {
  it('starts at $0', () => {
    const b = createBudgetTracker(4.00);
    expect(b.spent()).toBe(0);
    expect(b.remaining()).toBe(4.00);
    expect(b.canAfford(0.01)).toBe(true);
  });

  it('records Sonnet usage correctly ($3/M in, $15/M out)', () => {
    const b = createBudgetTracker(4.00);
    b.record({ inputTokens: 1_000_000, outputTokens: 100_000 });
    // 1M * $3 + 0.1M * $15 = $3 + $1.5 = $4.50
    expect(b.spent()).toBeCloseTo(4.50, 2);
  });

  it('canAfford returns false when over cap', () => {
    const b = createBudgetTracker(4.00);
    b.record({ inputTokens: 1_000_000, outputTokens: 100_000 });
    expect(b.canAfford(0.01)).toBe(false);
  });

  it('remaining never goes negative', () => {
    const b = createBudgetTracker(4.00);
    b.record({ inputTokens: 10_000_000, outputTokens: 0 });
    expect(b.remaining()).toBe(0);
  });
});
