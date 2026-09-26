import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

type StorageKind = "local" | "session";

const routeState = vi.hoisted(() => {
  const storage = { local: new Map<string, string>(), session: new Map<string, string>() };
  return {
    driver: "openclaw",
    cookiesGetViaPlaywright: vi.fn(async () => ({ cookies: [] })),
    cookiesSetManyViaPlaywright: vi.fn(async () => ({ added: 2 })),
    setDeviceViaPlaywright: vi.fn(async () => {}),
    setHttpCredentialsViaPlaywright: vi.fn(async () => {}),
    storage,
    storageGetViaPlaywright: vi.fn(async ({ kind, key }: { kind: StorageKind; key?: string }) => ({
      values: Object.fromEntries(
        [...storage[kind]].filter(([storedKey]) => key === undefined || storedKey === key),
      ),
    })),
    storageSetViaPlaywright: vi.fn(
      async ({ kind, key, value }: { kind: StorageKind; key: string; value: string }) => {
        storage[kind].set(key, value);
      },
    ),
    storageClearViaPlaywright: vi.fn(async ({ kind }: { kind: StorageKind }) => {
      storage[kind].clear();
    }),
    withPlaywrightRouteContext: vi.fn(),
  };
});

vi.mock("./agent.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent.shared.js")>()),
  resolveProfileContext: () => ({ profile: { driver: routeState.driver } }),
  withPlaywrightRouteContext: routeState.withPlaywrightRouteContext,
}));

const { registerBrowserAgentStorageRoutes } = await import("./agent.storage.js");

type PlaywrightRouteParams = {
  req: BrowserRequest;
  run: (ctx: {
    cdpUrl: string;
    tab: { targetId: string };
    signal: AbortSignal;
    pw: {
      cookiesGetViaPlaywright: typeof routeState.cookiesGetViaPlaywright;
      cookiesSetManyViaPlaywright: typeof routeState.cookiesSetManyViaPlaywright;
      setDeviceViaPlaywright: typeof routeState.setDeviceViaPlaywright;
      setHttpCredentialsViaPlaywright: typeof routeState.setHttpCredentialsViaPlaywright;
      storageGetViaPlaywright: typeof routeState.storageGetViaPlaywright;
      storageSetViaPlaywright: typeof routeState.storageSetViaPlaywright;
      storageClearViaPlaywright: typeof routeState.storageClearViaPlaywright;
    };
  }) => Promise<unknown>;
};

function getPostHandler(route: string) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAgentStorageRoutes(app, {} as never);
  const handler = postHandlers.get(route);
  expect(handler).toBeTypeOf("function");
  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  routeState.driver = "openclaw";
  routeState.storage.local.clear();
  routeState.storage.session.clear();
  routeState.withPlaywrightRouteContext
    .mockReset()
    .mockImplementation(async (params: PlaywrightRouteParams) => {
      await params.run({
        cdpUrl: "http://127.0.0.1:18800",
        tab: { targetId: "tab-1" },
        signal: params.req.signal ?? new AbortController().signal,
        pw: routeState,
      });
    });
});

describe("browser device route", () => {
  it.each([
    { route: "/set/device", body: { name: "iPhone 15" } },
    { route: "/set/media", body: { colorScheme: "dark" } },
    { route: "/set/timezone", body: { timezoneId: "America/New_York" } },
    { route: "/set/locale", body: { locale: "en-US" } },
  ])("rejects existing-session $route with a supported alternative", async ({ route, body }) => {
    routeState.driver = "existing-session";
    const response = createBrowserRouteResponse();
    await getPostHandler(route)?.({ params: {}, query: {}, body }, response.res);
    expect(response.statusCode).toBe(501);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("managed browser profile"),
    });
    expect(routeState.withPlaywrightRouteContext).not.toHaveBeenCalled();
  });

  it("forwards the route lease signal into the atomic device transition", async () => {
    const controller = new AbortController();
    const response = createBrowserRouteResponse();

    await getPostHandler("/set/device")?.(
      {
        params: {},
        query: {},
        body: { targetId: "tab-1", name: "iPhone 14" },
        signal: controller.signal,
      },
      response.res,
    );

    expect(routeState.setDeviceViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      targetId: "tab-1",
      name: "iPhone 14",
      signal: controller.signal,
    });
    expect(response.body).toEqual({ ok: true, targetId: "tab-1" });
    expect(routeState.withPlaywrightRouteContext).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "device emulation" }),
    );
    expect(routeState.withPlaywrightRouteContext.mock.calls[0]?.[0]).not.toHaveProperty(
      "enforceCurrentUrlAllowed",
    );
  });

  it("never publishes a successful mutation after its route lease is canceled", async () => {
    const controller = new AbortController();
    const response = createBrowserRouteResponse();
    routeState.setDeviceViaPlaywright.mockImplementationOnce(async () => controller.abort());

    await expect(
      getPostHandler("/set/device")?.(
        {
          params: {},
          query: {},
          body: { name: "iPhone 14" },
          signal: controller.signal,
        },
        response.res,
      ),
    ).rejects.toThrow();

    expect(response.body).toBeUndefined();
  });
});

describe("browser cookie batch route", () => {
  it("parses and injects a non-empty cookie batch", async () => {
    const controller = new AbortController();
    const response = createBrowserRouteResponse();
    const cookies = [
      {
        name: "session",
        value: "secret",
        domain: ".example.com",
        path: "/",
        expires: 1_700_000_000,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
      { name: "theme", value: "dark", url: "https://example.com" },
    ];

    await getPostHandler("/cookies/set-many")?.(
      {
        params: {},
        query: {},
        body: { targetId: "requested-tab", cookies },
        signal: controller.signal,
      },
      response.res,
    );

    expect(routeState.cookiesSetManyViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      targetId: "tab-1",
      cookies,
      signal: controller.signal,
    });
    expect(response.body).toEqual({ ok: true, targetId: "tab-1", added: 2 });
  });

  it.each([
    ["missing", {}],
    ["empty", { cookies: [] }],
    ["non-array", { cookies: {} }],
  ])("rejects a %s cookies payload", async (_label, body) => {
    const response = createBrowserRouteResponse();

    await getPostHandler("/cookies/set-many")?.({ params: {}, query: {}, body }, response.res);

    expect(response.statusCode).toBe(400);
    expect(routeState.withPlaywrightRouteContext).not.toHaveBeenCalled();
    expect(routeState.cookiesSetManyViaPlaywright).not.toHaveBeenCalled();
  });
});

describe("browser storage route boundaries", () => {
  it.each(["local", "session"] as const)("reads the distinct padded %s key", async (kind) => {
    routeState.storage[kind].set("account", "plain");
    routeState.storage[kind].set(" account ", "padded");
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserAgentStorageRoutes(app, {} as never);
    const response = createBrowserRouteResponse();

    await getHandlers.get("/storage/:kind")!(
      { params: { kind }, query: { key: " account " } },
      response.res,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      targetId: "tab-1",
      values: { " account ": "padded" },
    });
  });

  it.each([
    { kind: "local", operation: "set", value: "  preserved  " },
    { kind: "session", operation: "set", value: "" },
    { kind: "local", operation: "clear", value: undefined },
    { kind: "session", operation: "clear", value: undefined },
  ] as const)(
    "changes only the requested $kind storage entry on $operation",
    async ({ kind, operation, value }) => {
      const store = routeState.storage[kind];
      store.set("key", "plain");
      store.set(" key ", "padded");
      const otherStore = routeState.storage[kind === "local" ? "session" : "local"];
      otherStore.set("key", "other bucket");
      const response = createBrowserRouteResponse();
      await getPostHandler(`/storage/:kind/${operation}`)?.(
        {
          params: { kind: ` ${kind} ` },
          query: {},
          body: { targetId: " requested-tab ", key: " key ", value },
        },
        response.res,
      );

      expect(Object.fromEntries(store)).toEqual(
        operation === "set" ? { key: "plain", " key ": value } : {},
      );
      expect(Object.fromEntries(otherStore)).toEqual({ key: "other bucket" });
      expect(response.statusCode).toBe(200);
    },
  );

  it.each([
    { key: 0, expected: { "0": "value" } },
    { key: false, expected: { false: "value" } },
    { key: "", expected: {} },
    { key: " \t ", expected: {} },
  ])("preserves key coercion and blank rejection for $key", async ({ key, expected }) => {
    routeState.storage.local.set("existing", "unchanged");
    const response = createBrowserRouteResponse();

    await getPostHandler("/storage/:kind/set")!(
      { params: { kind: "local" }, query: {}, body: { key, value: "value" } },
      response.res,
    );

    expect(response.statusCode).toBe(typeof key === "string" ? 400 : 200);
    expect(Object.fromEntries(routeState.storage.local)).toEqual({
      existing: "unchanged",
      ...expected,
    });
  });

  it.each(["set", "clear"])(
    "rejects an invalid storage kind before %s dispatch",
    async (operation) => {
      const response = createBrowserRouteResponse();
      await getPostHandler(`/storage/:kind/${operation}`)?.(
        {
          params: { kind: "invalid" },
          query: {},
          body: {
            key: "",
            targetId: " requested-tab ",
          },
        },
        response.res,
      );

      expect(response.statusCode).toBe(400);
      expect(routeState.withPlaywrightRouteContext).not.toHaveBeenCalled();
      expect(routeState.storageSetViaPlaywright).not.toHaveBeenCalled();
      expect(routeState.storageClearViaPlaywright).not.toHaveBeenCalled();
    },
  );

  it("keeps cookie reads behind the current-tab URL guard", async () => {
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserAgentStorageRoutes(app, {} as never);
    const response = createBrowserRouteResponse();

    await getHandlers.get("/cookies")?.({ params: {}, query: {} }, response.res);

    expect(routeState.withPlaywrightRouteContext).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "cookies", enforceCurrentUrlAllowed: true }),
    );
    expect(response.body).toEqual({ ok: true, targetId: "tab-1", cookies: [] });
  });

  it("applies HTTP credentials without ever returning the password", async () => {
    const response = createBrowserRouteResponse();

    await getPostHandler("/set/credentials")?.(
      {
        params: {},
        query: {},
        body: { username: "browser-user", password: "sensitive-browser-password" },
      },
      response.res,
    );

    expect(routeState.setHttpCredentialsViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      targetId: "tab-1",
      username: "browser-user",
      password: "sensitive-browser-password",
      clear: false,
    });
    expect(response.body).toEqual({ ok: true, targetId: "tab-1" });
    expect(routeState.withPlaywrightRouteContext).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "http credentials" }),
    );
  });
});
