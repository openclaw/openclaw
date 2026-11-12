/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { ontologyView } from "./ontology-view.js";

const layout = {
  question: "what is it for?",
  sections: [
    { heading: "Key decisions", guidance: "decisions that still shape it." },
    { heading: "Milestones", guidance: "dated outcomes." },
  ],
  notes: "State says where things stand.",
};
const definition = (name: string, extra = {}) => ({
  name,
  label: name[0]!.toUpperCase() + name.slice(1),
  kind: "page",
  primitive: "concept",
  description: `${name} pages`,
  aliases: [],
  recordCount: 0,
  ...extra,
});
const data: any = {
  view: "definitions",
  available: true,
  name: "vault",
  version: "1.0.0",
  fingerprint: "f".repeat(64),
  total: 2,
  offset: 0,
  nextOffset: null,
  totalIssues: 0,
  definitions: [definition("project", { layout, layoutOverride: true }), definition("note")],
};
// Where jsdom lacks modal dialogs, opening and closing only toggle `open`.
for (const [method, open] of [
  ["showModal", true],
  ["close", false],
] as const) {
  if (!(method in HTMLDialogElement.prototype)) {
    Object.defineProperty(HTMLDialogElement.prototype, method, {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = open;
      },
    });
  }
}

function mount(editing?: Parameters<typeof ontologyView>[3], openType?: string) {
  const page = document.createElement("div");
  page.className = "knowledge-page";
  document.body.replaceChildren(page);
  page.append(
    ontologyView(
      data,
      () => {},
      () => {},
      editing,
      openType,
    ),
  );
  const click = (root: ParentNode, text: string) =>
    [...root.querySelectorAll("button")]
      .find((b) => b.textContent === text || b.getAttribute("aria-label") === text)!
      .click();
  // Opens a type's detail from its card and returns the dialog.
  const detail = (name: string) => {
    page.querySelector<HTMLElement>(`[data-reading-key="type:page:${name}"] h4`)!.click();
    return page.querySelector<HTMLElement>(`[data-type="${name}"]`)!.closest("dialog")!;
  };
  const top = () => [...page.querySelectorAll("dialog")].at(-1)!;
  return { page, detail, click, top };
}

it("opens a page type's detail with its layout, without edit controls for readers", () => {
  const { detail } = mount();
  const project = detail("project");
  expect(project.querySelector("h3")!.textContent).toBe("Project");
  expect(project.querySelector(".knowledge-layout-question")!.textContent).toBe(
    "Answers: what is it for?",
  );
  expect(
    [...project.querySelectorAll(".knowledge-layout-sections strong")].map((n) => n.textContent),
  ).toStrictEqual(["Key decisions", "Milestones"]);
  expect(project.querySelector(".knowledge-layout-badge")!.textContent).toBe("Customized");
  expect([...project.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual([
    "Close",
  ]);
  expect(detail("note").textContent).toContain("No layout yet.");
});

it("edits, adds and resets layouts through the save callback, closing the stale detail", async () => {
  const save = vi.fn(async () => undefined);
  const { detail, click, top } = mount({ save });

  let opened = detail("project");
  click(opened, "Edit layout");
  let dialog = top();
  const question = dialog.querySelector("textarea")!;
  question.value = "what is it for, now?";
  question.dispatchEvent(new Event("input"));
  click(dialog, "Remove section 1");
  click(dialog, "Save layout");
  await vi.waitFor(() => expect(dialog.isConnected).toBe(false));
  expect(opened.isConnected).toBe(false);
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ name: "project" }), {
    question: "what is it for, now?",
    sections: [{ heading: "Milestones", guidance: "dated outcomes." }],
    notes: "State says where things stand.",
  });

  click(detail("note"), "Add layout");
  dialog = top();
  const submit = [...dialog.querySelectorAll("button")].find(
    (b) => b.textContent === "Save layout",
  )!;
  expect(submit.disabled).toBe(true);
  dialog.querySelector("textarea")!.value = "what was noted?";
  const heading = dialog.querySelector<HTMLInputElement>(".knowledge-layout-editor-head input")!;
  heading.value = "## Context";
  const guidance = dialog.querySelectorAll("textarea")[1]!;
  guidance.value = "why it matters.";
  guidance.dispatchEvent(new Event("input"));
  expect(submit.disabled).toBe(false);
  submit.click();
  await vi.waitFor(() => expect(dialog.isConnected).toBe(false));
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ name: "note" }), {
    question: "what was noted?",
    sections: [{ heading: "Context", guidance: "why it matters." }],
  });

  opened = detail("project");
  click(opened, "Reset to default");
  dialog = top();
  click(dialog, "Reset to default");
  await vi.waitFor(() => expect(dialog.isConnected).toBe(false));
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ name: "project" }), null);
});

it("keeps the editor open with the refusal when a save fails", async () => {
  const save = vi.fn(async () => "This layout changed since it was opened.");
  const { detail, click, top } = mount({ save });
  click(detail("project"), "Reset to default");
  const dialog = top();
  click(dialog, "Reset to default");
  await vi.waitFor(() =>
    expect(dialog.querySelector(".knowledge-dialog-feedback")!.textContent).toBe(
      "The layout was not saved. This layout changed since it was opened.",
    ),
  );
  expect(dialog.isConnected).toBe(true);
});

it("reopens the saved type's detail after the view re-renders", async () => {
  const { page } = mount({ save: async () => undefined }, "project");
  await vi.waitFor(() => expect(page.querySelector('[data-type="project"]')).not.toBeNull());
});
