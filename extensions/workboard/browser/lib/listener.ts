type NativeEvents<T> = T extends Window
  ? WindowEventMap
  : T extends Document
    ? DocumentEventMap
    : T extends HTMLElement
      ? HTMLElementEventMap
      : T extends AbortSignal
        ? AbortSignalEventMap
        : Record<string, Event>;

/** Bind an external target and return its matching lifecycle teardown. */
export function listen<T extends EventTarget, K extends keyof NativeEvents<T> & string>(
  target: T,
  type: K,
  handler: (event: NativeEvents<T>[K]) => void,
  options?: boolean | AddEventListenerOptions,
) {
  // SAFETY: The native event map ties each event name to its target's event type.
  const listener = handler as EventListener;
  target.addEventListener(type, listener, options);
  return () => target.removeEventListener(type, listener, options);
}
