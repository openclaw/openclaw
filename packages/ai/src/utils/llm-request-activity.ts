export type LlmRequestActivityKind = "model-progress" | "transport-liveness";

const requestActivityListeners = new WeakMap<
  AbortSignal,
  Set<(kind: LlmRequestActivityKind) => void>
>();

export function notifyLlmRequestActivity(
  signal: AbortSignal | undefined,
  kind: LlmRequestActivityKind = "model-progress",
): void {
  if (!signal) {
    return;
  }
  for (const listener of requestActivityListeners.get(signal) ?? []) {
    listener(kind);
  }
}

export function onLlmRequestActivity(
  signal: AbortSignal,
  listener: (kind: LlmRequestActivityKind) => void,
): () => void {
  const listeners = requestActivityListeners.get(signal) ?? new Set();
  listeners.add(listener);
  requestActivityListeners.set(signal, listeners);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      requestActivityListeners.delete(signal);
    }
  };
}
