type IdempotencyRecord = {
  key: string;
  jobId: string;
  createdAt: number;
  expiresAt?: number;
};

export class InMemoryIdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  get(key: string): IdempotencyRecord | null {
    this.gc();
    return this.records.get(key) ?? null;
  }

  reserve(params: { key: string; jobId: string; ttlMs?: number }): IdempotencyRecord {
    this.gc();
    const existing = this.records.get(params.key);
    if (existing) {
      return existing;
    }
    const createdAt = this.now();
    const record: IdempotencyRecord = {
      key: params.key,
      jobId: params.jobId,
      createdAt,
      expiresAt: params.ttlMs ? createdAt + Math.max(1, params.ttlMs) : undefined,
    };
    this.records.set(params.key, record);
    return record;
  }

  release(key: string): boolean {
    return this.records.delete(key);
  }

  gc(): void {
    const now = this.now();
    for (const [key, value] of this.records.entries()) {
      if (value.expiresAt !== undefined && value.expiresAt <= now) {
        this.records.delete(key);
      }
    }
  }
}

