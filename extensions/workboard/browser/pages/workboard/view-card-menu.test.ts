import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { createComponent, render } from "@solidjs/web";
import { flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import {
  createLoadedWorkboardState,
  createWorkboardRenderProps,
  createWorkboardView,
  openCardMenu,
  requireButton,
} from "./view.test-support.ts";
import { WorkboardView } from "./view.tsx";

it("keeps one menu and its controls while switching cards in either layout", () => {
  for (const viewMode of ["board", "list"] as const) {
    const { state, container, renderView } = createWorkboardView({ canWrite: true });
    state.viewMode = viewMode;
    state.cards = [
      createWorkboardCard({ id: "first", title: "First card" }),
      createWorkboardCard({ id: "second", title: "Second card" }),
    ];
    renderView();
    const rows = container.querySelectorAll(".workboard-card");
    const first = expectDefined(rows[0], "first card");
    const second = expectDefined(rows[1], "second card");
    const eager = expectDefined(
      container.querySelector(".workboard-card__action-menu-panel"),
      "eager menu",
    );
    const parent = expectDefined(eager.parentElement, "menu parent");
    expect(parent.classList.contains("workboard-main")).toBe(true);
    const controls = [...eager.querySelectorAll("button, select")];
    expect(controls.length).toBeGreaterThan(0);
    const panel = openCardMenu(first);
    expect(panel).toBe(eager);
    expect(panel.parentElement).toBe(parent);
    expect(container.querySelectorAll(".workboard-card__action-menu-panel")).toHaveLength(1);
    expect(openCardMenu(second)).toBe(panel);
    expect(panel.parentElement).toBe(parent);
    expect(first.querySelector(".workboard-card__action-menu-panel")).toBeNull();
    expect(second.querySelector(".workboard-card__action-menu-panel")).toBeNull();
    const currentControls = [...panel.querySelectorAll("button, select")];
    expect(currentControls).toHaveLength(controls.length);
    controls.forEach((control, index) => expect(currentControls[index]).toBe(control));
    expect(panel.querySelector("select")?.getAttribute("aria-label")).toBe("Status: Second card");
    requireButton(panel, "Edit card").click();
    expect(state.editingCardId).toBe("second");
  }
});

it("retires a filtered card's menu before another card can receive its actions", () => {
  const { state, container, renderView } = createWorkboardView({ canWrite: true });
  state.cards = [
    createWorkboardCard({ id: "first", title: "First card" }),
    createWorkboardCard({ id: "second", title: "Second card" }),
  ];
  renderView();
  const panel = openCardMenu(container);
  const trigger = requireButton(container, "Card actions");
  const hide = vi.spyOn(panel, "hidePopover");
  state.query = "Second card";
  renderView();
  expect(hide).toHaveBeenCalled();
  expect(trigger.isConnected).toBe(false);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(panel.isConnected).toBe(true);
  expect(panel.closest(".workboard-card")).toBeNull();
  expect(panel.parentElement?.classList.contains("workboard-main")).toBe(true);
  expect(state.draftOpen).toBe(false);
  expect(openCardMenu(container)).toBe(panel);
  requireButton(panel, "Edit card").click();
  expect(state.editingCardId).toBe("second");
});

it.each(["View details", "Edit card"])("keeps the menu inert behind %s", (action) => {
  const { state, container, renderView } = createWorkboardView({ canWrite: true });
  state.cards = [createWorkboardCard({ id: "first", title: "First card" })];
  renderView();
  const panel = openCardMenu(container);
  const parent = expectDefined(panel.parentElement, "menu parent");
  const hide = vi.spyOn(panel, "hidePopover");
  requireButton(panel, action).click();
  renderView();
  expect(hide).toHaveBeenCalled();
  expect(panel.parentElement).toBe(parent);
  expect(parent.hasAttribute("inert")).toBe(true);
  expect(parent.getAttribute("aria-hidden")).toBe("true");
  const dialog = expectDefined(
    container.querySelector(".workboard-detail, .workboard-draft"),
    "active card dialog",
  );
  expect(dialog.closest("[inert]")).toBeNull();
});

it("owns separate menus for simultaneous views and removes its panel on disposal", () => {
  const first = createLoadedWorkboardState();
  const firstContainer = document.createElement("div");
  document.body.append(firstContainer);
  const second = createWorkboardView({ canWrite: true });
  first.state.cards = [createWorkboardCard({ id: "same", title: "First view" })];
  second.state.cards = [createWorkboardCard({ id: "same", title: "Second view" })];
  const dispose = render(
    () =>
      createComponent(WorkboardView, createWorkboardRenderProps(first.host, { canWrite: true })),
    firstContainer,
  );
  onTestFinished(() => {
    dispose();
    firstContainer.remove();
  });
  flush();
  second.renderView();
  const firstPanel = openCardMenu(firstContainer);
  const secondPanel = openCardMenu(second.container);
  expect(firstPanel).not.toBe(secondPanel);
  requireButton(secondPanel, "Edit card").click();
  expect(second.state.draftOpen).toBe(true);
  expect(first.state.draftOpen).toBe(false);
  dispose();
  expect(firstPanel.isConnected).toBe(false);
  expect(firstContainer.querySelector(".workboard-card__action-menu-panel")).toBeNull();
  expect(second.state.editingCardId).toBe("same");
});
