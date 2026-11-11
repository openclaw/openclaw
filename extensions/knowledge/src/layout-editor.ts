import type { Layout } from "./model.js";
import { button, el } from "./page-dom.js";
import { icon } from "./ui-icons.js";

/** Saves a layout (null resets it); resolves to an error message, or undefined once saved. */
export type SaveLayout = (layout: Layout | null) => Promise<string | undefined>;

let modals = 0;
/** A titled modal in the Knowledge page; content goes in `body`, completion actions in `footer`. */
export function modal(title: string, className: string) {
  const dialog = el("dialog", undefined, `knowledge-store-dialog ${className}`),
    // SAFETY: only focus() is called on it, which every focusable HTML or SVG element implements.
    previousFocus = document.activeElement as HTMLElement | null;
  const heading = el("h3", title),
    body = el("div", undefined, "knowledge-store-dialog-body"),
    feedback = el("p", "", "knowledge-dialog-feedback"),
    footer = el("div", undefined, "knowledge-actions");
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  heading.id = `knowledge-modal-title-${++modals}`;
  dialog.setAttribute("aria-labelledby", heading.id);
  const close = () => {
    dialog.close();
    dialog.remove();
    previousFocus?.focus();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  const closeButton = button("", () => close(), "knowledge-icon-button");
  closeButton.setAttribute("aria-label", "Close");
  closeButton.append(icon("x", 14));
  const top = el("div", undefined, "knowledge-store-dialog-head");
  top.append(heading, closeButton);
  dialog.append(top, body, feedback, footer);
  const show = () => {
    // Inside the page so its styles apply; the modal top layer handles stacking.
    (document.querySelector(".knowledge-page") ?? document.body).append(dialog);
    dialog.showModal();
  };
  return { dialog, body, feedback, footer, close, show };
}

/** Modal editor for one page type's layout. `reset` asks to restore the inherited layout instead. */
export function openLayoutDialog(
  type: { label: string; layout?: Layout },
  save: SaveLayout,
  reset = false,
) {
  const { dialog, body, feedback, footer, close, show } = modal(
    reset
      ? `Reset the ${type.label} layout?`
      : `${type.layout ? "Edit" : "Add"} ${type.label} layout`,
    "knowledge-layout-dialog",
  );
  let saving = false;
  const cancel = button("Cancel", () => close(), "knowledge-quiet"),
    submit = button(
      reset ? "Reset to default" : "Save layout",
      () => void run(),
      "knowledge-button knowledge-primary",
    );

  const area = (value: string, rows: number, labelText: string) => {
    const input = el("textarea");
    input.value = value;
    input.rows = rows;
    input.setAttribute("aria-label", labelText);
    input.addEventListener("input", () => refresh());
    return input;
  };
  const field = (title: string, hint: string, input: HTMLElement) => {
    const wrap = el("label", undefined, "knowledge-field");
    wrap.append(el("span", title), input, el("small", hint));
    return wrap;
  };

  let collect: () => Layout | null | undefined = () => null;
  if (reset) {
    body.append(
      el(
        "p",
        `Pages of this type go back to the layout the vocabulary provides. The saved version stays in the vault’s history.`,
      ),
    );
  } else {
    const question = area(type.layout?.question ?? "", 2, "Question this page answers");
    const notes = area(type.layout?.notes ?? "", 4, "Notes");
    const list = el("ol", undefined, "knowledge-layout-editor-sections");
    type Row = { heading: HTMLInputElement; guidance: HTMLTextAreaElement };
    const rows: Row[] = [];
    const renderRows = () => {
      list.replaceChildren();
      rows.forEach((row, index) => {
        const item = el("li", undefined, "knowledge-layout-editor-section");
        const controls = el("div", undefined, "knowledge-layout-editor-controls");
        const control = (
          name: "arrowUp" | "arrowDown" | "trash",
          labelText: string,
          disabled: boolean,
          act: () => void,
        ) => {
          const b = button(
            "",
            () => {
              act();
              renderRows();
              refresh();
            },
            "knowledge-icon-button knowledge-quiet",
          );
          b.setAttribute("aria-label", `${labelText} ${index + 1}`);
          b.disabled = disabled;
          b.append(icon(name, 14));
          return b;
        };
        controls.append(
          control("arrowUp", "Move up section", index === 0, () =>
            rows.splice(index - 1, 0, ...rows.splice(index, 1)),
          ),
          control("arrowDown", "Move down section", index === rows.length - 1, () =>
            rows.splice(index + 1, 0, ...rows.splice(index, 1)),
          ),
          control("trash", "Remove section", rows.length === 1, () => rows.splice(index, 1)),
        );
        const head = el("div", undefined, "knowledge-layout-editor-head");
        head.append(row.heading, controls);
        item.append(head, row.guidance);
        list.append(item);
      });
    };
    const addRow = (title = "", guidance = "") => {
      const headingInput = el("input");
      headingInput.value = title;
      headingInput.maxLength = 100;
      headingInput.placeholder = "Heading";
      headingInput.setAttribute("aria-label", "Section heading");
      headingInput.addEventListener("input", () => refresh());
      rows.push({ heading: headingInput, guidance: area(guidance, 3, "Section guidance") });
    };
    for (const section of type.layout?.sections ?? [{ heading: "", guidance: "" }]) {
      addRow(section.heading, section.guidance);
    }
    renderRows();
    const add = button(
      "Add section",
      () => {
        addRow();
        renderRows();
        refresh();
        rows.at(-1)!.heading.focus();
      },
      "knowledge-button",
    );
    add.prepend(icon("plus", 14));
    const sections = el("div", undefined, "knowledge-field");
    sections.append(
      el("span", "Sections"),
      el(
        "small",
        "In page order, after the introduction and State. Agents use only those the evidence supports.",
      ),
      list,
      add,
    );
    body.append(
      field(
        "What a page of this type answers",
        "Agents read this to decide what belongs on the page.",
        question,
      ),
      sections,
      field("Notes", "Optional rules that apply to the whole page.", notes),
    );
    collect = () => {
      const result: Layout = {
        question: question.value.trim(),
        sections: rows.map((row) => ({
          heading: row.heading.value.trim().replace(/^#+\s*/, ""),
          guidance: row.guidance.value.trim(),
        })),
        ...(notes.value.trim() ? { notes: notes.value.trim() } : {}),
      };
      const complete = result.question && result.sections.every((s) => s.heading && s.guidance);
      return complete && JSON.stringify(result) !== JSON.stringify(type.layout)
        ? result
        : undefined;
    };
  }
  const refresh = () => {
    submit.disabled = saving || collect() === undefined;
    submit.textContent = saving ? "Saving…" : reset ? "Reset to default" : "Save layout";
  };
  async function run() {
    const layout = collect();
    if (layout === undefined || saving) {
      return;
    }
    saving = true;
    refresh();
    feedback.textContent = "";
    const failure = await save(layout).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    saving = false;
    if (failure === undefined) {
      close();
      return;
    }
    feedback.textContent = `The layout was not saved. ${failure}`;
    feedback.className = "knowledge-dialog-feedback knowledge-error";
    refresh();
  }
  footer.append(cancel, submit);
  show();
  refresh();
  (dialog.querySelector<HTMLElement>("textarea, input") ?? submit).focus();
}
