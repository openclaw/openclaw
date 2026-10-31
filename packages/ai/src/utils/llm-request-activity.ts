type ActivityListener = (progress: boolean, progressTimeoutMs?: number) => void;
const requestActivityListeners = new WeakMap<AbortSignal, Set<ActivityListener>>();

export function notifyLlmRequestActivity(
  signal: AbortSignal | undefined,
  progress = true,
  progressTimeoutMs?: number,
): void {
  if (!signal) {
    return;
  }
  for (const listener of requestActivityListeners.get(signal) ?? []) {
    listener(progress, progressTimeoutMs);
  }
}

export function onLlmRequestActivity(signal: AbortSignal, listener: ActivityListener): () => void {
  const listeners = requestActivityListeners.get(signal) ?? new Set<ActivityListener>();
  listeners.add(listener);
  requestActivityListeners.set(signal, listeners);

  return () => {
    if (listeners.delete(listener) && listeners.size === 0) {
      requestActivityListeners.delete(signal);
    }
  };
}
