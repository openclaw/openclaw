import "../../test/dom.setup.ts";
import assert from "node:assert/strict";
import type { ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { workboardTestHost } from "../../test/host.setup.ts";
import { createViewContext } from "../../test/host.ts";
import { createLazyWorkboardPage } from "./lazy-page.ts";

function fixture() {
  const { host } = workboardTestHost();
  const pending = createDeferred<ControlUiView>();
  const load = vi.fn(() => pending.promise);
  const abort = new AbortController();
  const context = { ...createViewContext(host, { boardId: "first" }), signal: abort.signal };
  const container = document.createElement("div");
  const view = createLazyWorkboardPage(load);
  return { host, pending, load, abort, context, container, view };
}

it("loads on presentation and mounts synchronously with the latest board context", async () => {
  const { host, pending, load, context, container, view } = fixture();
  const handle = view(container, { ...context, presented: false });
  assert.ok(handle, "lazy handle");
  expect(load).not.toHaveBeenCalled();
  handle.update?.(context);
  expect(container.textContent).toBe("Loading Workboard…");
  const next = { ...context, props: { boardId: "second" } };
  handle.update?.(next);
  const page = { update: vi.fn(), focus: vi.fn(), dispose: vi.fn() };
  const mount = vi.fn(() => page);
  handle.focus?.();
  pending.resolve(mount);
  await pending.promise;
  expect(host.ui.invalidate).toHaveBeenCalledOnce();
  expect(mount).not.toHaveBeenCalled();
  handle.update?.(next);
  expect(mount).toHaveBeenCalledExactlyOnceWith(container, next);
  expect(page.focus).toHaveBeenCalledOnce();
  handle.update?.({ ...next, presented: false });
  expect(page.update).toHaveBeenCalledWith({ ...next, presented: false });
  handle.dispose?.();
  handle.dispose?.();
  expect(page.dispose).toHaveBeenCalledOnce();
});

it.each(["dispose", "abort", "hide"] as const)(
  "does not mount after %s during import",
  async (transition) => {
    const { host, pending, context, container, view, abort } = fixture();
    const handle = view(container, context);
    assert.ok(handle, "lazy handle");
    if (transition === "dispose") {
      handle.dispose?.();
    } else if (transition === "abort") {
      abort.abort();
    } else {
      handle.update?.({ ...context, presented: false });
    }
    const mount = vi.fn();
    pending.resolve(mount);
    await pending.promise;
    handle.update?.({ ...context, presented: false });
    expect(mount).not.toHaveBeenCalled();
    if (transition === "hide") {
      handle.update?.(context);
      expect(mount).toHaveBeenCalledOnce();
    } else {
      expect(host.ui.invalidate).not.toHaveBeenCalled();
    }
    handle.dispose?.();
  },
);

it("reports reload guidance for import failures and preserves mount failure retry", async () => {
  const { host, pending, load, context, container, view } = fixture();
  const handle = view(container, context);
  assert.ok(handle, "lazy handle");
  const failure = new Error("chunk unavailable");
  pending.reject(failure);
  await pending.promise.catch(() => {});
  expect(host.ui.invalidate).toHaveBeenCalledOnce();
  expect(() => handle.update?.(context)).toThrow("Check your connection and reload this page.");
  handle.dispose?.();
  const mountFailure = new Error("mount failed");
  load.mockResolvedValue(() => {
    throw mountFailure;
  });
  const retry = view(container, context);
  assert.ok(retry, "retry handle");
  await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(2);
  expect(() => retry.update?.(context)).toThrow(mountFailure);
  retry.dispose?.();
});
