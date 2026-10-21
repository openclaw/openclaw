const requestActivityListeners = new WeakMap<AbortSignal, Set<(progress: boolean) => void>>();

export function notifyLlmRequestActivity(signal: AbortSignal | undefined, progress = true): void {
  if (!signal) {
    return;
  }
  for (const listener of requestActivityListeners.get(signal) ?? []) {
    listener(progress);
  }
}

export function onLlmRequestActivity(
  signal: AbortSignal,
  listener: (progress: boolean) => void,
): () => void {
  const listeners = requestActivityListeners.get(signal) ?? new Set<(progress: boolean) => void>();
  listeners.add(listener);
  requestActivityListeners.set(signal, listeners);

  return () => {
    if (listeners.delete(listener) && listeners.size === 0) {
      requestActivityListeners.delete(signal);
    }
  };
}
