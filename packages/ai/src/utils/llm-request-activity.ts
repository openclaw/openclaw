const requestActivityListeners = new WeakMap<AbortSignal, Set<() => void>>();

export function notifyLlmRequestActivity(signal: AbortSignal | undefined): void {
  if (!signal) {
    return;
  }
  for (const listener of requestActivityListeners.get(signal) ?? []) {
    listener();
  }
}

export function onLlmRequestActivity(signal: AbortSignal, listener: () => void): () => void {
  const listeners = requestActivityListeners.get(signal) ?? new Set<() => void>();
  listeners.add(listener);
  requestActivityListeners.set(signal, listeners);

  return () => {
    if (listeners.delete(listener) && listeners.size === 0) {
      requestActivityListeners.delete(signal);
    }
  };
}
