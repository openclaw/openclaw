import { summaryLink } from "./claim-view.js";
import type { Page } from "./page-context.js";
import { button, el, tile, type Detail, type RecordDetail } from "./page-dom.js";

/** A claim's About rail: the pages it names, up to 20. */
export function aboutLinks(
  ui: Page,
  result: Detail,
  r: RecordDetail,
  n: number,
  aside: HTMLElement,
  pending: Promise<unknown>[],
) {
  const { feature, live, failure } = ui;
  const meta = r.metadata;
  if (r.kind === "claim" && meta?.entities?.length) {
    const about = el("section", undefined, "knowledge-about"),
      targets = el("div", undefined, "knowledge-surface knowledge-connections");
    about.append(el("h3", "About"), targets);
    aside.prepend(about);
    const ids = [...new Set(meta.entities)].slice(0, 20);
    pending.push(
      Promise.all(
        ids.map(
          async (entityId) =>
            result.references?.find((ref) => ref.id === entityId) ??
            (await feature.invoke("record", { id: entityId, view: "summary" })).record,
        ),
      )
        .then((records) => {
          if (!live(n)) {
            return;
          }
          for (const record of records) {
            if (record) {
              const row = el("div", undefined, "knowledge-connection");
              row.append(summaryLink(ui, record));
              targets.append(row);
            }
          }
          if (!targets.children.length) {
            targets.append(el("p", "Linked records are unavailable.", "knowledge-aside-empty"));
          }
          if (meta.entities!.length > ids.length) {
            about.append(el("p", "Showing the first 20 linked entities.", "knowledge-muted"));
          }
        })
        .catch((error: unknown) => {
          if (live(n)) {
            targets.append(failure(error));
          }
        }),
    );
  }
}

/** A relationship's From and To endpoints, resolved to page links as they load. */
export function relationshipEndpoints(
  ui: Page,
  result: Detail,
  r: RecordDetail,
  n: number,
  refs: HTMLElement,
  pending: Promise<unknown>[],
) {
  const { feature, live, failure, open } = ui;
  const meta = r.metadata;
  if (r.kind === "relationship") {
    for (const [role, endpointId] of [
      ["From", meta?.from],
      ["To", meta?.to],
    ] as const) {
      const row = el("div", undefined, "knowledge-connection"),
        copy = el("span", undefined, "knowledge-connection-copy");
      copy.append(el("small", role), el("span", endpointId ? "Loading…" : "Page not recorded."));
      row.append(copy);
      refs.append(row);
      if (!endpointId) {
        continue;
      }
      pending.push(
        (async () => {
          const target =
            result.references?.find((ref) => ref.id === endpointId) ??
            (await feature.invoke("record", { id: endpointId, view: "summary" })).record;
          if (!live(n)) {
            return;
          }
          copy.replaceChildren(el("small", role), el("span", target?.title ?? "Page unavailable."));
          if (target) {
            const destination = button("", () => open(target.id), "knowledge-connection-link");
            destination.append(tile(target.type, 24, target.kind), copy);
            row.replaceChildren(destination);
          }
        })().catch((error: unknown) => {
          if (live(n)) {
            copy.replaceChildren(el("small", role), el("span", "Page unavailable."));
            row.append(failure(error));
          }
        }),
      );
    }
  }
}
