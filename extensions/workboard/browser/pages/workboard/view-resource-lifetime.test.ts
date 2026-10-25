import "../../test/dom.setup.ts";
import { createComponent, render } from "@solidjs/web";
import { createRoot, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { workboardPopoverRef } from "./view-popover.ts";
import { SessionStatus } from "./view-session-status.tsx";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps closed status rows unregistered and shares dismissal only for open or pending rows", () => {
  vi.useFakeTimers();
  const add = vi.spyOn(document, "addEventListener");
  const remove = vi.spyOn(document, "removeEventListener");
  const events = new Set(["pointerdown", "scroll", "keydown"]);
  const active = () =>
    add.mock.calls.filter(([type, , options]) => events.has(type) && options === true).length -
    remove.mock.calls.filter(([type, , options]) => events.has(type) && options === true).length;
  const container = document.createElement("div");
  document.body.append(container);
  const presentation = {
    state: "queued",
    label: "Queued",
    detail: "Synthetic queued task",
    tone: "live",
    visible: true,
  } as const;
  const dispose = render(
    () =>
      Array.from({ length: 100 }, (_, index) =>
        createComponent(SessionStatus, {
          presentation,
          context: { id: `resource-status-${index}`, sessionName: `Synthetic ${index}` },
        }),
      ),
    container,
  );
  flush();
  try {
    expect(container.querySelectorAll("openclaw-workboard-session-status")).toHaveLength(100);
    expect(active()).toBe(0);
    const triggers = [
      ...container.querySelectorAll<HTMLButtonElement>(".workboard-session-status__trigger"),
    ];
    const panels = [
      ...container.querySelectorAll<HTMLElement>(".workboard-session-status__popover"),
    ];
    const firstShow = vi.spyOn(panels[0]!, "showPopover").mockImplementation(() => {});
    vi.spyOn(panels[1]!, "showPopover").mockImplementation(() => {});
    vi.spyOn(panels[0]!, "hidePopover").mockImplementation(() => {});
    vi.spyOn(panels[1]!, "hidePopover").mockImplementation(() => {});
    triggers[0]!.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    expect(active()).toBe(3);
    document.body.dispatchEvent(new Event("scroll", { bubbles: true, composed: true }));
    vi.advanceTimersByTime(350);
    expect(firstShow).not.toHaveBeenCalled();
    expect(active()).toBe(0);
    triggers[0]!.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    vi.advanceTimersByTime(350);
    expect(firstShow).not.toHaveBeenCalled();
    expect(active()).toBe(0);
    triggers[0]!.click();
    triggers[1]!.click();
    expect(triggers[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(triggers[1]!.getAttribute("aria-expanded")).toBe("true");
    expect(active()).toBe(3);
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(triggers[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(triggers[1]!.getAttribute("aria-expanded")).toBe("false");
    expect(active()).toBe(0);
  } finally {
    dispose();
  }
});

it("keeps closed generic popovers off the window and retains one positioning registration while open", () => {
  const add = vi.spyOn(window, "addEventListener");
  const remove = vi.spyOn(window, "removeEventListener");
  const active = () =>
    add.mock.calls.filter(([type]) => type === "resize" || type === "scroll").length -
    remove.mock.calls.filter(([type]) => type === "resize" || type === "scroll").length;
  const requestFrame = vi.fn(() => 1);
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const states = new Map<HTMLElement, boolean>();
  let dispose!: () => void;
  createRoot((cleanup) => {
    dispose = cleanup;
    for (let index = 0; index < 100; index++) {
      const trigger = document.createElement("button");
      const panel = document.createElement("div");
      states.set(panel, false);
      vi.spyOn(panel, "matches").mockImplementation(
        (selector) => selector === ":popover-open" && states.get(panel) === true,
      );
      workboardPopoverRef("end")(panel);
      document.body.append(trigger, panel);
    }
  });
  flush();
  try {
    expect(active()).toBe(0);
    expect(requestFrame).not.toHaveBeenCalled();
    const [first, second] = [...states.keys()];
    states.set(first!, true);
    first!.dispatchEvent(new Event("beforetoggle"));
    expect(requestFrame).toHaveBeenCalledTimes(1);
    first!.dispatchEvent(new Event("toggle"));
    expect(active()).toBe(2);
    states.set(second!, true);
    second!.dispatchEvent(new Event("toggle"));
    expect(active()).toBe(2);
    states.set(first!, false);
    first!.dispatchEvent(new Event("toggle"));
    expect(active()).toBe(2);
    states.set(second!, false);
    second!.dispatchEvent(new Event("toggle"));
    expect(active()).toBe(0);
  } finally {
    dispose();
  }
});
