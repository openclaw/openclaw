import type { ExtensionHostSession } from "openclaw/plugin-sdk/browser-extension-host";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserAutofillExtension } from "./autofill-browser.js";

const authority = { assertCurrent() {} };
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
    await s.adapter.fillCredential(
      {
        ...credentials,
        resourcePath: "private-reference",
        tab: { targetId: "tab", profile: "owner" },
      },
      authority,
    ),
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
    await s.adapter.fillCredential(
      {
        ...credentials,
        resourcePath: "reference",
        tab: { targetId: "tab", profile: "other" },
      },
      authority,
    ),
  ).toMatchObject({ success: false, error: { code: "invalidTabId" } });
  await s.adapter.close();
});

it("reports an observed browser instead of an unready extension, without filling", async () => {
  const s = setup();
  s.session.withExclusiveTab = async () => {
    throw Object.assign(new Error("Stop browser screencasts and traces"), { code: "tabObserved" });
  };
  expect(
    await s.adapter.fillCredential(
      { ...credentials, resourcePath: "reference", tab: { targetId: "tab", profile: "owner" } },
      authority,
    ),
  ).toEqual({ success: false, error: { code: "browserObserved" } });
  expect(s.worker.agenticAutofill.v1.fillCredential).not.toHaveBeenCalled();
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
    await s.adapter.createAccessRequest(
      {
        ...credentials,
        requests: { version: 2, goal: "test", entries: [] },
      },
      authority,
    ),
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
    await s.adapter.createAccessRequest(
      {
        ...credentials,
        requests: { version: 2, goal: "test", entries: [] },
      },
      authority,
    ),
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
    await s.adapter.fillCredential(
      {
        ...credentials,
        resourcePath: "opaque",
        tab: { targetId: "tab" },
      },
      authority,
    ),
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

it("renews failed attachments and lost sessions without retrying an uncertain request", async () => {
  const s = setup();
  s.registration.openSession.mockRejectedValueOnce(new Error("worker unavailable"));
  expect((await s.adapter.readiness()).success).toBe(false);
  expect((await s.adapter.readiness()).success).toBe(true);
  const call = vi.spyOn(s.session, "callInServiceWorker");
  call.mockRejectedValueOnce(new Error("worker disconnected"));
  expect((await s.adapter.readiness()).success).toBe(false);
  expect((await s.adapter.readiness()).success).toBe(true);
  s.worker.agenticAutofill.v1.createAccessRequest.mockRejectedValueOnce(new Error("uncertain"));
  expect(
    (
      await s.adapter.createAccessRequest(
        {
          ...credentials,
          requests: { version: 2, goal: "test", entries: [] },
        },
        authority,
      )
    ).success,
  ).toBe(false);
  expect(s.worker.agenticAutofill.v1.createAccessRequest).toHaveBeenCalledOnce();
  expect((await s.adapter.readiness()).success).toBe(true);
  expect(s.registration.openSession).toHaveBeenCalledTimes(4);
  await s.adapter.close();
});

it("does not close an active fill when another caller cannot enter its profile", async () => {
  const s = setup();
  const filling = createDeferred<void>();
  const finish = createDeferred<void>();
  s.worker.agenticAutofill.v1.fillCredential.mockImplementationOnce(async () => {
    filling.resolve();
    await finish.promise;
    return fill;
  });
  const operation = s.adapter.fillCredential(
    {
      ...credentials,
      resourcePath: "opaque",
      tab: { targetId: "tab" },
    },
    authority,
  );
  await filling.promise;
  vi.spyOn(s.session, "callInServiceWorker").mockRejectedValueOnce(new Error("profile busy"));
  expect((await s.adapter.readiness()).success).toBe(false);
  expect(s.sessionClose).not.toHaveBeenCalled();
  const busyClose = vi.fn(async () => {});
  s.registration.openSession.mockResolvedValueOnce({
    ...s.session,
    callInServiceWorker: vi.fn(async () => {
      throw new Error("profile busy");
    }),
    close: busyClose,
  });
  expect((await s.adapter.readiness()).success).toBe(false);
  expect(busyClose).toHaveBeenCalledOnce();
  expect(s.sessionClose).not.toHaveBeenCalled();
  finish.resolve();
  expect(await operation).toEqual(fill);
  expect(s.sessionClose).toHaveBeenCalledOnce();
  await s.adapter.close();
});

it("does not discard a new attachment when an old overlapping call fails late", async () => {
  const s = setup();
  const first = createDeferred<never>();
  const second = createDeferred<never>();
  const entered = createDeferred<void>();
  const call = vi.spyOn(s.session, "callInServiceWorker");
  call
    .mockImplementationOnce(async () => await first.promise)
    .mockImplementationOnce(async () => {
      entered.resolve();
      return await second.promise;
    });
  const a = s.adapter.readiness();
  const b = s.adapter.readiness();
  await entered.promise;
  first.reject(new Error("lost"));
  expect((await a).success).toBe(false);
  const replacement = { ...s.session, close: vi.fn(async () => {}) };
  s.registration.openSession.mockResolvedValueOnce(replacement);
  expect((await s.adapter.readiness()).success).toBe(true);
  second.reject(new Error("late loss"));
  expect((await b).success).toBe(false);
  expect((await s.adapter.readiness()).success).toBe(true);
  expect(s.registration.openSession).toHaveBeenCalledTimes(2);
  expect(replacement.close).not.toHaveBeenCalled();
  await s.adapter.close();
});

it.each(["register", "attach", "initialize", "resolve", "enable"] as const)(
  "rejects canceled and revoked fills during %s and releases the tab",
  async (step) => {
    for (const reason of ["cancel", "revoke"] as const) {
      const s = setup();
      const entered = createDeferred<void>();
      const resume = createDeferred<void>();
      const controller = new AbortController();
      let current = true;
      const invocation = {
        signal: controller.signal,
        assertCurrent() {
          if (!current) {
            throw new Error("revoked");
          }
        },
      };
      const pause = async () => {
        entered.resolve();
        await resume.promise;
      };
      if (step === "register") {
        s.register.mockImplementationOnce(async () => {
          await pause();
          return s.registration;
        });
      }
      if (step === "attach") {
        s.registration.openSession.mockImplementationOnce(async () => {
          await pause();
          return s.session;
        });
      }
      if (step === "initialize") {
        s.worker.initialization.v1.whenSettled.mockImplementationOnce(async () => {
          await pause();
          return "ready";
        });
      }
      if (step === "resolve") {
        vi.spyOn(s.session, "resolveChromeTabId").mockImplementationOnce(async () => {
          await pause();
          return 42;
        });
      }
      if (step === "enable") {
        s.worker.agenticMode.v1.enable.mockImplementationOnce(async () => {
          await pause();
          return { success: true };
        });
      }
      const filling = s.adapter.fillCredential(
        { ...credentials, resourcePath: "opaque", tab: { targetId: "tab" } },
        invocation,
      );
      await entered.promise;
      if (reason === "cancel") {
        controller.abort();
      } else {
        current = false;
      }
      resume.resolve();
      expect((await filling).success).toBe(false);
      expect(s.worker.agenticAutofill.v1.fillCredential).not.toHaveBeenCalled();
      expect(s.worker.agenticMode.v1.disable).toHaveBeenCalledTimes(step === "enable" ? 1 : 0);
      if (step === "resolve" || step === "enable") {
        expect(s.events.at(-1)).toBe("unlock");
      }
      await s.adapter.close();
    }
  },
);

it("rejects request creation when invocation authority is lost during initialization", async () => {
  const s = setup();
  const controller = new AbortController();
  s.worker.initialization.v1.whenSettled.mockImplementationOnce(async () => {
    controller.abort();
    return "ready";
  });
  expect(
    (
      await s.adapter.createAccessRequest(
        { ...credentials, requests: { version: 2, goal: "test", entries: [] } },
        { ...authority, signal: controller.signal },
      )
    ).success,
  ).toBe(false);
  expect(s.worker.agenticAutofill.v1.createAccessRequest).not.toHaveBeenCalled();
  await s.adapter.close();
});
