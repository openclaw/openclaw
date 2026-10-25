import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createNonExitingRuntimeEnv,
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  disposePluginRegistryInstances,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import setupEntry from "../setup-entry.js";
import { zalouserPlugin } from "./channel.js";
import { getZalouserRuntime, setZalouserRuntime } from "./runtime.js";
import type { LoginQRCallbackEvent } from "./zca-client.js";

const createZaloMock = vi.hoisted(() => vi.fn());
const saveCredentialsMock = vi.hoisted(() =>
  vi.fn(
    async (
      _profile: string,
      _credentials: unknown,
      _env?: NodeJS.ProcessEnv,
      assertCurrent?: () => void,
    ) => {
      assertCurrent?.();
    },
  ),
);
// Only authentication/storage I/O is replaced. Registration, scoped runtime slots,
// channel call admission, cache reads, and instance retirement are production code.
vi.mock("./zca-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./zca-client.js")>()),
  createZalo: createZaloMock,
}));
vi.mock("./session-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-state.js")>()),
  loadStoredZaloCredentials: async (profile: string) => ({
    profile,
    imei: getZalouserRuntime().version,
    userAgent: "fixture",
    cookie: [],
    createdAt: "2026-10-01T00:00:00.000Z",
  }),
  clearStoredZaloCredentials: async () => true,
  saveStoredZaloCredentials: saveCredentialsMock,
  refreshStoredZaloCredentials: async (profile: string, credentials: object) => ({
    profile,
    ...credentials,
    createdAt: "2026-10-01T00:00:00.000Z",
  }),
}));
import {
  getZaloUserInfo,
  logoutZaloProfile,
  resolveZaloGroupContext,
  startZaloQrLogin,
} from "./zalo-js.js";

function register(version: string) {
  const builder = createPluginRegistry({
    runtime: createPluginRuntimeMock({ version }),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "zalouser", origin: "bundled" });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {}, registrationMode: "full" });
  const run = api.lifecycle.runInBackgroundContext!;
  run(() => {
    api.registerChannel({ plugin: zalouserPlugin });
    setZalouserRuntime(api.runtime);
    setupEntry.registerSetupRuntime?.(api);
  });
  return {
    run,
    self: () =>
      builder.registry.channels[0]!.plugin.directory!.self!({
        cfg: {},
        runtime: createNonExitingRuntimeEnv(),
      }),
    close: () => disposePluginRegistryInstances(builder.registry),
  };
}

function session(name: string) {
  return {
    listener: { stop: vi.fn() },
    getContext: () => ({ imei: name, userAgent: "fixture" }),
    getCookie: () => ({ toJSON: () => ({ cookies: [] }) }),
    fetchAccountInfo: vi.fn(async () => ({ userId: name, displayName: name })),
    getGroupInfo: vi.fn(async () => ({ gridInfoMap: { "123": { name } } })),
  };
}

it("keeps profile APIs and group results with their managed registration", async () => {
  const firstApi = session("first");
  const secondApi = session("second");
  createZaloMock.mockResolvedValue({
    login: async ({ imei }: { imei: string }) => (imei === "first" ? firstApi : secondApi),
  });
  const first = register("first");
  const second = register("second");
  try {
    expect(await first.self()).toMatchObject({ id: "first" });
    expect(await first.run(() => resolveZaloGroupContext("default", "123"))).toEqual({
      name: "first",
      members: undefined,
    });
    expect
      .soft(await second.run(() => resolveZaloGroupContext("default", "123")))
      .toEqual({ name: "second", members: undefined });
    expect(await second.self()).toMatchObject({ id: "second" });
    expect(await first.self()).toMatchObject({ id: "first" });
    expect(firstApi.getGroupInfo).toHaveBeenCalledOnce();
    expect(secondApi.getGroupInfo).toHaveBeenCalledOnce();
  } finally {
    await first.close();
    await second.close();
  }
});

it("finishes admitted channel work on the old API while another registration is prepared", async () => {
  const entered = createDeferred<void>();
  const finish = createDeferred<void>();
  const firstApi = session("admitted-first");
  const secondApi = session("admitted-second");
  createZaloMock.mockResolvedValue({
    login: async ({ imei }: { imei: string }) => (imei === "first" ? firstApi : secondApi),
  });
  const first = register("first");
  let second: ReturnType<typeof register> | undefined;
  let pending: ReturnType<typeof first.self> | undefined;
  let retirement: ReturnType<typeof first.close> | undefined;
  try {
    await first.self();
    firstApi.fetchAccountInfo.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      return { userId: "admitted-first", displayName: "admitted-first" };
    });
    pending = first.self();
    await entered.promise;
    second = register("second");
    expect(await second.self()).toMatchObject({ id: "admitted-second" });
    retirement = first.close();
    expect(await second.self()).toMatchObject({ id: "admitted-second" });
    expect(firstApi.listener.stop).not.toHaveBeenCalled();
    finish.resolve();
    expect(await pending).toMatchObject({ id: "admitted-first" });
    await retirement;
    expect(firstApi.listener.stop).toHaveBeenCalledOnce();
    expect(secondApi.listener.stop).not.toHaveBeenCalled();
    expect(() => first.self()).toThrow("reloaded or disabled");
    expect(await second.self()).toMatchObject({ id: "admitted-second" });
  } finally {
    finish.resolve();
    await pending;
    await retirement;
    await first.close();
    await second?.close();
  }
});

it("does not retire standalone session reuse with a managed registration", async () => {
  const standaloneApi = session("standalone");
  const managedApi = session("managed");
  createZaloMock.mockResolvedValue({
    login: async ({ imei }: { imei: string }) =>
      imei === "standalone" ? standaloneApi : managedApi,
  });
  setZalouserRuntime(createPluginRuntimeMock({ version: "standalone" }));
  const managed = register("managed");
  try {
    expect(await getZaloUserInfo()).toMatchObject({ userId: "standalone" });
    expect(await managed.self()).toMatchObject({ id: "managed" });
    await managed.close();
    expect(managedApi.listener.stop).toHaveBeenCalledOnce();
    expect(standaloneApi.listener.stop).not.toHaveBeenCalled();
    expect(await getZaloUserInfo()).toMatchObject({ userId: "standalone" });
  } finally {
    await managed.close();
    await logoutZaloProfile();
  }
});

it.each(["factory", "event"] as const)(
  "does not resume retired QR work after a delayed SDK %s",
  async (phase) => {
    vi.useFakeTimers();
    const first = register("qr-retiring");
    const entered = createDeferred<void>();
    const oldResult = createDeferred<ReturnType<typeof session>>();
    let oldCallback: ((event: LoginQRCallbackEvent) => unknown) | undefined;
    const oldLoginQR = vi.fn((_options: unknown, callback?: typeof oldCallback) => {
      oldCallback = callback;
      return oldResult.promise;
    });
    const factory = { loginQR: oldLoginQR };
    const created = createDeferred<typeof factory>();
    const oldAbort = vi.fn();
    const qrEvent = (abort: () => void): LoginQRCallbackEvent => ({
      type: 0,
      data: { code: "fixture-qr", image: "data:image/png;base64,ZmFrZQ==" },
      actions: { abort, retry() {}, saveToFile: async () => undefined },
    });
    const savedOwners: string[] = [];
    saveCredentialsMock.mockClear();
    saveCredentialsMock.mockImplementation(async (_profile, _credentials, _env, assertCurrent) => {
      assertCurrent?.();
      savedOwners.push(getZalouserRuntime().version);
    });
    createZaloMock.mockReset().mockImplementationOnce(() => {
      entered.resolve();
      return phase === "factory" ? created.promise : Promise.resolve(factory);
    });
    let current: ReturnType<typeof register> | undefined;
    let start: ReturnType<typeof startZaloQrLogin> | undefined;
    try {
      start = first.run(() => startZaloQrLogin({ force: true, timeoutMs: 3000 }));
      await entered.promise;
      await vi.advanceTimersByTimeAsync(3000);
      expect((await start).message).toBe(
        "Still preparing QR. Call wait to continue checking login status.",
      );
      await first.close();

      // A fresh managed replacement and a standalone caller must still be able
      // to complete QR login while the old SDK work is suspended.
      const owner = phase === "factory" ? "qr-replacement" : "qr-standalone";
      if (phase === "factory") {
        current = register(owner);
      } else {
        setZalouserRuntime(createPluginRuntimeMock({ version: owner }));
      }
      createZaloMock.mockResolvedValue({
        loginQR: async (_options: unknown, callback?: (event: LoginQRCallbackEvent) => unknown) => {
          callback?.(qrEvent(vi.fn()));
          return session(owner);
        },
      });
      const next = current
        ? current.run(() => startZaloQrLogin({ force: true, timeoutMs: 3000 }))
        : startZaloQrLogin({ force: true, timeoutMs: 3000 });
      await vi.advanceTimersByTimeAsync(150);
      await next;

      if (phase === "factory") {
        created.resolve(factory);
      } else {
        expect(oldCallback).toBeTypeOf("function");
        oldCallback?.(qrEvent(oldAbort));
      }
      oldResult.resolve(session("qr-retired"));
      await vi.advanceTimersByTimeAsync(0);
      if (phase === "factory") {
        expect.soft(oldLoginQR).not.toHaveBeenCalled();
      } else {
        expect.soft(oldAbort).toHaveBeenCalledOnce();
      }
      expect(savedOwners).toEqual([owner]);
      const info = current ? await current.self() : await getZaloUserInfo();
      expect(info).toMatchObject(current ? { id: owner } : { userId: owner });
    } finally {
      created.resolve(factory);
      oldResult.resolve(session("qr-retired"));
      await vi.advanceTimersByTimeAsync(3000);
      await start;
      await first.close();
      await current?.close();
      if (phase === "event") {
        await logoutZaloProfile();
      }
      vi.useRealTimers();
    }
  },
);
