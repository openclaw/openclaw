import type { ExtensionHostSession } from "openclaw/plugin-sdk/browser-extension-host";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserAutofillExtension } from "./autofill-browser.js";

const credentials = { accessToken: "synthetic-access", integrationKey: "synthetic-key" };
const pending = { success: true, result: { path: "status", state: "pending", resolved: [] } };
const fill = { success: true, result: { status: "fill_submitted" } };

function setup() {
  const events: string[] = [];
  const calls: Array<{ source: string; args: unknown }> = [];
  let locked = false;
  const worker = {
    initialization: { v1: { whenSettled: vi.fn(async () => "ready") } },
    agenticMode: {
      v1: {
        enable: vi.fn(async () => {
          expect(locked).toBe(true);
          events.push("enable");
          return { success: true };
        }),
        disable: vi.fn(async () => {
          expect(locked).toBe(true);
          events.push("disable");
          return { success: true };
        }),
      },
    },
    agenticAutofill: {
      v1: {
        createAccessRequest: vi.fn(async (): Promise<unknown> => ({
          success: false,
          error: { code: "invalidRequest" },
        })),
        getAccessRequestStatus: vi.fn(async (): Promise<unknown> => pending),
        fillCredential: vi.fn(async () => {
          expect(locked).toBe(true);
          events.push("fill");
          return fill;
        }),
      },
    },
  };
  vi.stubGlobal("api", worker);
  const sessionClose = vi.fn(async () => {});
  const session: ExtensionHostSession = {
    async callInServiceWorker(fn, args) {
      calls.push({ source: fn.toString(), args });
      return await fn(args);
    },
    async resolveChromeTabId() {
      expect(locked).toBe(true);
      events.push("resolve");
      return 42;
    },
    async withExclusiveTab(_tab, fn) {
      events.push("lock");
      locked = true;
      try {
        return await fn();
      } finally {
        locked = false;
        events.push("unlock");
      }
    },
    close: sessionClose,
  };
  const registration = { openSession: vi.fn(async () => session), close: vi.fn(async () => {}) };
  const register = vi.fn(async () => registration);
  const adapter = new BrowserAutofillExtension(
    { extensionPath: "/vetted/nightly", browserProfile: "owner" },
    register,
  );
  return { adapter, register, registration, session, sessionClose, worker, calls, events };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("reserves before launch and reuses the worker across the polling window, closing both owners", async () => {
  vi.useFakeTimers();
  const s = setup();
  await s.adapter.start();
  expect(s.registration.openSession).not.toHaveBeenCalled();
  expect(s.register).toHaveBeenCalledWith({
    profile: "owner",
    principal: "onepassword:gateway-owner",
    extension: {
      id: "gejiddohjgogedgjnonbofjigllpkmbf",
      unpackedPath: "/vetted/nightly",
      minimumVersion: "8.12.46.6",
    },
  });
  for (const delay of [0, 31_000, 60_000, 29_000]) {
    await vi.advanceTimersByTimeAsync(delay);
    expect(
      await s.adapter.getAccessRequestStatus({ ...credentials, accessRequestUUID: "request" }),
    ).toEqual(pending);
  }
  expect(s.registration.openSession).toHaveBeenCalledTimes(1);
  expect(s.worker.initialization.v1.whenSettled).toHaveBeenCalledTimes(4);
  await s.adapter.close();
  expect(s.sessionClose).toHaveBeenCalledOnce();
  expect(s.registration.close).toHaveBeenCalledOnce();
  expect((await s.adapter.readiness()).success).toBe(false);
});

it("passes secrets only as arguments and locks mapping, mode, fill, and release together", async () => {
  const s = setup();
  expect(
    await s.adapter.fillCredential({
      ...credentials,
      resourcePath: "private-reference",
      tab: { targetId: "tab", profile: "owner" },
    }),
  ).toEqual(fill);
  expect(s.events).toEqual(["lock", "resolve", "enable", "fill", "disable", "unlock"]);
  expect(s.worker.agenticAutofill.v1.fillCredential).toHaveBeenCalledWith({
    ...credentials,
    resourcePath: "private-reference",
    tabId: 42,
  });
  for (const secret of [...Object.values(credentials), "private-reference"]) {
    expect(s.calls.map(({ source }) => source).join("\n")).not.toContain(secret);
  }
  expect(
    await s.adapter.fillCredential({
      ...credentials,
      resourcePath: "reference",
      tab: { targetId: "tab", profile: "other" },
    }),
  ).toMatchObject({ success: false, error: { code: "invalidTabId" } });
  await s.adapter.close();
});

it.each([
  null,
  {},
  { success: true, result: { state: "pending" } },
  { success: false, error: { code: 123 } },
])("rejects malformed worker results with a fixed internal envelope: %j", async (value) => {
  const s = setup();
  s.worker.agenticAutofill.v1.getAccessRequestStatus.mockResolvedValue(value);
  expect(
    await s.adapter.getAccessRequestStatus({ ...credentials, accessRequestUUID: "request" }),
  ).toEqual({ success: false, error: { code: "internal" } });
  await s.adapter.close();
});

it("does not call autofill when initialization fails or the API is absent", async () => {
  const s = setup();
  s.worker.initialization.v1.whenSettled.mockResolvedValue("failed");
  expect(
    await s.adapter.createAccessRequest({
      ...credentials,
      requests: { version: 2, goal: "test", entries: [] },
    }),
  ).toEqual({ success: false, error: { code: "extensionNotReady" } });
  expect(s.worker.agenticAutofill.v1.createAccessRequest).not.toHaveBeenCalled();
  s.worker.initialization.v1.whenSettled.mockResolvedValue("ready");
  vi.stubGlobal("api", { initialization: s.worker.initialization });
  expect((await s.adapter.readiness()).success).toBe(false);
  await s.adapter.close();
});

it("normalizes documented omitted version and null unrequested entry IDs", async () => {
  const s = setup();
  s.worker.agenticAutofill.v1.createAccessRequest.mockResolvedValue({
    success: true,
    result: {
      accessRequest: {
        id: "r",
        path: "request",
        identity: "identity",
        state: "pending",
        createdAt: "date",
        goal: "test",
        entries: [],
      },
      appLink: "onepassword://synthetic-approval",
    },
  });
  expect(
    await s.adapter.createAccessRequest({
      ...credentials,
      requests: { version: 2, goal: "test", entries: [] },
    }),
  ).toMatchObject({ success: true, result: { accessRequest: { version: 2 } } });
  s.worker.agenticAutofill.v1.getAccessRequestStatus.mockResolvedValue({
    success: true,
    result: {
      path: "status",
      state: "resolved",
      resolved: [{ entryId: null, reference: "opaque" }],
    },
  });
  expect(
    await s.adapter.getAccessRequestStatus({ ...credentials, accessRequestUUID: "request" }),
  ).toMatchObject({
    success: true,
    result: { resolved: [{ entryId: undefined, reference: "opaque" }] },
  });
  await s.adapter.close();
});

it("never fills after failed mode enable and never reflects host errors", async () => {
  const s = setup();
  s.worker.agenticMode.v1.enable.mockResolvedValueOnce({ success: false } as { success: boolean });
  expect(
    await s.adapter.fillCredential({
      ...credentials,
      resourcePath: "opaque",
      tab: { targetId: "tab" },
    }),
  ).toEqual({ success: false, error: { code: "internal" } });
  expect(s.worker.agenticAutofill.v1.fillCredential).not.toHaveBeenCalled();
  const bad = new BrowserAutofillExtension(
    { extensionPath: "/missing", browserProfile: "owner" },
    async () => {
      throw new Error("synthetic-private-host-error");
    },
  );
  expect(await bad.readiness()).toEqual({ success: false, error: { code: "extensionNotReady" } });
  await s.adapter.close();
  await bad.close();
});
