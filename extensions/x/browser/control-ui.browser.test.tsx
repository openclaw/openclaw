import type {
  ControlUiHost,
  ControlUiPage,
  ControlUiViewContext,
} from "openclaw/plugin-sdk/control-ui";
import { flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { XAllowlistSnapshot } from "../src/admin.js";
import plugin from "../src/control-ui.tsx";

const snapshot: XAllowlistSnapshot = {
  accountId: "example",
  accounts: [{ accountId: "example", username: "example_bot" }],
  entries: [{ userId: "123", username: "maintainer", configured: true, editable: false }],
  guests: {
    enabled: false,
    helpersAvailable: true,
    maxMentionsPerAuthorPerDay: 3,
    admittedToday: 0,
    rateLimitedToday: 0,
  },
  verifiedFromGitHub: {
    repo: "example/repository",
    stale: false,
    lastSyncAt: 0,
    unresolvedHandles: [],
    entries: [
      {
        xUserId: "456",
        xHandle: "contributor",
        githubLogin: "contributor",
        permission: "push",
        syncedAt: 1,
      },
    ],
  },
  spend: {
    dayUsd: 0,
    cycleUsd: 0,
    dailyLimitUsd: 1,
    monthlyLimitUsd: 10,
    cycleStart: "2026-10-01",
  },
};

async function mount() {
  let registered: ControlUiPage | undefined;
  let notify = () => {};
  const request = vi.fn().mockResolvedValue(snapshot);
  const connection = { connected: true, canAdmin: true };
  const host = {
    locale: "en",
    connection,
    request,
    redact: (text: string) => text.replaceAll("synthetic-private-token", "[REDACTED]"),
    subscribe: (callback: () => void) => {
      notify = callback;
      return () => {};
    },
    ui: {
      registerPage: (page: ControlUiPage) => {
        registered = page;
        return () => {};
      },
      registerNavigation: () => () => {},
    },
  } as unknown as ControlUiHost;
  const stop = await plugin.activate(host);
  if (!registered) {
    throw new Error("Missing X page");
  }
  const abort = new AbortController();
  let context: ControlUiViewContext = {
    host,
    props: {},
    signal: abort.signal,
    presented: true,
    mountDefault: () => () => {},
  };
  const container = document.body.appendChild(document.createElement("div"));
  let view = registered.mount(container, context);
  function dispose() {
    abort.abort();
    view?.dispose?.();
    view = undefined;
  }
  onTestFinished(() => {
    dispose();
    if (typeof stop === "function") {
      stop();
    }
    container.remove();
  });
  await vi.waitFor(() => {
    flush();
    expect(container.textContent).toContain("@maintainer");
  });
  return {
    container,
    request,
    connection,
    notify: () => notify(),
    dispose,
    update(presented: boolean) {
      context = { ...context, presented };
      view?.update?.(context);
      flush();
    },
  };
}

it("keeps serial admission, redacted failures, and the draft through a held retry", async () => {
  const { container, request } = await mount();
  const input = container.querySelector<HTMLInputElement>('input[name="username"]')!;
  const form = container.querySelector("form")!;
  input.value = "new_user";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const failed = Promise.withResolvers<XAllowlistSnapshot>();
  request.mockReturnValueOnce(failed.promise);
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith("x.allowlist.add", {
    accountId: "example",
    username: "new_user",
  });
  failed.reject(new Error("Rejected synthetic-private-token"));
  await vi.waitFor(() => {
    flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Rejected [REDACTED]");
  });
  expect(container.textContent).not.toContain("synthetic-private-token");
  expect(input.value).toBe("new_user");
  const retry = Promise.withResolvers<XAllowlistSnapshot>();
  request.mockReturnValueOnce(retry.promise);
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  flush();
  await vi.waitFor(() => expect(input.disabled).toBe(true));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector("input")).toBe(input);
  expect(container.textContent).toContain("Updating X replies");
  retry.resolve(snapshot);
  await vi.waitFor(() => {
    flush();
    expect(input.disabled).toBe(false);
  });
  expect(input.value).toBe("");
  expect(container.textContent).toContain("Account added");
});

it("retires hidden and disposed reads while restoring only fresh administrator data", async () => {
  const f = await mount();
  const pending = Promise.withResolvers<XAllowlistSnapshot>();
  f.request.mockReturnValueOnce(pending.promise);
  f.container.querySelector<HTMLButtonElement>("header button")!.click();
  f.update(false);
  const successor = Promise.withResolvers<XAllowlistSnapshot>();
  f.request.mockReturnValueOnce(successor.promise);
  f.update(true);
  expect(f.request).toHaveBeenCalledTimes(3);
  successor.resolve(snapshot);
  await vi.waitFor(() => {
    flush();
    expect(f.container.textContent).toContain("@maintainer");
  });
  expect(f.container.querySelector('time[datetime="1970-01-01T00:00:00.000Z"]')).not.toBeNull();
  pending.reject(new Error("Retired failure"));
  await Promise.resolve();
  flush();
  expect(f.container.querySelector('[role="alert"]')).toBeNull();
  expect(f.container.textContent).toContain("@maintainer");
  f.connection.canAdmin = false;
  f.notify();
  flush();
  await vi.waitFor(() =>
    expect(f.container.textContent).toContain("Administrator access is required"),
  );
  expect(f.container.textContent).not.toContain("@maintainer");
  const disposed = Promise.withResolvers<XAllowlistSnapshot>();
  f.request.mockReturnValueOnce(disposed.promise);
  f.connection.canAdmin = true;
  f.notify();
  f.dispose();
  disposed.reject(new Error("Disposed failure"));
  await Promise.resolve();
});
