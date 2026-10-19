import type {
  ControlUiChannelSettingsContext,
  ControlUiChannelSettingsSnapshot,
} from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { settingsViews } from "./index.tsx";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  document.body.replaceChildren();
});
function fixture(patch: Partial<ControlUiChannelSettingsSnapshot> = {}) {
  let snapshot: ControlUiChannelSettingsSnapshot = {
    channelId: "whatsapp",
    status: {},
    accounts: [],
    connected: true,
    canAdmin: true,
    connectionEpoch: 1,
    locale: "en",
    presented: true,
    login: { message: null, qrDataUrl: null, connected: null, busy: false },
    ...patch,
  };
  const abort = new AbortController();
  const unavailable = () => {
    throw new Error("WhatsApp uses native Settings markup");
  };
  const start = vi.fn<(force: boolean) => Promise<void>>().mockResolvedValue();
  const wait = vi.fn<() => Promise<void>>().mockResolvedValue();
  const logout = vi.fn<() => Promise<void>>().mockResolvedValue();
  const confirm = vi
    .fn<NonNullable<ControlUiChannelSettingsContext["confirm"]>>()
    .mockResolvedValue(false);
  const configDispose = vi.fn();
  const mountConfig = vi.fn(() => configDispose);
  const formatPhoneNumber = vi.fn((value: string) => `display:${value}`);
  const context: ControlUiChannelSettingsContext = {
    signal: abort.signal,
    props: snapshot,
    components: {
      mountSection: unavailable,
      mountRow: unavailable,
      mountStatus: unavailable,
      mountValue: unavailable,
      mountNavigation: unavailable,
      mountLobster: unavailable,
    },
    request: unavailable,
    mountConfig,
    refresh: vi.fn().mockResolvedValue(undefined),
    formatRelativeTimestamp: () => "recently",
    formatError: String,
    formatExternalText: String,
    formatPhoneNumber,
    formatDuration: () => "1m",
    confirm,
    login: { start, wait, captureLogout: () => ({ accountId: "work/account", logout }) },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const mounted = settingsViews[0]!.mount(container, context);
  cleanups.push(() => {
    abort.abort();
    mounted.dispose();
  });
  flush();
  const button = (label: string) => {
    const node = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!node) {
      throw new Error(`Missing ${label}`);
    }
    return node;
  };
  const fact = (label: string) =>
    [...container.querySelectorAll("dt")].find((node) => node.textContent === label)
      ?.nextElementSibling?.textContent;
  return {
    container,
    button,
    fact,
    start,
    wait,
    logout,
    confirm,
    mountConfig,
    configDispose,
    formatPhoneNumber,
    update(nextPatch: Partial<ControlUiChannelSettingsSnapshot>) {
      snapshot = { ...snapshot, ...nextPatch };
      mounted.update(snapshot);
      flush();
    },
    dispose: mounted.dispose,
  };
}

it("keeps QR/relink actions and busy state tied to the shared login snapshot", () => {
  const f = fixture();
  expect([...f.container.querySelectorAll("button")].map((node) => node.textContent)).toEqual([
    "Show QR",
    "Logout",
    "Refresh",
  ]);
  expect(f.button("Show QR").classList.contains("primary")).toBe(true);
  f.button("Show QR").click();
  expect(f.start).toHaveBeenCalledWith(false);
  f.update({
    status: { linked: true },
    login: {
      message: "Scan now",
      qrDataUrl: "data:image/png;base64,fixture",
      busy: false,
      connected: false,
    },
  });
  expect(f.container.querySelector("img")?.getAttribute("alt")).toBe("WhatsApp QR");
  expect(f.container.querySelector('[role="status"]')?.textContent).toBe("Scan now");
  f.button("Relink").click();
  expect(f.start).toHaveBeenLastCalledWith(true);
  f.button("Wait for scan").click();
  expect(f.wait).toHaveBeenCalledOnce();
  f.update({
    login: {
      message: null,
      qrDataUrl: "data:image/png;base64,fixture",
      busy: true,
      connected: null,
    },
  });
  for (const label of ["Relink", "Wait for scan", "Logout"]) {
    expect(f.button(label).disabled).toBe(true);
  }
});

it("uses the declared default account for configured fallback and keeps absent status booleans false", () => {
  const f = fixture({
    accounts: [
      { accountId: "first", configured: false },
      { accountId: "selected", configured: true },
    ],
    defaultAccountId: "selected",
  });
  expect(f.fact("Configured")).toBe("Yes");
  for (const label of ["Linked", "Running", "Connected"]) {
    expect(f.fact(label)).toBe("No");
  }
  expect(f.container.querySelector(".settings-count")?.textContent).toBe("2");
  f.update({ status: { configured: false } });
  expect(f.fact("Configured")).toBe("No");
  f.update({
    status: {},
    defaultAccountId: "missing",
    accounts: [{ accountId: "first", configured: true }],
  });
  expect(f.fact("Configured")).toBe("Yes");
  expect(f.container.querySelector(".settings-count")).toBeNull();
});

it("requires the operator's confirmation before invoking the captured account logout", async () => {
  const f = fixture();
  f.button("Logout").click();
  await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
  expect(f.confirm).toHaveBeenCalledWith({
    title: "Log out of WhatsApp account work/account?",
    message:
      "Logging out of account work/account stops its listener and deletes its saved credentials.",
    confirmLabel: "Logout",
    danger: true,
  });
  expect(f.logout).not.toHaveBeenCalled();
  const decision = createDeferred<boolean>();
  f.confirm.mockReturnValueOnce(decision.promise);
  f.button("Logout").click();
  expect(f.logout).not.toHaveBeenCalled();
  decision.resolve(true);
  await vi.waitFor(() => expect(f.logout).toHaveBeenCalledOnce());
});

it("updates translated labels and disposes the host configuration slot without resetting login", () => {
  const f = fixture();
  expect(f.mountConfig).toHaveBeenCalledOnce();
  f.update({ locale: "de" });
  expect(f.container.textContent).not.toContain("Link WhatsApp Web and monitor connection health.");
  f.dispose();
  expect(f.configDispose).toHaveBeenCalledOnce();
  expect(f.start).not.toHaveBeenCalled();
  expect(f.wait).not.toHaveBeenCalled();
  expect(f.logout).not.toHaveBeenCalled();
});
