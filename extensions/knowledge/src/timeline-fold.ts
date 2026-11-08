/** Rendered notes keep this many Timeline entries open; older ones fold by month. */
const RECENT_TIMELINE_ENTRIES = 5;

// A leading bold date such as **2026-09-01** or **2026-09-01 09:00 PDT — Standup:**.
const entryDate = (item: Element) =>
  /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(
    item
      .querySelector(":scope > strong:first-child, :scope > p:first-child > strong:first-child")
      ?.textContent?.trim() ?? "",
  );

// Month heading for a folded group, in the reader's locale.
const monthLabel = (year: string, month: string) =>
  new Date(Number(year), Number(month) - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

/**
 * Fold a long `Timeline` section of rendered notes: the newest entries stay visible and
 * older ones collapse into one disclosure per month. Entries are ordered by their leading
 * date when every entry has one; otherwise authored order is kept and older entries fold
 * into a single group. Content is moved, never rewritten.
 */
export function foldTimeline(root: HTMLElement) {
  for (const heading of root.querySelectorAll("h2")) {
    if (heading.textContent?.trim().toLowerCase() !== "timeline") {
      continue;
    }
    // The section's entries are the list items of its lists, up to the next h2.
    const lists: HTMLUListElement[] = [];
    for (
      let node = heading.nextElementSibling;
      node && node.tagName !== "H2";
      node = node.nextElementSibling
    ) {
      if (node.tagName === "UL") {
        // SAFETY: an element whose tagName is "UL" is an HTML ul element.
        lists.push(node as HTMLUListElement);
      }
    }
    const items = lists.flatMap((list) => [...list.children]);
    if (items.length <= RECENT_TIMELINE_ENTRIES + 2) {
      continue;
    }
    // Sort newest first only when every entry is dated; the sort is stable for equal dates.
    const dates = items.map(entryDate);
    const dated = dates.every(Boolean);
    const order = items.map((item, index) => ({ item, date: dates[index] }));
    if (dated) {
      order.sort((a, b) =>
        [b.date![1], b.date![2], b.date![3] ?? "00"]
          .join("")
          .localeCompare([a.date![1], a.date![2], a.date![3] ?? "00"].join("")),
      );
    }
    // Recent entries stay in the first list; the remaining lists are replaced by month groups.
    const [first, ...rest] = lists;
    for (const list of rest) {
      list.remove();
    }
    first!.replaceChildren(...order.slice(0, RECENT_TIMELINE_ENTRIES).map((entry) => entry.item));
    let anchor: Element = first!,
      group: HTMLUListElement | undefined,
      groupKey = "";
    for (const { item, date } of order.slice(RECENT_TIMELINE_ENTRIES)) {
      const key = dated ? `${date![1]}-${date![2]}` : "earlier";
      if (key !== groupKey || !group) {
        groupKey = key;
        const details = document.createElement("details"),
          summary = document.createElement("summary");
        details.className = "knowledge-timeline-group";
        group = document.createElement("ul");
        details.append(summary, group);
        anchor.after(details);
        anchor = details;
      }
      group.append(item);
    }
    // Counts are known only after grouping, so label each summary last.
    for (const details of root.querySelectorAll<HTMLDetailsElement>(".knowledge-timeline-group")) {
      const list = details.querySelector("ul")!,
        sample = list.firstElementChild!,
        date = entryDate(sample),
        count = list.children.length;
      details.querySelector("summary")!.textContent =
        `${dated && date ? monthLabel(date[1]!, date[2]!) : "Earlier"} · ${count} ${count === 1 ? "entry" : "entries"}`;
    }
  }
  return root;
}
