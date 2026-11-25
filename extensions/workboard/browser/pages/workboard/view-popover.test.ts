import { createRoot, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { workboardPopoverRef } from "./view-popover.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("anchors a popover whose preceding trigger is inserted after its Solid ref runs", () => {
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const trigger = document.createElement("button");
  const panel = document.createElement("div");
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(300, 100, 40, 20));
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 100));
  vi.spyOn(panel, "matches").mockImplementation((selector) => selector === ":popover-open");
  let dispose!: () => void;
  createRoot((cleanup) => {
    dispose = cleanup;
    workboardPopoverRef("end")(panel);
    document.body.append(trigger, panel);
  });
  flush();
  panel.dispatchEvent(new Event("toggle"));
  expect(panel.style.left).toBe("140px");
  expect(panel.style.top).toBe("126px");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  dispose();
});

it("anchors and returns focus to the pooled menu's current trigger until released", () => {
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const first = document.createElement("button");
  const second = document.createElement("button");
  const sibling = document.createElement("div");
  const panel = document.createElement("div");
  let active: HTMLButtonElement | undefined = first;
  vi.spyOn(first, "getBoundingClientRect").mockReturnValue(new DOMRect(300, 100, 40, 20));
  vi.spyOn(second, "getBoundingClientRect").mockReturnValue(new DOMRect(700, 200, 40, 20));
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 100));
  vi.spyOn(panel, "matches").mockImplementation((selector) => selector === ":popover-open");
  const hide = vi.fn();
  panel.hidePopover = hide;
  let dispose!: () => void;
  createRoot((cleanup) => {
    dispose = cleanup;
    workboardPopoverRef("end", false, () => active)(panel);
    document.body.append(first, second, sibling, panel);
  });
  flush();
  panel.dispatchEvent(new Event("toggle"));
  expect(panel.style.left).toBe("140px");
  active = second;
  panel.dispatchEvent(new Event("toggle"));
  expect(panel.style.left).toBe("540px");
  expect(second.getAttribute("aria-expanded")).toBe("true");
  const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
  panel.dispatchEvent(escape);
  expect(hide).toHaveBeenCalledOnce();
  expect(escape.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(second);
  active = undefined;
  panel.dispatchEvent(new Event("toggle"));
  expect(sibling.hasAttribute("aria-expanded")).toBe(false);
  dispose();
});
