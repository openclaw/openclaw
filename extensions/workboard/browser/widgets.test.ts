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
  const context = createViewContext(
    fixture.host,
    {
      sessionKey: "main",
      widget: { name: "Card", props: { cardId: card.id } },
      canMutate,
      canGrant: true,
    },
    presented,
  );
  const mounted = createWorkboardWidget(fixture.host, "card")(container, context);
  disposers.push(() => mounted?.dispose?.());
  return { fixture, request, card, container, context, mounted, initialListeners };
}

it("renders the public card widget with read-only status controls", async () => {
  const widget = mountWidget(false);
  await vi.waitFor(() => expect(widget.container.textContent).toContain(widget.card.title));
  const select = widget.container.querySelector("select");
  expect(select?.disabled).toBe(true);
  select!.value = "done";
  select!.dispatchEvent(new Event("change", { bubbles: true }));
  expect(widget.request.mock.calls).toHaveLength(1);
});

it("does not derive cards for unrelated host notifications but updates permission and card changes", async () => {
  const widget = mountWidget();
  await vi.waitFor(() => expect(widget.container.textContent).toContain(widget.card.title));
  const select = widget.container.querySelector("select")!;
  const deriveCards = vi.spyOn(WorkboardWidgetModel.prototype, "cards", "get");
  for (let index = 0; index < 10; index += 1) {
    widget.fixture.notify();
    flush();
  }
  expect(deriveCards).not.toHaveBeenCalled();
  expect(widget.container.querySelector("select")).toBe(select);
  expect(widget.request).toHaveBeenCalledTimes(1);

  Object.assign(widget.fixture.host, { locale: "es" });
  widget.fixture.notify();
  flush();
  expect(select.getAttribute("aria-label")).toBe(`Estado: ${widget.card.title}`);
  expect(deriveCards).not.toHaveBeenCalled();
  Object.assign(widget.fixture.host, { locale: "en" });
  widget.fixture.notify();
  flush();

  widget.fixture.connection.canWrite = false;
  widget.fixture.notify();
  flush();
  expect(select.disabled).toBe(true);
  widget.fixture.connection.canWrite = true;
  widget.fixture.notify();
  flush();
  expect(select.disabled).toBe(false);

  widget.request.mockResolvedValueOnce({ cards: [{ ...widget.card, title: "Changed card" }] });
  widget.fixture.emit("plugin.workboard.changed", {});
  await vi.waitFor(() => expect(widget.container.textContent).toContain("Changed card"));
  expect(deriveCards).toHaveBeenCalled();
  expect(widget.container.querySelector("select")).toBe(select);

  widget.mounted?.update?.({ ...widget.context, presented: false });
  flush();
  deriveCards.mockClear();
  widget.fixture.notify();
  flush();
  expect(deriveCards).not.toHaveBeenCalled();
  expect(widget.fixture.listeners).toEqual(widget.initialListeners);
});

it("starts visible widgets and releases hidden widget subscriptions", async () => {
  const widget = mountWidget(true, false);
  expect(widget.request).not.toHaveBeenCalled();
  widget.mounted?.update?.({ ...widget.context, presented: true });
  await vi.waitFor(() => expect(widget.container.textContent).toContain(widget.card.title));
  const select = widget.container.querySelector("select")!;
  const count = widget.request.mock.calls.length;
  widget.mounted?.update?.({ ...widget.context, presented: false });
  flush();
  expect(widget.container.querySelector("select")).toBe(select);
  expect(select.disabled).toBe(true);
  select.value = "done";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  expect(widget.request).toHaveBeenCalledTimes(count);
  expect(widget.fixture.listeners).toEqual(widget.initialListeners);
  expect(widget.fixture.events.get("plugin.workboard.changed")?.size).toBe(0);
  widget.fixture.emit("plugin.workboard.changed", {});
  expect(widget.request).toHaveBeenCalledTimes(count);
  widget.mounted?.update?.({ ...widget.context, presented: true });
  await vi.waitFor(() => expect(widget.request).toHaveBeenCalledTimes(count + 1));
});

it("offers retry after an owner request fails, then replaces the error with cards", async () => {
  const widget = mountWidget(true, false);
  widget.request.mockRejectedValueOnce(new Error("Catalog temporarily unavailable"));
  widget.mounted?.update?.({ ...widget.context, presented: true });
  await vi.waitFor(() =>
    expect(widget.container.textContent).toContain("Catalog temporarily unavailable"),
  );
  widget.container.querySelector<HTMLButtonElement>("button")!.click();
  await vi.waitFor(() => expect(widget.container.textContent).toContain(widget.card.title));
  expect(widget.container.querySelector('[role="alert"]')).toBeNull();
});
