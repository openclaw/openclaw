import { renderBrowse } from "./browse-view.js";
import { commitBrowse, loadingPlaceholder, syncBrowseControls } from "./loading-view.js";
import type { Page } from "./page-context.js";
import { button, el } from "./page-dom.js";
import { loadingLabel } from "./page-state.js";

// Views kept for returning to; older ones are dropped first.
const RETAINED_VIEWS = 4;

// Keep the committed view being left so returning to it shows its last rows while they refresh.
function retainView(ui: Page) {
  const { s, content } = ui;
  if (!s.viewReady || !s.displayView || !content.children.length) {
    return;
  }
  s.retainedViews.delete(s.displayView);
  s.retainedViews.set(s.displayView, [...content.childNodes]);
  for (const key of s.retainedViews.keys()) {
    if (s.retainedViews.size <= RETAINED_VIEWS) {
      break;
    }
    s.retainedViews.delete(key);
  }
}

/** Acknowledge a load in the destination pane while keeping readable content in place. */
export function prepareLoading(ui: Page, n: number) {
  const { s, content, loading, announce } = ui;
  const screen = JSON.stringify([s.tab, s.selectedId]);
  if (s.mountedScreen !== screen || !content.children.length) {
    retainView(ui);
    s.viewReady = false;
    s.mountedScreen = screen;
    // Only the exact view returns: same scope, tab, record, filters and page.
    const retained = s.retainedViews.get(ui.viewKey());
    s.retainedViews.delete(ui.viewKey());
    if (retained) {
      content.replaceChildren(...retained);
    } else if (!s.selectedId && s.tab === "browse") {
      renderBrowse(ui, n, content);
    } else {
      const placeholder = loadingPlaceholder(
        s.selectedId ? "detail" : s.tab === "recent" ? "feed" : "cards",
        loadingLabel(s),
      );
      placeholder.querySelector("p")?.remove();
      content.replaceChildren(placeholder);
    }
  }
  // Controls acknowledge the request immediately; retained rows cannot open stale records.
  const frame = content.querySelector<HTMLElement>(".knowledge-browse");
  if (!s.selectedId && s.tab === "browse" && frame) {
    const candidate = el("div");
    renderBrowse(ui, n, candidate);
    syncBrowseControls(
      frame.querySelector(".knowledge-table-toolbar")!,
      candidate.querySelector(".knowledge-table-toolbar")!,
      s.kind === "claim",
    );
    const facets = frame.querySelector<HTMLElement>(".knowledge-facets")!,
      nextFacets = candidate.querySelector<HTMLElement>(".knowledge-facets")!;
    if (
      frame.dataset.kind !== s.kind ||
      (facets.querySelector(".knowledge-placeholder") &&
        !nextFacets.querySelector(".knowledge-placeholder"))
    ) {
      facets.replaceChildren(...nextFacets.childNodes);
      facets.dataset.signature = nextFacets.dataset.signature;
      frame.dataset.kind = s.kind;
    }
    for (const control of facets.querySelectorAll<HTMLElement>("[data-facet]")) {
      control.setAttribute("aria-pressed", String(control.dataset.facet === s.type));
    }
    const originSelect = frame.querySelector<HTMLSelectElement>(".knowledge-table-toolbar select");
    if (originSelect) {
      originSelect.value = s.originFilter;
    }
    const data = frame.querySelector<HTMLElement>(".knowledge-browse-data")!;
    data.inert = true;
    data.setAttribute("aria-busy", "true");
    const note = frame.querySelector<HTMLElement>(".knowledge-pane-status")!;
    note.textContent =
      loadingLabel(s) +
      (data.querySelector(".knowledge-placeholder")
        ? ""
        : " Showing previous results until ready.");
    loading.hidden = true;
  } else {
    // Recent, Search and detail reloads have the same local data boundary.
    let data = content.querySelector<HTMLElement>(":scope > .knowledge-view-data");
    if (!data) {
      data = el("div", undefined, "knowledge-view-data");
      data.append(...content.childNodes);
      const note = el("div", "", "knowledge-pane-status");
      note.setAttribute("role", "status");
      note.setAttribute("aria-live", "polite");
      content.append(note, data);
    }
    data.inert = true;
    data.setAttribute("aria-busy", "true");
    content.querySelector(".knowledge-pane-status")!.textContent =
      loadingLabel(s) +
      (data.querySelector(".knowledge-placeholder")
        ? ""
        : " Showing previous results until ready.");
    loading.hidden = true;
  }
  announce(loadingLabel(s));
  content.setAttribute("aria-busy", "true");
}
// The Browse workspace stays mounted through data commits, including background checks.
export function commitContent(ui: Page, target: HTMLElement) {
  const { content } = ui;
  const current = content.querySelector<HTMLElement>(".knowledge-browse"),
    next = target.querySelector<HTMLElement>(".knowledge-browse");
  if (current && next) {
    commitBrowse(current, next);
    current.querySelector(".knowledge-pane-status")!.replaceChildren();
  } else {
    const data = content.querySelector<HTMLElement>(":scope > .knowledge-view-data");
    if (data && !next) {
      data.replaceChildren(...target.childNodes);
      data.inert = false;
      data.removeAttribute("aria-busy");
      content.querySelector(".knowledge-pane-status")!.replaceChildren();
    } else {
      content.replaceChildren(...target.childNodes);
    }
  }
}
// Terminal errors end loading without discarding a readable same-store snapshot.
export function showLoadingFailure(ui: Page, error: unknown, retry: () => void) {
  const { content, loading, failure } = ui;
  content.removeAttribute("aria-busy");
  content.querySelectorAll("[aria-busy]").forEach((node) => node.removeAttribute("aria-busy"));
  content
    .querySelectorAll(
      ".knowledge-browse-data > .knowledge-placeholder, .knowledge-view-data > .knowledge-placeholder, .knowledge-facets .knowledge-placeholder",
    )
    .forEach((node) => node.remove());
  const feedback = content.querySelector<HTMLElement>(".knowledge-pane-status") ?? loading;
  feedback.replaceChildren(failure(error), button("Retry", retry, "knowledge-quiet"));
  feedback.hidden = false;
}
