import { html, nothing, render } from "lit";
import type { ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { t } from "../../i18n/index.ts";

export function createLazyWorkboardPage(load: () => Promise<ControlUiView>): ControlUiView {
  return (container, initialContext) => {
    let context = initialContext;
    let mount: ControlUiView | undefined;
    let handle: ReturnType<ControlUiView>;
    let loading = false;
    let mounted = false;
    let disposed = false;
    let failure: { error: unknown } | undefined;
    let focusPending = false;
    const alive = () => !disposed && !context.signal.aborted;
    const focus = () => {
      if (handle?.focus) {
        handle.focus();
      } else {
        container.querySelector<HTMLElement>("textarea, input, [contenteditable=true]")?.focus();
      }
    };
    const update = () => {
      if (!alive()) {
        return;
      }
      if (failure) {
        throw failure.error;
      }
      if (mounted) {
        handle?.update?.(context);
      } else if (context.presented) {
        if (mount) {
          // Mount inside the host's synchronous update: its failure path aborts
          // partial views and supplies retry. Async completions never own a view.
          handle = mount(container, context);
          mounted = true;
          if (focusPending) {
            focus();
          }
        } else {
          render(html`<div role="status">${t("workboard.widget.loading")}</div>`, container);
          if (!loading) {
            loading = true;
            void load().then(
              (view) => {
                if (alive()) {
                  mount = view;
                  context.host.ui.invalidate();
                }
              },
              (error: unknown) => {
                if (alive()) {
                  // Browsers can retain failed module fetches across remounts.
                  // Keep the cause for diagnostics and name the document recovery.
                  failure = { error: new Error(t("workboard.pageLoadFailed"), { cause: error }) };
                  context.host.ui.invalidate();
                }
              },
            );
          }
        }
      }
    };
    update();
    return {
      update(next) {
        context = next;
        if (!context.presented) {
          focusPending = false;
        }
        update();
      },
      focus() {
        if (alive() && context.presented) {
          focusPending = true;
          if (mounted) {
            focus();
          }
        }
      },
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        handle?.dispose?.();
        render(nothing, container);
      },
    };
  };
}
