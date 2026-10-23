import type {
  ControlUiChannelSettingsContext as SettingsContext,
  ControlUiChannelSettingsSnapshot,
} from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { flush } from "solid-js";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { settingsViews } from "./index.tsx";

const emptyLogin = { message: null, qrDataUrl: null, connected: null, busy: false };
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
    login: emptyLogin,
    ...patch,
  };
  const abort = new AbortController();
  const unavailable = () => assert.fail("WhatsApp uses native Settings markup");
  const logout = vi.fn<() => Promise<void>>().mockResolvedValue();
  const configDispose = vi.fn();
  const context = {
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
    mountConfig: vi.fn(() => configDispose),
    refresh: vi.fn().mockResolvedValue(undefined),
    formatRelativeTimestamp: () => "recently",
    formatError: String,
    formatExternalText: String,
    confirm: vi.fn<NonNullable<SettingsContext["confirm"]>>().mockResolvedValue(false),
    login: {
      start: vi.fn<(force: boolean) => Promise<void>>().mockResolvedValue(),
      wait: vi.fn<() => Promise<void>>().mockResolvedValue(),
      captureLogout: () => ({ accountId: "work/account", logout }),
    },
  } satisfies SettingsContext;
  const container = document.body.appendChild(document.createElement("div"));
  const mounted = settingsViews[0]!.mount(container, context);
  onTestFinished(() => {
    abort.abort();
    mounted.dispose();
    container.remove();
  });
  flush();
  const buttons = () => [...container.querySelectorAll("button")];
  const rows = () => [...container.querySelectorAll("dt")];
  return {
    ...context,
    ...context.login,
    container,
    buttons,
    button: (label: string) =>
      buttons().find((node) => node.textContent?.trim() === label) ??
      assert.fail(`Missing ${label}`),
    expectFacts(expected: Record<string, string>) {
      const facts = rows().map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
      expect(Object.fromEntries(facts)).toMatchObject(expected);
    },
    logout,
    configDispose,
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
  const qrLogin = { ...emptyLogin, message: "Scan now", qrDataUrl: "data:image/png,qr" };
  expect(f.buttons().map((node) => node.textContent)).toEqual(["Show QR", "Logout", "Refresh"]);
  expect(f.button("Show QR").classList.contains("primary")).toBe(true);
  f.button("Show QR").click();
  expect(f.start).toHaveBeenCalledWith(false);
  f.update({ status: { linked: true }, login: qrLogin });
  expect(f.container.querySelector("img")?.getAttribute("alt")).toBe("WhatsApp QR");
  expect(f.container.querySelector('[role="status"]')?.textContent).toBe("Scan now");
  f.button("Relink").click();
  expect(f.start).toHaveBeenLastCalledWith(true);
  f.button("Wait for scan").click();
  expect(f.wait).toHaveBeenCalledOnce();
  f.update({ login: { ...qrLogin, message: null, busy: true } });
  for (const label of ["Relink", "Wait for scan", "Logout"]) {
    expect(f.button(label).disabled).toBe(true);
  }
});

it("uses the declared default account for configured fallback and keeps absent status booleans false", () => {
  const configuredAccount = { accountId: "selected", configured: true };
  const f = fixture({
    accounts: [{ accountId: "first", configured: false }, configuredAccount],
    defaultAccountId: "selected",
  });
  f.expectFacts({ Configured: "Yes", Linked: "No", Running: "No", Connected: "No" });
  expect(f.container.querySelector(".settings-count")?.textContent).toBe("2");
  f.update({ status: { configured: false } });
  f.expectFacts({ Configured: "No" });
  f.update({
    status: {},
    defaultAccountId: "missing",
    accounts: [configuredAccount],
  });
  f.expectFacts({ Configured: "Yes" });
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

it("ignores a superseded refresh failure and keeps command errors retryable", async () => {
  const f = fixture();
  const older = createDeferred<void>();
  const newer = createDeferred<void>();
  f.refresh.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
  const refresh = f.button("Refresh");
  refresh.click();
  refresh.click();
  newer.resolve();
  await newer.promise;
  older.reject(new Error("Superseded refresh failed"));
  await older.promise.catch(() => undefined);
  flush();
  expect(f.container.textContent).not.toContain("Superseded refresh failed");

  f.refresh.mockRejectedValueOnce(new Error("Current refresh failed"));
  refresh.click();
  await vi.waitFor(() => {
    flush();
    expect(f.container.textContent).toContain("Current refresh failed");
  });
  const retry = createDeferred<void>();
  f.refresh.mockReturnValueOnce(retry.promise);
  refresh.click();
  flush();
  expect(f.container.textContent).not.toContain("Current refresh failed");
  expect(f.button("Refresh")).toBe(refresh);
  retry.resolve();
  await retry.promise;
  flush();
  expect(f.container.textContent).not.toContain("Current refresh failed");
  f.update({ status: { lastError: "Gateway is disconnected" } });
  expect(f.container.querySelector(".settings-row__desc")?.textContent).toBe(
    "Gateway is disconnected",
  );
});

it("updates translated labels and disposes the host configuration slot without resetting login", () => {
  const f = fixture();
  expect(f.mountConfig).toHaveBeenCalledOnce();
  f.update({ locale: "de" });
  expect(f.container.textContent).not.toContain("Link WhatsApp Web and monitor connection health.");
  f.dispose();
  expect(f.configDispose).toHaveBeenCalledOnce();
  expect([f.start, f.wait, f.logout].map((mock) => mock.mock.calls)).toEqual([[], [], []]);
});
