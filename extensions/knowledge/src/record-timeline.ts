import type { ChronicleOutput } from "./chronicle-contract.js";
import { loadingPlaceholder } from "./loading-view.js";
import { markdownView } from "./markdown-view.js";
import type { Page } from "./page-context.js";
import { button, el, tile } from "./page-dom.js";
import { formatSourceDate } from "./temporal.js";

const ROWS_PER_PAGE = 20;

/**
 * The record page's Timeline for an entity, derived from records rather than
 * page prose: one row per dated source with its note and the entity's claim
 * count. The section is placed immediately with a placeholder so loading rows
 * never shifts the content below it; it shows a short line when nothing is dated.
 */
export function recordTimeline(ui: Page, id: string, n: number, pending: Promise<unknown>[]) {
  const { feature, live, failure, open } = ui;
  const section = el("section", undefined, "knowledge-timeline"),
    rows = el("div", undefined, "knowledge-surface knowledge-timeline-rows"),
    loading = loadingPlaceholder("rows", "Loading timeline…", 3);
  section.append(el("h3", "Timeline"), loading);
  let offset = 0,
    snapshot: string | undefined;
  const more = button("Earlier", () => void page(), "knowledge-quiet");
  // Each page continues the first page's snapshot; a changed vault asks for a reopen.
  async function page() {
    more.disabled = true;
    try {
      const result = await feature.invoke("timeline", {
        entity: id,
        group: "source",
        offset,
        limit: ROWS_PER_PAGE,
        ...(snapshot ? { snapshot } : {}),
      });
      if (!live(n)) {
        return;
      }
      snapshot = result.snapshot;
      loading.remove();
      for (const item of result.items) {
        rows.append(timelineRow(item, open));
      }
      if (!rows.isConnected) {
        section.append(
          result.items.length
            ? rows
            : el("p", "No dated sources mention this page yet.", "knowledge-muted"),
        );
      }
      const count = rows.children.length;
      section
        .querySelector("h3")!
        .replaceChildren(
          document.createTextNode("Timeline "),
          el(
            "span",
            `${count} ${count === 1 ? "source" : "sources"}${result.nextOffset !== null ? " shown" : ""}`,
            "knowledge-section-count",
          ),
        );
      more.remove();
      if (result.nextOffset !== null) {
        offset = result.nextOffset;
        more.disabled = false;
        section.append(more);
      }
    } catch (error) {
      if (live(n)) {
        loading.remove();
        section.append(failure(error));
      }
    }
  }
  pending.push(page());
  return section;
}

type Item = ChronicleOutput["items"][number];

// One row: date, the source it came from, and what that source says about the entity.
function timelineRow(item: Item, open: (id: string) => void) {
  const row = el("div", undefined, "knowledge-timeline-row"),
    source = button("", () => open(item.record.id), "knowledge-connection-link"),
    copy = el("span", undefined, "knowledge-connection-copy");
  const meta = [formatSourceDate(item.date)];
  if (item.claims) {
    meta.push(`${item.claims} ${item.claims === 1 ? "claim" : "claims"}`);
  }
  copy.append(el("small", meta.join(" · ")), el("span", item.record.title));
  source.append(tile(item.record.type, 24, item.record.kind), copy);
  row.append(source);
  // Summaries are capped server-side, so drop an internal comment the cap cut open.
  const summary = item.summary.replace(/<!--[\s\S]*?(?:-->|$)/g, "").trim();
  if (summary && summary !== item.record.title) {
    const note = markdownView(
      summary,
      open,
      (item.links ?? []).map(({ href, id }) => ({ href, id, status: "resolved" as const })),
    );
    note.classList.add("knowledge-timeline-note");
    row.append(note);
  }
  return row;
}
