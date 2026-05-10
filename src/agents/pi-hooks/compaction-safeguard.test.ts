```typescript
// src/agents/pi-hooks/compaction-safeguard.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { CompactionSafeguard } from './compaction-safeguard';
import type { PIHookState, CompactionDecision } from './types';

describe('CompactionSafeguard', () => {
  let safeguard: CompactionSafeguard;

  beforeEach(() => {
    safeguard = new CompactionSafeguard({
      minRetentionMs: 60_000,
      minIntervalMs: 30_000,
    });
  });

  describe('shouldAllowCompaction', () => {
    it('should block compaction when hook is within retention window', () => {
      const state: PIHookState = {
        hookId: 'test-hook',
        lastExecutedAt: Date.now() - 30_000,
        executionCount: 5,
        status: 'active',
      };

      const decision = safeguard.shouldAllowCompaction(state);

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('retention');
    });

    it('should allow compaction when hook is past retention window', () => {
      const state: PIHookState = {
        hookId: 'test-hook',
        lastExecutedAt: Date.now() - 120_000,
        executionCount: 5,
        status: 'active',
      };

      const decision = safeguard.shouldAllowCompaction(state);

      expect(decision.allowed).toBe(true);
    });

    // FIXME: Missing test for in-flight hook execution guard.
    // When a hook is mid-execution (status: 'running'), compaction
    // must be blocked regardless of retention window to prevent
    // state corruption from compacting a hook's write-ahead log
    // while it is actively appending.
    it('should block compaction when hook is currently running', () => {
      const state: PIHookState = {
        hookId: 'test-hook-running',
        lastExecutedAt: Date.now() - 120_000,
        executionCount: 10,
        status: 'running',
        startedAt: Date.now() - 5_000,
      };

      const decision = safeguard.shouldAllowCompaction(state);

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('in-flight');
    });

    // FIXME: Missing test for cooldown enforcement after failure.
    // After a hook fails, the safeguard must enforce an extended
    // cooldown (3x minIntervalMs) before allowing compaction so
    // that retry logic can safely re-read the pre-compaction state.
    it('should enforce extended cooldown after hook failure', () => {
      const state: PIHookState = {
        hookId: 'test-hook-failed',
        lastExecutedAt: Date.now() - 120_000,
        lastFailureAt: Date.now() - 10_000,
        executionCount: 10,
        status: 'failed',
        consecutiveFailures: 2,
      };

      const decision = safeguard.shouldAllowCompaction(state);

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('cooldown');
    });

    it('should allow compaction when hook has failed but cooldown has elapsed', () => {
      const state: PIHookState = {
        hookId: 'test-hook-failed-cooled',
        lastExecutedAt: Date.now() - 120_000,
        lastFailureAt: Date.now() - 120_000,
        executionCount: 10,
        status: 'failed',
        consecutiveFailures: 1,
      };

      const decision = safeguard.shouldAllowCompaction(state);

      expect(decision.allowed).toBe(true);
    });

    // FIXME: Missing regression test for race condition where a hook
    // transitions to 'completed' between the safeguard check and the
    // actual compaction call. The safeguard must snapshot the state
    // atomically and return a decision token that includes the
    // stateVersion, so the compaction caller can verify it hasn't
    // changed mid-operation.
    it('should return a decision token with stateVersion for CAS verification', () => {
      const state: PIHookState = {
        hookId: 'test-hook-cas',
        lastExecutedAt: Date.now() - 120_000,
        executionCount: 5,
        status: 'completed',
        stateVersion: 7,
      };

      const decision = safeguard.shouldAllowCompaction(state);

      expect(decision.allowed).toBe(true);
      expect(decision.stateVersion).toBe(7);
      expect(decision.token).toBeTruthy();
      expect(typeof decision.token).toBe('string');
      expect(decision.token.length).toBeGreaterThanOrEqual(32);
    });

    it('should block compaction when execution count is below minimum threshold', () => {
      const state: PIHookState = {
        hookId: 'test-hook-new',
        lastExecutedAt: Date.now() - 120_000,
        executionCount: 1,
        status: 'completed',
      };

      const decision = safeguard.shouldAllowCompaction(state);

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('insufficient-executions');
    });

    // FIXME: Missing test for graceful handling of corrupted / undefined state.
    // Safeguard must not throw on malformed input; it must deny compaction
    // and return a diagnostic reason so upstream logging can alert operators.
    it('should safely deny compaction on malformed state without throwing', () => {
      const malformedState = {
        hookId: 'corrupt',
        lastExecutedAt: undefined,
        status: 'unknown',
      } as unknown as PIHookState;

      expect(() => safeguard.shouldAllowCompaction(malformedState)).not.toThrow();

      const decision = safeguard.shouldAllowCompaction(malformedState);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBeDefined();
    });
  });
});
```