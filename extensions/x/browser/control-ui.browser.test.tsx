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

async function mount(initialSnapshot = snapshot) {
  let registered: ControlUiPage | undefined;
  let notify = () => {};
  const request = vi.fn().mockImplementation(async () => structuredClone(initialSnapshot));
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

it("retains account and allowlist rows by their domain keys across fresh reordered snapshots", async () => {
  const initial = structuredClone(snapshot);
  initial.accounts.push({ accountId: "second", username: "second_bot" });
  initial.entries.push({
    userId: "789",
    username: "second_maintainer",
    configured: true,
    editable: false,
  });
  const github = initial.verifiedFromGitHub!;
  delete github.lastSyncAt;
  github.entries.push({
    xUserId: "987",
    xHandle: "second_contributor",
    githubLogin: "second-contributor",
    permission: "push",
    syncedAt: 1,
  });
  github.unresolvedHandles = ["missing_one", "missing_two"];
  const formatDescriptor = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format");
  if (!formatDescriptor?.get) {
    throw new Error("Expected Intl.DateTimeFormat.format to be an accessor");
  }
  const format = vi.fn(function (this: Intl.DateTimeFormat): Intl.DateTimeFormat["format"] {
    return formatDescriptor.get!.call(this);
  });
  Object.defineProperty(Intl.DateTimeFormat.prototype, "format", {
    ...formatDescriptor,
    get: format,
  });
  onTestFinished(() => {
    Object.defineProperty(Intl.DateTimeFormat.prototype, "format", formatDescriptor);
  });
  const { container, request } = await mount(initial);
  const account = container.querySelector("select")!;
  const accounts = [...account.options];
  const manualRows = [...container.querySelectorAll(".x-replies__list tbody tr")].slice(0, 2);
  const githubRows = [...container.querySelectorAll(".x-replies__github tbody tr")];
  expect(format).toHaveBeenCalledTimes(2);

  const next = structuredClone(initial);
  next.accounts.reverse();
  next.entries.reverse();
  const nextGitHub = next.verifiedFromGitHub!;
  nextGitHub.entries.reverse();
  nextGitHub.entries[0]!.syncedAt = 2;
  nextGitHub.entries[0]!.xHandle = "updated_contributor";
  nextGitHub.unresolvedHandles = ["missing_two", "missing_three"];
  request.mockResolvedValueOnce(next);
  container.querySelector<HTMLButtonElement>("header button")!.click();
  await vi.waitFor(() => {
    flush();
    expect(container.textContent).toContain("@updated_contributor");
    expect(container.querySelector('time[datetime="1970-01-01T00:00:00.002Z"]')).not.toBeNull();
  });
  expect(account.options[0]).toBe(accounts[1]);
  expect(account.options[1]).toBe(accounts[0]);
  expect(account.value).toBe("example");
  const nextManualRows = container.querySelectorAll(".x-replies__list tbody tr");
  expect(nextManualRows[0]).toBe(manualRows[1]);
  expect(nextManualRows[1]).toBe(manualRows[0]);
  const nextGitHubRows = container.querySelectorAll(".x-replies__github tbody tr");
  expect(nextGitHubRows[0]).toBe(githubRows[1]);
  expect(nextGitHubRows[1]).toBe(githubRows[0]);
  expect(format).toHaveBeenCalledTimes(3);
  expect(container.textContent).toContain("@missing_two, @missing_three");
  expect(container.textContent).not.toContain("@missing_one");
  expect(initial.accounts[0]!.accountId).toBe("example");
  expect(github.entries[1]!.syncedAt).toBe(1);

  const withoutGitHub = structuredClone(next);
  delete withoutGitHub.verifiedFromGitHub;
  const refresh = Promise.withResolvers<XAllowlistSnapshot>();
  request.mockReturnValueOnce(refresh.promise);
  container.querySelector<HTMLButtonElement>("header button")!.click();
  flush();
  expect(container.querySelector(".x-replies__list tbody tr")).toBe(nextManualRows[0]);
  expect(container.querySelector(".x-replies__github tbody tr")).toBe(nextGitHubRows[0]);
  expect(format).toHaveBeenCalledTimes(3);
  refresh.resolve(withoutGitHub);
  await vi.waitFor(() => {
    flush();
    expect(container.querySelector(".x-replies__github")).toBeNull();
  });
  request.mockResolvedValueOnce(structuredClone(next));
  container.querySelector<HTMLButtonElement>("header button")!.click();
  await vi.waitFor(() => {
    flush();
    expect(container.querySelector(".x-replies__github")?.textContent).toContain(
      "@updated_contributor",
    );
  });
});

it("clears the previous account while switching and publishes only the accepted account", async () => {
  const initial = structuredClone(snapshot);
  initial.accounts.push({ accountId: "second", username: "second_bot" });
  const { container, request } = await mount(initial);
  const previousRow = container.querySelector(".x-replies__list tbody tr");
  const pending = Promise.withResolvers<XAllowlistSnapshot>();
  request.mockReturnValueOnce(pending.promise);
  const account = container.querySelector("select")!;
  account.value = "second";
  account.dispatchEvent(new Event("change", { bubbles: true }));
  expect(request).toHaveBeenLastCalledWith("x.allowlist.list", { accountId: "second" });
  flush();
  expect(container.querySelector(".x-replies__list tbody tr")).toBeNull();
  expect(account.disabled).toBe(true);
  const next = structuredClone(initial);
  next.accountId = "second";
  next.entries[0]!.username = "successor_maintainer";
  pending.resolve(next);
  await vi.waitFor(() => {
    flush();
    expect(container.textContent).toContain("@successor_maintainer");
    expect(account.disabled).toBe(false);
  });
  expect(account.value).toBe("second");
  expect(container.querySelector(".x-replies__list tbody tr")).not.toBe(previousRow);
  expect(container.textContent).not.toContain("@maintainer");
});

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
