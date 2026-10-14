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
