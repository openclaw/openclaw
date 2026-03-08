export type BrowserSession = {
  id: string;
  workerId: string;
  profile: string;
  inUse: boolean;
  lastUsedAt: number;
  labels?: Record<string, string>;
};

export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSession>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  register(input: { id: string; workerId: string; profile: string; labels?: Record<string, string> }): BrowserSession {
    const current = this.now();
    const record: BrowserSession = {
      id: input.id,
      workerId: input.workerId,
      profile: input.profile,
      inUse: false,
      lastUsedAt: current,
      labels: input.labels,
    };
    this.sessions.set(record.id, record);
    return { ...record };
  }

  acquire(params: { workerId?: string; profile?: string }): BrowserSession | null {
    const available = [...this.sessions.values()].filter((s) => {
      if (s.inUse) {
        return false;
      }
      if (params.workerId && s.workerId !== params.workerId) {
        return false;
      }
      if (params.profile && s.profile !== params.profile) {
        return false;
      }
      return true;
    });
    if (available.length === 0) {
      return null;
    }
    available.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const selected = available[0];
    selected.inUse = true;
    selected.lastUsedAt = this.now();
    this.sessions.set(selected.id, selected);
    return { ...selected };
  }

  release(sessionId: string): BrowserSession | null {
    const value = this.sessions.get(sessionId);
    if (!value) {
      return null;
    }
    value.inUse = false;
    value.lastUsedAt = this.now();
    this.sessions.set(sessionId, value);
    return { ...value };
  }

  list(): BrowserSession[] {
    return [...this.sessions.values()].map((s) => ({ ...s }));
  }
}

