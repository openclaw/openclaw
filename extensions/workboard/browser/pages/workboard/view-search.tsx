/** @jsxImportSource @solidjs/web */
import { onSettled } from "solid-js";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import { getWorkboardState } from "../../lib/workboard/index.ts";
import type { WorkboardProps } from "./view-helpers.tsx";

export function WorkboardSearch(props: { workboard: WorkboardProps }) {
  const state = () => {
    void props.workboard.revision;
    return getWorkboardState(props.workboard.host);
  };
  let pendingFocus: { target: "input" | "trigger"; previous: Element | null } | undefined;
  const focusMounted = (target: "input" | "trigger", element: HTMLElement) => {
    if (pendingFocus?.target !== target) {
      return;
    }
    const previous = pendingFocus.previous;
    pendingFocus = undefined;
    const active = element.ownerDocument.activeElement;
    if (
      element.isConnected &&
      (active === previous ||
        (previous && !previous.isConnected && active === element.ownerDocument.body))
    ) {
      element.focus();
    }
  };
  const close = (restoreFocus: boolean) => {
    pendingFocus = restoreFocus
      ? { target: "trigger", previous: document.activeElement }
      : undefined;
    state().query = "";
    state().searchOpen = false;
    props.workboard.onRequestUpdate?.();
  };
  function SearchField() {
    let input!: HTMLInputElement;
    onSettled(() => focusMounted("input", input));
    return (
      <div class="workboard-search">
        <span aria-hidden="true">{icons.search}</span>
        <input
          ref={(element) => {
            input = element;
          }}
          class="settings-input"
          id="workboard-search-input"
          type="search"
          aria-label={t("workboard.searchPlaceholder")}
          placeholder={t("workboard.searchPlaceholder")}
          value={state().query}
          onInput={(event) => {
            state().query = event.currentTarget.value;
            props.workboard.onRequestUpdate?.();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            close(true);
          }}
        />
        <button
          class="btn btn--icon workboard-search__clear"
          type="button"
          aria-label={t("workboard.closeSearch")}
          onClick={(event) => close(event.detail === 0)}
        >
          {icons.x}
        </button>
      </div>
    );
  }
  function SearchTrigger() {
    let trigger!: HTMLButtonElement;
    onSettled(() => focusMounted("trigger", trigger));
    return (
      <button
        ref={(element) => {
          trigger = element;
        }}
        class="btn btn--icon workboard-search-trigger"
        type="button"
        aria-label={t("workboard.searchPlaceholder")}
        title={t("workboard.searchPlaceholder")}
        aria-expanded="false"
        aria-controls="workboard-search-input"
        onClick={() => {
          pendingFocus = { target: "input", previous: document.activeElement };
          state().searchOpen = true;
          props.workboard.onRequestUpdate?.();
        }}
      >
        {icons.search}
      </button>
    );
  }
  return (
    <div class="workboard-search-control">
      {state().searchOpen || state().query ? <SearchField /> : <SearchTrigger />}
    </div>
  );
}
