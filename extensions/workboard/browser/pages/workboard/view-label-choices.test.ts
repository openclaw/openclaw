import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { openEditModal } from "./view-card-modal.tsx";
import { createWorkboardView, requireButton, type SelectPicker } from "./view.test-support.ts";

function checkbox(container: Element, name: string) {
  return expectDefined(
    [...container.querySelectorAll<HTMLLabelElement>(".workboard-label-choices__option")]
      .find((label) => label.textContent?.trim() === name)
      ?.querySelector<HTMLInputElement>("input"),
    name,
  );
}
function setQuery(container: Element, text: string) {
  const input = expectDefined(
    container.querySelector<HTMLInputElement>('.workboard-label-choices input[type="search"]'),
    "label search",
  );
  input.value = text;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  flush();
  return input;
}
function mode(container: Element, value: string) {
  flush();
  const picker = expectDefined(
    [
      ...container.querySelectorAll<SelectPicker>(
        ".workboard-bulk-dialog [data-test-select-picker]",
      ),
    ].find((p) => p.accessibleLabel === "Labels"),
    "label mode",
  );
  picker.onSelect(value);
  flush();
}

it.each([
  { action: "add", expected: ["old", "quality"] },
  { action: "replace", expected: ["quality"] },
  { action: "remove", expected: ["old"] },
])(
  "chooses existing labels for bulk $action and saves only on Apply",
  async ({ action, expected }) => {
    const card = createWorkboardCard({
      id: "selected",
      labels: action === "remove" ? ["old", "quality"] : ["old"],
    });
    const request = vi
      .fn()
      .mockResolvedValue({ card: { ...card, labels: expected, updatedAt: 2 } });
    const { state, container, renderView } = createWorkboardView({
      client: { request },
      connected: true,
      canWrite: true,
    });
    state.cards = [card, createWorkboardCard({ id: "source", labels: ["quality"] })];
    state.selectedCardIds = new Set([card.id]);
    renderView();
    requireButton(container, "Edit properties").click();
    mode(container, action);
    checkbox(container, "quality").click();
    flush();
    expect(request).not.toHaveBeenCalled();
    requireButton(container, "Apply changes").click();
    await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
    expect(request).toHaveBeenCalledExactlyOnceWith("workboard.cards.update", {
      id: card.id,
      expectedUpdatedAt: card.updatedAt,
      patch: { labels: expected },
    });
    expect(state.cards.find((c) => c.id === card.id)?.labels).toEqual(expected);
    expect(state.bulkDialog).toBeNull();
  },
);

it("preserves comma-bearing saved labels and supports deliberate new labels without parsing", async () => {
  const card = createWorkboardCard({ labels: ["research, planning"], title: "Keep this title" });
  const labels = ["research, planning", "quality", "new, custom"];
  const request = vi.fn().mockResolvedValue({ card: { ...card, labels, updatedAt: 2 } });
  const { state, container, renderView } = createWorkboardView({
    client: { request },
    canWrite: true,
  });
  state.cards = [card, createWorkboardCard({ id: "source", labels: ["quality"] })];
  openEditModal(state, card);
  renderView();
  expect(checkbox(container, "research, planning").checked).toBe(true);
  checkbox(container, "quality").click();
  flush();
  const input = setQuery(container, "new, custom");
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  flush();
  expect(request).not.toHaveBeenCalled();
  container
    .querySelector<HTMLFormElement>(".workboard-draft")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(state.draftOpen).toBe(false));
  expect(request).toHaveBeenCalledExactlyOnceWith("workboard.cards.update", {
    id: card.id,
    expectedUpdatedAt: card.updatedAt,
    patch: { labels },
  });
  openEditModal(
    state,
    state.cards.find((c) => c.id === card.id)!,
  );
  renderView();
  for (const label of labels) {
    expect(checkbox(container, label).checked).toBe(true);
  }
  expect(state.draftTitle).toBe("Keep this title");
});

it("limits choices to the current board while retaining selected values outside the loaded catalog", () => {
  const card = createWorkboardCard({
    labels: ["saved-only"],
    metadata: { automation: { boardId: "one" } },
  });
  const { state, container, renderView } = createWorkboardView({
    client: { request: vi.fn() },
    canWrite: true,
  });
  state.boardFilter = "one";
  state.cards = [
    createWorkboardCard({
      id: "local",
      labels: ["local"],
      metadata: { automation: { boardId: "one" } },
    }),
    createWorkboardCard({
      id: "other",
      labels: ["outside"],
      metadata: { automation: { boardId: "two" } },
    }),
  ];
  openEditModal(state, card);
  renderView();
  expect(checkbox(container, "saved-only").checked).toBe(true);
  expect(checkbox(container, "local").checked).toBe(false);
  expect(container.querySelector(".workboard-label-choices")?.textContent).not.toContain("outside");
  setQuery(container, "loc");
  expect(
    container.querySelectorAll('.workboard-label-choices input[type="checkbox"]'),
  ).toHaveLength(1);
  expect(state.draftLabels).toEqual(["saved-only"]);
  setQuery(container, "");
  expect(checkbox(container, "saved-only").checked).toBe(true);
});

it("blocks bulk Add that would silently drop labels and keeps Replace empty as clear", async () => {
  const card = createWorkboardCard({ labels: Array.from({ length: 12 }, (_, i) => "label-" + i) });
  const request = vi.fn().mockResolvedValue({ card: { ...card, labels: [], updatedAt: 2 } });
  const { state, container, renderView } = createWorkboardView({
    client: { request },
    canWrite: true,
  });
  state.cards = [card, createWorkboardCard({ id: "source", labels: ["extra"] })];
  state.selectedCardIds = new Set([card.id]);
  renderView();
  requireButton(container, "Edit properties").click();
  mode(container, "add");
  checkbox(container, "extra").click();
  flush();
  expect(requireButton(container, "Apply changes").disabled).toBe(true);
  expect(container.textContent).toContain("more than 12 labels");
  mode(container, "replace");
  checkbox(container, "extra").click();
  flush();
  requireButton(container, "Apply changes").click();
  await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
  expect(request).toHaveBeenCalledExactlyOnceWith("workboard.cards.update", {
    id: card.id,
    expectedUpdatedAt: card.updatedAt,
    patch: { labels: [] },
  });
});
