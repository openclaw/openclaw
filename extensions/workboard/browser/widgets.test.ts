import { flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "./test/host.setup.ts";
import { createViewContext } from "./test/host.ts";
import { createWorkboardWidget } from "./widgets.tsx";
import { WorkboardWidgetModel } from "./widgets/runtime.ts";

function mountWidget(canMutate = true, presented = true) {
  const fixture = workboardTestHost();
  fixture.connection.connected = true;
  const initialListeners = new Set(fixture.listeners);
  const card = createWorkboardCard();
  const request = vi.fn(async () => ({ cards: [card] }));
  fixture.host.request = request as typeof fixture.host.request;
  const container = document.body.appendChild(document.createElement("div"));
  const widget = { name: "Card", props: { cardId: card.id } };
  const props = { sessionKey: "main", widget, canMutate, canGrant: true };
  const context = createViewContext(fixture.host, props, presented);
  const mounted = createWorkboardWidget(fixture.host, "card")(container, context);
  onTestFinished(() => container.remove());
  onTestFinished(() => mounted?.dispose?.());
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const notify = () => {
    fixture.notify();
    flush();
  };
  const present = (visible: boolean) => {
    mounted?.update?.({ ...context, presented: visible });
    flush();
  };
  const title = (text = card.title) =>
    vi.waitFor(() => expect(container.textContent).toContain(text));
  return { ...fixture, request, card, container, present, notify, title, initialListeners };
}

it("does not derive cards for unrelated host notifications but updates permission and card changes", async () => {
  const w = mountWidget();
  await w.title();
  const select = w.container.querySelector("select")!;
  const deriveCards = vi.spyOn(WorkboardWidgetModel.prototype, "cards", "get");
  w.notify();
  expect(deriveCards).not.toHaveBeenCalled();
  expect(w.container.querySelector("select")).toBe(select);
  expect(w.request).toHaveBeenCalledTimes(1);

  Object.assign(w.host, { locale: "es" });
  w.notify();
  expect(select.getAttribute("aria-label")).toBe(`Estado: ${w.card.title}`);
  expect(deriveCards).not.toHaveBeenCalled();
  for (const canWrite of [false, true]) {
    w.connection.canWrite = canWrite;
    w.notify();
    expect(select.disabled).toBe(!canWrite);
  }

  w.request.mockResolvedValueOnce({ cards: [{ ...w.card, title: "Changed card" }] });
  w.emit("plugin.workboard.changed", {});
  await w.title("Changed card");
  expect(deriveCards).toHaveBeenCalled();
  expect(w.container.querySelector("select")).toBe(select);
});

it.each([false, true])("blocks read-only/hidden mutations (canMutate=%s)", async (canMutate) => {
  const w = mountWidget(canMutate, false);
  expect(w.request).not.toHaveBeenCalled();
  w.present(true);
  await w.title();
  const select = w.container.querySelector("select")!;
  w.present(!canMutate);
  expect(w.container.querySelector("select")).toBe(select);
  expect(select.disabled).toBe(true);
  select.value = "done";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  expect(w.request).toHaveBeenCalledTimes(1);
  if (canMutate) {
    expect(w.listeners).toEqual(w.initialListeners);
    expect(w.events.get("plugin.workboard.changed")?.size).toBe(0);
    const deriveCards = vi.spyOn(WorkboardWidgetModel.prototype, "cards", "get");
    w.notify();
    expect(deriveCards).not.toHaveBeenCalled();
    w.emit("plugin.workboard.changed", {});
    expect(w.request).toHaveBeenCalledTimes(1);
    w.present(true);
    await vi.waitFor(() => expect(w.request).toHaveBeenCalledTimes(2));
  }
});

it("offers retry after an owner request fails, then replaces the error with cards", async () => {
  const { request, present, title, container } = mountWidget(true, false);
  request.mockRejectedValueOnce(new Error("Catalog temporarily unavailable"));
  present(true);
  await title("Catalog temporarily unavailable");
  container.querySelector<HTMLButtonElement>("button")!.click();
  await title();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
