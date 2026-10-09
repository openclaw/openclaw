import "./test/dom.setup.ts";
import assert from "node:assert/strict";
import type { ControlUiPage } from "openclaw/plugin-sdk/control-ui";
import { expect, it, vi } from "vitest";
import workboardPlugin from "./index.ts";
import { workboardTestHost } from "./test/host.setup.ts";
import { createViewContext } from "./test/host.ts";

const page = vi.hoisted(() => ({ evaluations: 0, mount: vi.fn() }));
// mock-isolation: Count page evaluation without importing the page through the mock itself.
vi.mock("./pages/workboard/workboard-page.ts", () => {
  page.evaluations += 1;
  return { createWorkboardPage: () => page.mount };
});

it("registers navigation, accessories and widgets without evaluating the page", async () => {
  const { host, registrations } = workboardTestHost();
  const dispose = await workboardPlugin.activate(host);
  try {
    expect(registrations.has("navigation/workboard")).toBe(true);
    expect(registrations.has("accessory/linked-card")).toBe(true);
    expect(registrations.has("widget/board")).toBe(true);
    expect(page.evaluations).toBe(0);
    const registered = registrations.get("page/workboard") as ControlUiPage;
    const container = document.createElement("div");
    const context = createViewContext(host, {});
    const handle = registered.mount(container, context);
    assert.ok(handle, "lazy handle");
    try {
      await vi.dynamicImportSettled();
      expect(page.evaluations).toBe(1);
      handle.update?.(context);
      expect(page.mount).toHaveBeenCalledExactlyOnceWith(container, context);
    } finally {
      handle.dispose?.();
    }
  } finally {
    dispose?.();
  }
});
