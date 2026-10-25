import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectResponse,
  expectResponseContaining,
  runRoute,
  startRoute,
} from "./agent-route.test-support.js";
import { createBrowserRouteApp } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

type StorageKind = "local" | "session";

const routeState = vi.hoisted(() => {
  const storage = { local: new Map<string, string>(), session: new Map<string, string>() };
  return {
    driver: "openclaw",
    cookiesGetViaPlaywright: vi.fn(async () => ({ cookies: [] })),
    cookiesSetManyViaPlaywright: vi.fn(async () => ({ added: 2 })),
    setDeviceViaPlaywright: vi.fn(async () => {}),
    setTimezoneViaPlaywright: vi.fn(async () => {}),
    setLocaleViaPlaywright: vi.fn(async () => {}),
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
    pw: typeof routeState;
  }) => Promise<unknown>;
};

function getHandler(method: "get" | "post", route: string) {
  const { app, postHandlers, getHandlers } = createBrowserRouteApp();
  registerBrowserAgentStorageRoutes(app, {} as never);
  const handler = (method === "get" ? getHandlers : postHandlers).get(route);
  expect(handler).toBeTypeOf("function");
  return handler;
}

async function post(
  route: string,
  body: BrowserRequest["body"],
  params: BrowserRequest["params"] = {},
  signal?: AbortSignal,
) {
  return await runRoute(getHandler("post", route), { params, body, signal });
}

async function get(
  route: string,
  params: BrowserRequest["params"] = {},
  query: BrowserRequest["query"] = {},
) {
  return await runRoute(getHandler("get", route), { params, query });
}

const target = { cdpUrl: "http://127.0.0.1:18800", targetId: "tab-1" };

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
    ["/set/timezone", { timezoneId: " \t " }, {}, "timezoneId is required"],
    ["/set/locale", { locale: " \t " }, {}, "locale is required"],
    ["/set/device", { name: " \t " }, {}, "name is required"],
    ["/cookies/set-many", { cookies: [] }, {}, "cookies must be a non-empty array"],
    ["/storage/:kind/set", { key: "key" }, { kind: "invalid" }, "kind must be local|session"],
    ["/storage/:kind/set", { key: " \t ", value: "value" }, { kind: "local" }, "key is required"],
  ] as const)(
    "rejects invalid %s input before acquiring a browser",
    async (route, body, params, error) => {
      routeState.storage.local.set("existing", "unchanged");
      expectResponse(await post(route, body, params), { error }, 400);
      expect(routeState.withPlaywrightRouteContext).not.toHaveBeenCalled();
      expect(Object.fromEntries(routeState.storage.local)).toEqual({ existing: "unchanged" });
    },
  );

  it.each([
    ["timezone", "timezoneId", 0, "0", "setTimezoneViaPlaywright"],
    ["locale", "locale", false, "false", "setLocaleViaPlaywright"],
  ] as const)(
    "preserves scalar coercion at the %s boundary",
    async (route, field, value, expected, method) => {
      const response = await post(`/set/${route}`, { [field]: value });
      expectResponse(response, { ok: true, targetId: "tab-1" });
      expect(routeState[method]).toHaveBeenCalledWith({ ...target, [field]: expected });
    },
  );

  it.each([
    { route: "/set/media", body: { colorScheme: "dark" } },
    { route: "/set/timezone", body: { timezoneId: "America/New_York" } },
    { route: "/set/locale", body: { locale: "en-US" } },
  ])("rejects existing-session $route with a supported alternative", async ({ route, body }) => {
    routeState.driver = "existing-session";
    const response = await post(route, body);
    expectResponseContaining(
      response,
      { error: expect.stringContaining("managed browser profile") },
      501,
    );
    expect(routeState.withPlaywrightRouteContext).not.toHaveBeenCalled();
  });

  it("forwards the route lease signal into the atomic device transition", async () => {
    const controller = new AbortController();
    const response = await post(
      "/set/device",
      { targetId: "tab-1", name: "  iPhone 14  " },
      {},
      controller.signal,
    );
    expect(routeState.setDeviceViaPlaywright).toHaveBeenCalledWith({
      ...target,
      name: "iPhone 14",
      signal: controller.signal,
    });
    expect(response.body).toEqual({ ok: true, targetId: "tab-1" });
    expect(routeState.withPlaywrightRouteContext.mock.calls[0]?.[0]).not.toHaveProperty(
      "enforceCurrentUrlAllowed",
    );
  });

  it("never publishes a successful mutation after its route lease is canceled", async () => {
    const controller = new AbortController();
    routeState.setDeviceViaPlaywright.mockImplementationOnce(async () => controller.abort());
    const { response, completion } = startRoute(getHandler("post", "/set/device"), {
      body: { name: "iPhone 14" },
      signal: controller.signal,
    });
    await expect(completion).rejects.toThrow();
    expect(response.body).toBeUndefined();
  });
});

describe("browser cookie batch route", () => {
  it("parses and injects a non-empty cookie batch", async () => {
    const controller = new AbortController();
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

    const response = await post(
      "/cookies/set-many",
      { targetId: "requested-tab", cookies },
      {},
      controller.signal,
    );
    expect(routeState.cookiesSetManyViaPlaywright).toHaveBeenCalledWith({
      ...target,
      cookies,
      signal: controller.signal,
    });
    expect(response.body).toEqual({ ok: true, targetId: "tab-1", added: 2 });
  });
});

describe("browser storage route boundaries", () => {
  it("reads the distinct padded local key", async () => {
    const kind = "local";
    routeState.storage[kind].set("account", "plain");
    routeState.storage[kind].set(" account ", "padded");
    const response = await get("/storage/:kind", { kind }, { key: " account " });
    expectResponse(response, { ok: true, targetId: "tab-1", values: { " account ": "padded" } });
  });

  it.each([
    { kind: "session", operation: "set", value: "  preserved  " },
    { kind: "local", operation: "clear", value: undefined },
  ] as const)(
    "changes only the requested $kind storage entry on $operation",
    async ({ kind, operation, value }) => {
      const store = routeState.storage[kind];
      store.set("key", "plain");
      store.set(" key ", "padded");
      const otherStore = routeState.storage[kind === "local" ? "session" : "local"];
      otherStore.set("key", "other bucket");
      const response = await post(
        `/storage/:kind/${operation}`,
        { targetId: " requested-tab ", key: " key ", value },
        { kind: ` ${kind} ` },
      );

      expect(Object.fromEntries(store)).toEqual(
        operation === "set" ? { key: "plain", " key ": value } : {},
      );
      expect(Object.fromEntries(otherStore)).toEqual({ key: "other bucket" });
      expect(response.statusCode).toBe(200);
    },
  );

  it("coerces numeric storage keys without changing existing entries", async () => {
    routeState.storage.local.set("existing", "unchanged");
    const response = await post(
      "/storage/:kind/set",
      { key: 0, value: "value" },
      { kind: "local" },
    );
    expect(response.statusCode).toBe(200);
    expect(Object.fromEntries(routeState.storage.local)).toEqual({
      existing: "unchanged",
      "0": "value",
    });
  });

  it("keeps cookie reads behind the current-tab URL guard", async () => {
    const response = await get("/cookies");
    expect(routeState.withPlaywrightRouteContext).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "cookies", enforceCurrentUrlAllowed: true }),
    );
    expect(response.body).toEqual({ ok: true, targetId: "tab-1", cookies: [] });
  });

  it("applies HTTP credentials without ever returning the password", async () => {
    const credentials = { username: "browser-user", password: "sensitive-browser-password" };
    const response = await post("/set/credentials", credentials);
    expect(routeState.setHttpCredentialsViaPlaywright).toHaveBeenCalledWith({
      ...target,
      ...credentials,
      clear: false,
    });
    expect(response.body).toEqual({ ok: true, targetId: "tab-1" });
  });
});
