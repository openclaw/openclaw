import { createSignal, onSettled } from "solid-js";

/** Project synchronous owners without copying their state into the renderer. */
export function observeSource<T>(read: () => T, subscribe: (notify: () => void) => () => void) {
  const [revision, invalidate] = createSignal(0, { ownedWrite: true });
  onSettled(() => subscribe(() => invalidate((value) => value + 1)));
  return () => {
    revision();
    return read();
  };
}
