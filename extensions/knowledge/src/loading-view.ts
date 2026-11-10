/** Neutral placeholders and narrow DOM commits for Knowledge loading states. */
const node = (tag: string, className: string) => {
  const element = document.createElement(tag);
  element.className = className;
  return element;
};

/** Content-shaped, non-animated placeholders; the real status text stays accessible. */
export function loadingPlaceholder(
  shape: "rows" | "cards" | "detail" | "feed",
  label: string,
  count = shape === "rows" ? 7 : 3,
): HTMLElement {
  const root = node("div", "knowledge-placeholder knowledge-placeholder-" + shape);
  const status = node("p", "knowledge-muted");
  status.textContent = label;
  status.setAttribute("role", "status");
  root.append(status);
  const blocks = node("div", "knowledge-placeholder-blocks");
  blocks.setAttribute("aria-hidden", "true");
  // Stable block sizes reserve the destination layout without inventing content.
  for (let i = 0; i < count; i++) {
    const block = node("div", "knowledge-placeholder-block");
    for (let line = 0; line < (shape === "rows" ? 1 : 3); line++) {
      block.append(node("span", "knowledge-skeleton"));
    }
    blocks.append(block);
  }
  root.append(blocks);
  return root;
}

/** Update existing controls without replacing the focused input or its unsent text. */
export function syncBrowseControls(
  current: HTMLElement,
  next: HTMLElement,
  preserveOrigin = false,
): void {
  const oldControls = current.querySelectorAll<HTMLButtonElement>(".knowledge-kind-switch button");
  const nextControls = next.querySelectorAll<HTMLButtonElement>(".knowledge-kind-switch button");
  oldControls.forEach((control, i) =>
    control.setAttribute("aria-pressed", nextControls[i]?.getAttribute("aria-pressed") ?? "false"),
  );
  const input = current.querySelector<HTMLInputElement>("input"),
    nextInput = next.querySelector<HTMLInputElement>("input");
  if (input && nextInput) {
    input.placeholder = nextInput.placeholder;
    input.setAttribute("aria-label", nextInput.getAttribute("aria-label")!);
    if (document.activeElement !== input) {
      input.value = nextInput.value;
    }
  }
  // Origin options depend on the returned facets; preserve the select when unchanged.
  if (preserveOrigin) {
    return;
  }
  const select = current.querySelector("select"),
    nextSelect = next.querySelector("select");
  if (!nextSelect) {
    select?.remove();
  } else if (!select) {
    current.append(nextSelect);
  } else {
    if (
      [...select.options].map((o) => o.value).join(",") !==
      [...nextSelect.options].map((o) => o.value).join(",")
    ) {
      select.replaceChildren(...nextSelect.childNodes);
    }
    select.value = nextSelect.value;
  }
}

/** Preserve a Browse frame and its controls while committing only the changed data. */
export function commitBrowse(current: HTMLElement, next: HTMLElement): void {
  syncBrowseControls(
    current.querySelector(".knowledge-table-toolbar")!,
    next.querySelector(".knowledge-table-toolbar")!,
  );
  const facets = current.querySelector<HTMLElement>(".knowledge-facets")!,
    nextFacets = next.querySelector<HTMLElement>(".knowledge-facets")!;
  // Same-kind facet nodes keep focus; changing kind legitimately changes the vocabulary.
  if (
    current.dataset.kind !== next.dataset.kind ||
    facets.dataset.signature !== nextFacets.dataset.signature
  ) {
    facets.replaceChildren(...nextFacets.childNodes);
  } else {
    for (const control of facets.querySelectorAll<HTMLElement>("[data-facet]")) {
      const updated = [...nextFacets.querySelectorAll<HTMLElement>("[data-facet]")].find(
        (n) => n.dataset.facet === control.dataset.facet,
      );
      if (!updated) {
        continue;
      }
      control.setAttribute("aria-pressed", updated.getAttribute("aria-pressed")!);
      const count = control.querySelector(".knowledge-facet-count"),
        nextCount = updated.querySelector(".knowledge-facet-count");
      if (count && nextCount) {
        count.textContent = nextCount.textContent;
      } else if (nextCount) {
        control.append(nextCount);
      } else {
        count?.remove();
      }
    }
  }
  const notes = facets.querySelectorAll("p"),
    nextNotes = nextFacets.querySelectorAll("p");
  notes.forEach((note, i) => {
    if (nextNotes[i]) {
      note.textContent = nextNotes[i].textContent;
    }
  });
  facets.dataset.signature = nextFacets.dataset.signature;
  current.dataset.kind = next.dataset.kind;
  const data = current.querySelector<HTMLElement>(".knowledge-browse-data")!,
    nextData = next.querySelector<HTMLElement>(".knowledge-browse-data")!;
  const table = data.querySelector(".knowledge-table"),
    nextTable = nextData.querySelector(".knowledge-table");
  // Keep column headings and table geometry for paging, filters and lifecycle toggles.
  if (table && nextTable) {
    table.querySelector("tbody")!.replaceWith(nextTable.querySelector("tbody")!);
    nextTable.replaceWith(table);
  }
  data.replaceChildren(...nextData.childNodes);
  data.inert = false;
  data.removeAttribute("aria-busy");
}
