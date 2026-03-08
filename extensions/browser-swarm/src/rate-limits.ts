export type DomainLimitConfig = {
  maxConcurrentPerDomain: number;
  minIntervalMs: number;
};

type DomainState = {
  active: number;
  lastStartedAt: number;
};

export class BrowserDomainLimiter {
  private readonly states = new Map<string, DomainState>();

  constructor(
    private readonly config: DomainLimitConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  canStart(domain: string): { ok: boolean; reason?: string } {
    const state = this.states.get(domain) ?? { active: 0, lastStartedAt: 0 };
    if (state.active >= this.config.maxConcurrentPerDomain) {
      return { ok: false, reason: "max_concurrent_per_domain_exceeded" };
    }
    const elapsed = this.now() - state.lastStartedAt;
    if (state.lastStartedAt > 0 && elapsed < this.config.minIntervalMs) {
      return { ok: false, reason: "min_interval_not_elapsed" };
    }
    return { ok: true };
  }

  start(domain: string): void {
    const state = this.states.get(domain) ?? { active: 0, lastStartedAt: 0 };
    state.active += 1;
    state.lastStartedAt = this.now();
    this.states.set(domain, state);
  }

  finish(domain: string): void {
    const state = this.states.get(domain);
    if (!state) {
      return;
    }
    state.active = Math.max(0, state.active - 1);
    this.states.set(domain, state);
  }

  snapshot(): Record<string, { active: number; lastStartedAt: number }> {
    const result: Record<string, { active: number; lastStartedAt: number }> = {};
    for (const [domain, state] of this.states.entries()) {
      result[domain] = { active: state.active, lastStartedAt: state.lastStartedAt };
    }
    return result;
  }
}

