import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "./test/host.setup.ts";
import { createViewContext } from "./test/host.ts";
import { createWorkboardWidget } from "./widgets.tsx";
import { WorkboardWidgetModel } from "./widgets/runtime.ts";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function mountWidget(canMutate = true, presented = true) {
  const fixture = workboardTestHost();
  fixture.connection.connected = true;
  const initialListeners = new Set(fixture.listeners);
  const card = createWorkboardCard();
  const request = vi.fn(async () => ({ cards: [card] }));
  fixture.host.request = request as typeof fixture.host.request;
  const container = document.createElement("div");
  document.body.append(container);
  const props = {
    sessionKey: "main",
    widget: { name: "Card", props: { cardId: card.id } },
    canMutate,
    canGrant: true,
  };
  const context = createViewContext(fixture.host, props, presented);
  const mounted = createWorkboardWidget(fixture.host, "card")(container, context);
  disposers.push(() => mounted?.dispose?.());
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

it("renders the public card widget with read-only status controls", async () => {
  const { container, title, request } = mountWidget(false);
  await title();
  const select = container.querySelector("select");
  expect(select?.disabled).toBe(true);
  select!.value = "done";
  select!.dispatchEvent(new Event("change", { bubbles: true }));
  expect(request.mock.calls).toHaveLength(1);
});

it("does not derive cards for unrelated host notifications but updates permission and card changes", async () => {
  const w = mountWidget();
  await w.title();
  const select = w.container.querySelector("select")!;
  const deriveCards = vi.spyOn(WorkboardWidgetModel.prototype, "cards", "get");
  for (let index = 0; index < 10; index += 1) {
    w.notify();
  }
  expect(deriveCards).not.toHaveBeenCalled();
  expect(w.container.querySelector("select")).toBe(select);
  expect(w.request).toHaveBeenCalledTimes(1);

  Object.assign(w.host, { locale: "es" });
  w.notify();
  expect(select.getAttribute("aria-label")).toBe(`Estado: ${w.card.title}`);
  expect(deriveCards).not.toHaveBeenCalled();
  Object.assign(w.host, { locale: "en" });
  w.notify();

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

  w.present(false);
  deriveCards.mockClear();
  w.notify();
  expect(deriveCards).not.toHaveBeenCalled();
  expect(w.listeners).toEqual(w.initialListeners);
});

it("starts visible widgets and releases hidden widget subscriptions", async () => {
  const { request, present, title, container, listeners, initialListeners, events, emit } =
    mountWidget(true, false);
  expect(request).not.toHaveBeenCalled();
  present(true);
  await title();
  const select = container.querySelector("select")!;
  const count = request.mock.calls.length;
  present(false);
  expect(container.querySelector("select")).toBe(select);
  expect(select.disabled).toBe(true);
  select.value = "done";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  expect(request).toHaveBeenCalledTimes(count);
  expect(listeners).toEqual(initialListeners);
  expect(events.get("plugin.workboard.changed")?.size).toBe(0);
  emit("plugin.workboard.changed", {});
  expect(request).toHaveBeenCalledTimes(count);
  present(true);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(count + 1));
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
