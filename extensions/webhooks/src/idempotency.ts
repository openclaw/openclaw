export type WebhookIdempotencyStore = {
  registerIfAbsent: (
    key: string,
    value: {
      routeId: string;
      idempotencyKey: string;
      firstSeenAt: number;
    },
    opts?: { ttlMs?: number },
  ) => Promise<boolean>;
};

type IdempotencyRecord = {
  expiresAt: number;
};

export function createInMemoryIdempotencyRecords(): Map<string, IdempotencyRecord> {
  return new Map<string, IdempotencyRecord>();
}

function pruneExpiredIdempotencyRecords(
  records: Map<string, IdempotencyRecord>,
  nowMs: number,
): void {
  for (const [key, record] of records) {
    if (record.expiresAt <= nowMs) {
      records.delete(key);
    }
  }
}

function checkAndStoreIdempotencyKey(params: {
  records: Map<string, IdempotencyRecord>;
  routeId: string;
  key: string | undefined;
  ttlMs: number;
  nowMs: number;
}): { duplicate: boolean } {
  const key = params.key?.trim();
  if (!key) {
    return { duplicate: false };
  }
  pruneExpiredIdempotencyRecords(params.records, params.nowMs);
  const storageKey = `${params.routeId}:${key}`;
  const existing = params.records.get(storageKey);
  if (existing && existing.expiresAt > params.nowMs) {
    return { duplicate: true };
  }
  params.records.set(storageKey, {
    expiresAt: params.nowMs + params.ttlMs,
  });
  return { duplicate: false };
}

export async function checkAndStoreDurableIdempotencyKey(params: {
  store: WebhookIdempotencyStore | undefined;
  records: Map<string, IdempotencyRecord>;
  routeId: string;
  key: string | undefined;
  ttlMs: number;
  nowMs: number;
}): Promise<{ duplicate: boolean }> {
  const key = params.key?.trim();
  if (!key) {
    return { duplicate: false };
  }
  const storageKey = `${params.routeId}:${key}`;
  pruneExpiredIdempotencyRecords(params.records, params.nowMs);
  const existing = params.records.get(storageKey);
  if (existing && existing.expiresAt > params.nowMs) {
    return { duplicate: true };
  }
  if (params.store) {
    try {
      const inserted = await params.store.registerIfAbsent(
        storageKey,
        {
          routeId: params.routeId,
          idempotencyKey: key,
          firstSeenAt: params.nowMs,
        },
        { ttlMs: params.ttlMs },
      );
      if (!inserted) {
        return { duplicate: true };
      }
    } catch {
      return checkAndStoreIdempotencyKey(params);
    }
  }
  params.records.set(storageKey, {
    expiresAt: params.nowMs + params.ttlMs,
  });
  return { duplicate: false };
}
