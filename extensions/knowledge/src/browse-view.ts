import type { FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import { claimCard, summaryLink } from "./claim-view.js";
import type { contract } from "./contract.js";
import { assertionOrigin as origin, confidenceView } from "./knowledge-presentation.js";
import { loadingPlaceholder } from "./loading-view.js";
import type { Page } from "./page-context.js";
import {
  button,
  clock,
  date,
  dayHeading,
  el,
  human,
  label,
  tile,
  type Summary,
} from "./page-dom.js";
import { loadingLabel } from "./page-state.js";
import { formatSourceDate } from "./temporal.js";

// Facet headings for ontology primitives; unknown primitives fall back to a humanized name.
const PRIMITIVE_LABELS: Record<string, string> = {
  entity: "People & things",
  concept: "Ideas & projects",
  media: "Sources & writing",
  temporal: "Events & conversations",
  annotation: "Annotations",
};
// Plural facet labels for built-in page types; other types keep their own label.
const TYPE_LABELS: Record<string, string> = {
  Person: "People",
  Company: "Companies",
  Project: "Projects",
  Concept: "Concepts",
  Meeting: "Meetings",
  Note: "Notes",
  Source: "Sources",
};
// Pages arrive newest-updated first, so rows group under day headings and show only the
// time of day; the full timestamp stays in each time's tooltip.
function pageTable(ui: Page, records: Summary[]) {
  const table = el("table", undefined, "data-table knowledge-table"),
    head = el("thead"),
    headRow = el("tr");
  for (const name of ["Name", "Type", "Occurred", "Last updated"]) {
    const th = el("th", name);
    if (name === "Last updated") {
      th.setAttribute("aria-sort", "descending");
      th.append(el("span", " ↓", "knowledge-sort-indicator"));
    }
    headRow.append(th);
  }
  head.append(headRow);
  table.append(head);
  const body = el("tbody");
  let currentDay: string | undefined;
  for (const record of records) {
    // A heading row starts whenever the update day changes.
    const day = record.updatedAt ? dayHeading(record.updatedAt) : "Time not recorded";
    if (day !== currentDay) {
      currentDay = day;
      const dayRow = el("tr", undefined, "knowledge-day-row"),
        cell = el("th", day);
      cell.colSpan = 4;
      cell.scope = "colgroup";
      dayRow.append(cell);
      body.append(dayRow);
    }
    // Empty occurrence cells stay blank so the few dated records stand out.
    const row = el("tr", undefined, "knowledge-page-row"),
      name = el("td", undefined, "knowledge-name-cell"),
      occurred = el("td", undefined, "knowledge-occurred-cell"),
      updated = el("td", undefined, "knowledge-updated-cell");
    name.append(summaryLink(ui, record));
    if (record.occurredAt) {
      occurred.textContent = `${formatSourceDate(record.occurredAt)}${/^\d{4}-\d{2}-\d{2}$/.test(record.occurredAt) ? " · date only" : ""}`;
    }
    if (record.updatedAt) {
      updated.textContent = clock(record.updatedAt);
      updated.title = date(record.updatedAt);
    }
    row.append(name, el("td", label(record.type), "knowledge-type-cell"), occurred, updated);
    body.append(row);
  }
  table.append(body);
  return table;
}
/** Load one Browse page for the current kind, type and filters. */
export async function browse(ui: Page, n: number, target: HTMLElement) {
  const { s, feature, live } = ui;
  const result = await feature.invoke("records", {
    kind: s.kind,
    offset: s.offset,
    limit: s.kind === "claim" ? 20 : 50,
    includeCards: s.kind === "claim",
    includeEndpoints: s.kind === "relationship",
    ...(s.type ? { type: s.type } : {}),
    ...(s.browseQuery ? { query: s.browseQuery } : {}),
    ...(s.includeHistory ? { lifecycle: "all" } : {}),
    ...(s.originFilter && s.kind === "claim" ? { assertionOrigin: s.originFilter } : {}),
  });
  if (!live(n) || n !== s.generation) {
    return;
  }
  renderBrowse(ui, n, target, result);
}
// Build the destination frame before data arrives; no placeholder totals are fabricated.
export function renderBrowse(
  ui: Page,
  n: number,
  target: HTMLElement,
  result?: FeatureOutput<typeof contract, "records">,
) {
  const { s, empty, open, load } = ui;
  const layout = el("div", undefined, "knowledge-browse"),
    facets = el("nav", undefined, "knowledge-facets");
  facets.setAttribute("aria-label", "Types");
  layout.dataset.kind = s.kind;
  const facet = (name: string, text: string, count?: number) => {
    const control = button(
      text,
      () => {
        s.type = name;
        s.offset = 0;
        void load();
      },
      "knowledge-facet",
    );
    control.dataset.facet = name;
    control.prepend(name ? tile(name, 20) : el("span", undefined, "knowledge-facet-spacer"));
    control.setAttribute("aria-pressed", String(s.type === name));
    if (count !== undefined) {
      control.append(el("span", count.toLocaleString(), "knowledge-facet-count"));
    }
    facets.append(control);
  };
  facet(
    "",
    s.kind === "claim" ? "All claims" : "Everything",
    s.kind === "page" && s.vocabulary
      ? s.vocabulary.definitions.reduce((sum, d) => sum + d.recordCount, 0)
      : !s.type
        ? result?.total
        : undefined,
  );
  if (s.kind === "page" && s.vocabulary) {
    let group = "";
    for (const def of [...s.vocabulary.definitions]
      .filter((d) => d.recordCount > 0)
      .toSorted(
        (a, b) =>
          ["entity", "concept", "media", "temporal", "annotation"].indexOf(a.primitive) -
          ["entity", "concept", "media", "temporal", "annotation"].indexOf(b.primitive),
      )) {
      if (group !== def.primitive) {
        group = def.primitive;
        facets.append(el("h3", PRIMITIVE_LABELS[group] ?? human(group), "knowledge-eyebrow"));
      }
      facet(def.name, TYPE_LABELS[def.label] ?? def.label, def.recordCount);
    }
    facets.append(
      el(
        "p",
        `${s.vocabulary.definitions.filter((d) => !d.recordCount).length} empty types hidden`,
        "knowledge-muted",
      ),
    );
  }
  if (s.kind === "claim" && result?.facets) {
    facets.prepend(el("h3", "Claim kinds", "knowledge-eyebrow"));
    for (const [name, count] of Object.entries(result.facets.kinds)) {
      if (count > 0) {
        facet(name, label(name), count);
      }
    }
    const origins = Object.entries(result.facets.origins);
    facets.append(
      el(
        "p",
        `${origins.length === 1 && origins[0]![0] === "source" ? `All ${origins[0]![1]} claims are from sources.` : origins.map(([name, count]) => `${count} ${origin(name)}`).join(" · ")} Kinds with no claims are hidden.`,
        "knowledge-muted",
      ),
    );
  }
  if ((s.kind === "page" && !s.vocabulary) || (s.kind === "claim" && !result)) {
    facets.append(loadingPlaceholder("rows", "Loading types…", 4));
  }
  const panel = el("div", undefined, "knowledge-surface knowledge-table-wrap"),
    controls = el("div", undefined, "knowledge-table-toolbar");
  const filter = el("form", undefined, "knowledge-browse-filter"),
    input = el("input");
  input.type = "search";
  input.placeholder = s.kind === "claim" ? "Filter claim text" : "Filter by name or alias";
  input.setAttribute("aria-label", input.placeholder);
  input.value = s.browseQuery;
  filter.append(input);
  filter.addEventListener("submit", (event) => {
    event.preventDefault();
    s.browseQuery = input.value.trim();
    s.offset = 0;
    void load();
  });
  input.addEventListener("change", () => {
    s.browseQuery = input.value.trim();
    s.offset = 0;
    void load();
  });
  controls.append(filter);
  const kinds = el("div", undefined, "knowledge-kind-switch");
  kinds.setAttribute("role", "group");
  kinds.setAttribute("aria-label", "Record kind");
  for (const [value, text] of [
    ["page", "Pages"],
    ["claim", "Claims"],
    ["relationship", "Connections"],
  ] as const) {
    const b = button(
      text,
      () => {
        s.kind = value;
        s.type = "";
        s.offset = 0;
        void load();
      },
      "knowledge-quiet",
    );
    b.setAttribute("aria-pressed", String(s.kind === value));
    kinds.append(b);
  }
  controls.append(kinds);
  const history = el("div", undefined, "knowledge-kind-switch");
  for (const [all, name] of [
    [false, "Current"],
    [true, "Include history"],
  ] as const) {
    const b = button(
      name,
      () => {
        s.includeHistory = all;
        s.offset = 0;
        void load();
      },
      "knowledge-quiet",
    );
    b.setAttribute("aria-pressed", String(s.includeHistory === all));
    history.append(b);
  }
  controls.append(history);
  if (s.kind === "claim" && result?.facets && Object.keys(result.facets.origins).length > 1) {
    const select = el("select");
    select.setAttribute("aria-label", "Assertion origin");
    for (const value of ["", ...Object.keys(result.facets.origins)]) {
      const option = el("option", value ? origin(value) : "All origins");
      option.value = value;
      select.append(option);
    }
    select.value = s.originFilter;
    select.addEventListener("change", () => {
      s.originFilter = select.value;
      s.offset = 0;
      void load();
    });
    controls.append(select);
  }
  const paneStatus = el("div", "", "knowledge-pane-status");
  paneStatus.setAttribute("role", "status");
  paneStatus.setAttribute("aria-live", "polite");
  const data = el("div", undefined, "knowledge-browse-data");
  panel.append(controls, paneStatus, data);
  // Vocabulary presentation changes replace facets; selection/count updates keep focus.
  facets.dataset.signature = JSON.stringify([
    Boolean(s.kind === "page" ? s.vocabulary : result),
    s.kind === "page"
      ? s.vocabulary?.definitions.map((def) => [def.name, def.label, def.primitive])
      : undefined,
    ...[...facets.querySelectorAll<HTMLElement>("[data-facet]")].map((node) => node.dataset.facet),
  ]);
  if (!result) {
    if (s.kind === "page") {
      data.append(pageTable(ui, []));
    }
    const placeholder = loadingPlaceholder(s.kind === "claim" ? "cards" : "rows", loadingLabel(s));
    placeholder.querySelector("p")?.remove();
    data.append(placeholder);
    const results = el("div", undefined, "knowledge-browse-results");
    results.append(panel);
    layout.append(facets, results);
    target.replaceChildren(layout);
    return;
  }
  if (s.kind === "claim") {
    for (const record of result.records) {
      if (record.lifecycle !== "active") {
        const row = el("div", undefined, "knowledge-historical knowledge-connection");
        row.append(
          summaryLink(ui, record),
          el(
            "small",
            `${record.lifecycle === "withdrawn" ? "Withdrawn" : "Replaced"} · ${record.updatedAt ? date(record.updatedAt) : "Time not recorded"}`,
          ),
        );
        data.append(row);
      } else {
        const card = claimCard(ui, record, n);
        data.append(card ?? summaryLink(ui, record));
      }
    }
  } else if (s.kind === "relationship") {
    const endpoints = new Map((result.endpoints ?? []).map((record) => [record.id, record]));
    for (const record of result.records) {
      const row = el("div", undefined, "knowledge-connection knowledge-browse-connection");
      for (const [i, id] of [record.from, record.to].entries()) {
        if (i) {
          row.append(el("span", label(record.label ?? record.type)));
        }
        const endpoint = id ? endpoints.get(id) : undefined;
        row.append(endpoint ? summaryLink(ui, endpoint) : el("span", "Page unavailable"));
      }
      row.append(
        record.lifecycle === "active"
          ? confidenceView(record.attributionConfidence, true)
          : button(
              `Withdrawn · ${record.updatedAt ? date(record.updatedAt) : "Time not recorded"}`,
              () => open(record.id),
              "knowledge-quiet",
            ),
      );
      data.append(row);
    }
  } else {
    data.append(pageTable(ui, result.records));
  }
  if (!result.records.length) {
    data.append(
      empty("Nothing here yet", "Tell your agent in chat and saved knowledge will appear here."),
    );
  }
  const pages = el("div", undefined, "knowledge-pagination");
  const capped = result.nextOffset !== null && result.nextOffset > 500;
  pages.append(
    el(
      "span",
      `${result.total ? s.offset + 1 : 0}–${s.offset + result.records.length} of ${result.total.toLocaleString()} · ${result.total > 550 ? "partial browse access" : `complete list${s.includeHistory ? " · including history" : ""}`}`,
    ),
  );
  const previousOffset = s.browseBack.findLast((seen) => seen < s.offset);
  const previous = button(previousOffset === undefined && s.offset ? "First" : "Previous", () => {
    s.offset = previousOffset ?? 0;
    s.browseBack = s.browseBack.filter((seen) => seen < s.offset);
    void load();
  });
  previous.disabled = !s.offset;
  const next = button("Next", () => {
    s.browseBack = [...s.browseBack.filter((seen) => seen < s.offset), s.offset];
    s.offset = result.nextOffset!;
    void load();
  });
  next.disabled = result.nextOffset === null || capped;
  pages.append(previous, next);
  data.append(pages);
  if (capped) {
    data.append(
      el(
        "p",
        "This server cannot page beyond 550 records. Narrow the type filter to see more.",
        "knowledge-notice",
      ),
    );
  }
  const results = el("div", undefined, "knowledge-browse-results");
  results.append(panel);
  layout.append(facets, results);
  target.replaceChildren(layout);
}
