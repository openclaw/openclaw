import type { ControlUiView } from "openclaw/plugin-sdk/control-ui";

/** A mounted slot owns its import; late completion cannot revive a retired view. */
export function lazyView<T>(load: () => Promise<{ default: ControlUiView<T> }>): ControlUiView<T> {
  return (container, initial) => {
    let current = initial;
    let active = true;
    let view: ReturnType<ControlUiView<T>>;
    void load()
      .then(({ default: mount }) => {
        if (active && !current.signal.aborted) {
          view = mount(container, current);
        }
      })
      .catch((error: unknown) => {
        if (active && !current.signal.aborted) {
          current.reportError?.(error);
        }
      });
    return {
      update(next) {
        current = next;
        view?.update?.(next);
      },
      focus() {
        view?.focus?.();
      },
      dispose() {
        active = false;
        view?.dispose?.();
      },
    };
  };
}
