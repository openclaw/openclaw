type LlmRequestActivityListener = (modelProgress: boolean) => void;

const requestActivityListeners = new WeakMap<AbortSignal, Set<LlmRequestActivityListener>>();

export function notifyLlmRequestActivity(
  signal: AbortSignal | undefined,
  modelProgress = true,
): void {
  if (!signal) {
    return;
  }
  for (const listener of requestActivityListeners.get(signal) ?? []) {
    listener(modelProgress);
  }
}

export function onLlmRequestActivity(
  signal: AbortSignal,
  listener: LlmRequestActivityListener,
): () => void {
  const listeners = requestActivityListeners.get(signal) ?? new Set<LlmRequestActivityListener>();
  listeners.add(listener);
  requestActivityListeners.set(signal, listeners);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      requestActivityListeners.delete(signal);
    }
  };
}
