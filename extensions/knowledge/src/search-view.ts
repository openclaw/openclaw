import { summaryLink } from "./claim-view.js";
import { t } from "./i18n/index.js";
import { identityTag } from "./knowledge-presentation.js";
import type { Page } from "./page-context.js";
import { button, el, tile } from "./page-dom.js";
import { isFullHit } from "./retrieval-hit.js";
import { temporalQuery, temporalSelectionError } from "./search-date-filters.js";
import { icon } from "./ui-icons.js";

/** Search box with exact-name suggestions; submitting runs ranked text search. */
export function searchForm(ui: Page, compact = false) {
  const { s, feature, searchPlaceholder, open, load, renderToolbar } = ui;
  const form = el("form", undefined, "knowledge-search"),
    input = el("input"),
    suggestions = el("div", undefined, "knowledge-suggestions");
  if (compact) {
    form.classList.add("knowledge-search-compact");
  }
  input.type = "search";
  input.maxLength = 200;
  input.placeholder = searchPlaceholder();
  input.value = s.query;
  input.setAttribute("aria-label", t("knowledge.search.label"));
  if (compact) {
    input.placeholder = t("knowledge.search.compactPlaceholder");
  }
  const submit = el("button", undefined, "knowledge-search-submit");
  submit.type = "submit";
  submit.setAttribute("aria-label", t("knowledge.search.allText"));
  submit.title = t("knowledge.search.allText");
  submit.append(s.query ? icon("cornerDownLeft", 14) : el("kbd", "/"));
  const searchIcon = el("span", undefined, "knowledge-search-icon");
  searchIcon.append(icon("search", compact ? 14 : 16));
  form.append(searchIcon, input, submit, suggestions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    s.query = input.value.trim();
    s.offset = 0;
    s.browseBack = [];
    s.searchSnapshot = undefined;
    s.tab = "search";
    suggestions.replaceChildren();
    renderToolbar();
    void load();
  });
  input.addEventListener("input", () => {
    s.query = input.value;
    submit.replaceChildren(s.query ? icon("cornerDownLeft", 14) : el("kbd", "/"));
    const token = ++s.suggestGeneration;
    clearTimeout(s.timer);
    suggestions.replaceChildren();
    if (!s.query.trim()) {
      return;
    }
    // Exact identity lookup is supported today. Do not present it as prefix search.
    s.timer = setTimeout(() => {
      void feature
        .invoke("lookup", { query: s.query.trim(), limit: 10 })
        .then((result) => {
          if (
            s.disposed ||
            token !== s.suggestGeneration ||
            !s.context.host.connection.connected ||
            !form.isConnected
          ) {
            return;
          }
          suggestions.replaceChildren();
          suggestions.append(el("small", t("knowledge.search.exactMatches")));
          const hits = result.hits.filter(isFullHit);
          if (!hits.length) {
            suggestions.append(el("p", t("knowledge.search.noExactMatch", { query: s.query })));
          }
          for (const hit of hits) {
            const item = button(
              hit.record.title,
              () => open(hit.record.id),
              "knowledge-suggestion",
            );
            item.prepend(tile(hit.record.type, 24, hit.record.kind));
            item.append(identityTag(hit.record.identityStatus));
            suggestions.append(item);
          }
          suggestions.append(
            button(
              t("knowledge.search.allTextFor", { query: s.query }),
              () => form.requestSubmit(),
              "knowledge-suggestion",
            ),
          );
        })
        .catch(() => {});
    }, 200);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      ++s.suggestGeneration;
      suggestions.replaceChildren();
    }
  });
  return form;
}

/** Ranked text-search results for the current query and date filters. */
export async function searchResults(ui: Page, n: number, target: HTMLElement) {
  const { s, feature, live, empty, load, writeLocation, temporalSelection } = ui;
  if (!s.query.trim()) {
    target.replaceChildren(empty(t("knowledge.search.label"), t("knowledge.search.emptyBody")));
    return;
  }
  const invalid = temporalSelectionError(temporalSelection());
  if (invalid) {
    target.replaceChildren(empty(t("knowledge.search.invalidDates"), invalid));
    return;
  }
  const result = await feature.invoke("grep", {
    query: s.query.trim(),
    limit: 20,
    offset: s.offset,
    ...temporalQuery(temporalSelection()),
  });
  if (!live(n)) {
    return;
  }
  if (result.index.state !== "ready") {
    target.replaceChildren(empty(t("knowledge.search.failed"), result.index.message));
    return;
  }
  if (s.offset && s.searchSnapshot && s.searchSnapshot !== result.index.snapshot) {
    s.offset = 0;
    s.searchSnapshot = undefined;
    writeLocation(true);
    target.replaceChildren(empty(t("knowledge.search.changed"), t("knowledge.search.changedBody")));
    return;
  }
  s.searchSnapshot = result.index.snapshot;
  const list = el("div", undefined, "knowledge-surface");
  list.append(
    el(
      "p",
      t(result.total === 1 ? "knowledge.search.totalOne" : "knowledge.search.total", {
        count: (result.total ?? 0).toLocaleString(),
      }),
      "knowledge-list-note",
    ),
  );
  if (!result.coverage.complete) {
    list.append(el("p", result.coverage.message, "knowledge-notice"));
  }
  for (const hit of result.hits.filter(isFullHit)) {
    const row = el("article", undefined, "knowledge-search-hit");
    row.append(
      summaryLink(ui, hit.record),
      el("p", hit.snippet.text),
      el(
        "small",
        t(
          hit.snippet.matchLocated === false
            ? "knowledge.search.hitOpeningExcerpt"
            : "knowledge.search.hitMeta",
          { revision: String(hit.citation.revision), path: hit.citation.path },
        ),
      ),
    );
    list.append(row);
  }
  if (!result.total) {
    list.append(empty(t("knowledge.search.noMatches"), t("knowledge.search.noMatchesBody")));
  }
  const pages = el("div", undefined, "knowledge-pagination");
  if (s.offset) {
    pages.append(
      button(t("knowledge.common.previous"), () => {
        s.offset = Math.max(0, s.offset - 20);
        void load();
      }),
    );
  }
  if (result.nextOffset !== null) {
    const next = button(t("knowledge.common.next"), () => {
      s.offset = result.nextOffset!;
      void load();
    });
    next.disabled = result.nextOffset > 500;
    pages.append(next);
    if (next.disabled) {
      list.append(el("p", t("knowledge.search.pageLimit"), "knowledge-notice"));
    }
  }
  list.append(pages);
  target.replaceChildren(list);
}
