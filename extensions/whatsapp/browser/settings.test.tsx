import type {
  ControlUiChannelSettingsContext as Context,
  ControlUiChannelSettingsSnapshot as Snapshot,
} from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { flush } from "solid-js";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { settingsViews } from "./index.tsx";

const emptyLogin = { message: null, qrDataUrl: null, connected: null, busy: false };
const qrLogin = { ...emptyLogin, message: "Scan now", qrDataUrl: "data:image/png,qr" };
const settle = (check: () => void) =>
  vi.waitFor(() => {
    flush();
    check();
  });
function fixture(patch: Partial<Snapshot> = {}) {
  let snapshot: Snapshot = {
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
    formatPhoneNumber: (phone) => phone,
    formatError: String,
    formatExternalText: String,
    confirm: vi.fn<NonNullable<Context["confirm"]>>().mockResolvedValue(false),
    login: {
      start: vi.fn<(force: boolean) => Promise<void>>().mockResolvedValue(),
      wait: vi.fn<() => Promise<void>>().mockResolvedValue(),
      captureLogout: () => ({ accountId: "work/account", logout }),
    },
  } satisfies Context;
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
    retainNodes(selector: string) {
      const query = () => [...container.querySelectorAll(selector)];
      const original = query();
      return (inserted: (Element | null | undefined)[] = []) => {
        const current = query().filter((node) => !inserted.includes(node));
        expect(current).toHaveLength(original.length);
        current.forEach((node, index) => expect(node).toBe(original[index]));
      };
    },
    button: (label: string) =>
      buttons().find((node) => node.textContent?.trim() === label) ?? assert.fail("Missing button"),
    expectFacts(expected: Record<string, string>) {
      const facts = rows().map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
      expect(Object.fromEntries(facts)).toMatchObject(expected);
    },
    logout,
    configDispose,
    update(nextPatch: Partial<Snapshot>) {
      snapshot = { ...snapshot, ...nextPatch };
      mounted.update(snapshot);
      flush();
    },
    dispose: mounted.dispose,
  };
}
it("keeps QR/relink actions and busy state tied to the shared login snapshot", () => {
  const f = fixture();
  expect(f.button("Show QR").classList.contains("primary")).toBe(true);
  f.button("Show QR").click();
  expect(f.start).toHaveBeenCalledWith(false);
  f.update({ status: { linked: true }, login: qrLogin });
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
it("retains localized rows and login controls until the configuration slot is disposed", async () => {
  const f = fixture({ login: qrLogin, locale: "de" });
  await settle(() => f.expectFacts({ Konfiguriert: "k. A." }));
  const expectOriginal = f.retainNodes("dt, dd, button, img");
  const qr = f.container.querySelector("img");
  f.update({ locale: "en", status: { configured: true, running: true } });
  expectOriginal();
  f.expectFacts({ Configured: "Yes", Running: "Yes" });
  f.update({ status: { configured: true, running: true, self: { e164: "+15555550123" } } });
  const phone = f.container.querySelector("dt:nth-of-type(3)");
  expect(phone?.nextElementSibling?.textContent).toBe("+15555550123");
  expectOriginal([phone, phone?.nextElementSibling]);
  const expectWithPhone = f.retainNodes("dt, dd, button, img");
  for (const [locale, facts, alt] of [
    ["de", { Konfiguriert: "Ja", Läuft: "Ja", Telefonnummer: "+15555550123" }, "WhatsApp-QR"],
    ["en", { Configured: "Yes", Running: "Yes" }, "WhatsApp QR"],
  ] as const) {
    f.update({ locale });
    await settle(() => f.expectFacts(facts));
    expectWithPhone();
    expect(qr?.getAttribute("alt")).toBe(alt);
  }
  expect(qr?.getAttribute("src")).toBe(qrLogin.qrDataUrl);
  expect(f.mountConfig).toHaveBeenCalledOnce();
  f.update({ status: { configured: true, running: true } });
  expect(phone?.isConnected).toBe(false);
  expectOriginal();
  f.dispose();
  expect(f.configDispose).toHaveBeenCalledOnce();
  expect([f.start, f.wait, f.logout].map((mock) => mock.mock.calls)).toEqual([[], [], []]);
});
it("requires the operator's confirmation before invoking the captured account logout", async () => {
  const f = fixture();
  f.button("Logout").click();
  await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
  expect(f.confirm.mock.lastCall?.[0]).toMatchObject({
    title: expect.stringContaining("work/account"),
    message: expect.stringMatching(/work\/account.*listener.*credentials/),
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
  f.refresh.mockReturnValueOnce(older.promise);
  const refresh = f.button("Refresh");
  refresh.click();
  refresh.click();
  await Promise.resolve();
  older.reject(new Error("Superseded refresh failed"));
  await older.promise.catch(() => undefined);
  flush();
  expect(f.container.textContent).not.toContain("Superseded refresh failed");
  f.refresh.mockRejectedValueOnce(new Error("Current refresh failed"));
  refresh.click();
  await settle(() => expect(f.container.textContent).toContain("Current refresh failed"));
  refresh.click();
  flush();
  expect(f.container.textContent).not.toContain("Current refresh failed");
  expect(f.button("Refresh")).toBe(refresh);
  await Promise.resolve();
  flush();
  expect(f.container.textContent).not.toContain("Current refresh failed");
  f.update({ status: { lastError: "Gateway is disconnected" } });
  expect(f.container.querySelector(".settings-row__desc")?.textContent).toBe(
    "Gateway is disconnected",
  );
});
