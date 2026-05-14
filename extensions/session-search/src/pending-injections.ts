type PendingSessionSearchInjection = {
  chunks: string[];
  expiresAt: number;
};

const pendingInjections = new Map<string, PendingSessionSearchInjection>();

export function queueSessionSearchInjection(params: {
  sessionKey: string;
  chunks: string[];
  ttlMs: number;
  now?: number;
}): boolean {
  const sessionKey = params.sessionKey.trim();
  const chunks = params.chunks.map((chunk) => chunk.trim()).filter(Boolean);
  if (!sessionKey || chunks.length === 0) {
    return false;
  }
  pendingInjections.set(sessionKey, {
    chunks,
    expiresAt: (params.now ?? Date.now()) + params.ttlMs,
  });
  return true;
}

export function drainSessionSearchInjection(params: {
  sessionKey?: string;
  now?: number;
}): string | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const pending = pendingInjections.get(sessionKey);
  if (!pending) {
    return undefined;
  }
  pendingInjections.delete(sessionKey);
  if (pending.expiresAt <= (params.now ?? Date.now())) {
    return undefined;
  }
  return pending.chunks.join("\n\n");
}

export function clearSessionSearchInjection(params: { sessionKey?: string }): void {
  const sessionKey = params.sessionKey?.trim();
  if (sessionKey) {
    pendingInjections.delete(sessionKey);
  }
}

export function clearPendingSessionSearchInjectionsForTest(): void {
  pendingInjections.clear();
}
