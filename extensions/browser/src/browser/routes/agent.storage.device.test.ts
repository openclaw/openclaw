import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectResponse,
  expectResponseContaining,
  runRoute,
  startRoute,
} from "./agent-route.test-support.js";
import { createBrowserRouteApp } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

const routeState = vi.hoisted(() => ({
  driver: "openclaw",
  cookiesGetViaPlaywright: vi.fn(async () => ({ cookies: [] })),
  cookiesSetManyViaPlaywright: vi.fn(async () => ({ added: 2 })),
  setDeviceViaPlaywright: vi.fn(async () => {}),
  setTimezoneViaPlaywright: vi.fn(async () => {}),
  setLocaleViaPlaywright: vi.fn(async () => {}),
  setHttpCredentialsViaPlaywright: vi.fn(async () => {}),
  storageSetViaPlaywright: vi.fn(async () => {}),
  withPlaywrightRouteContext: vi.fn(),
}));

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

const target = { cdpUrl: "http://127.0.0.1:18800", targetId: "tab-1" };

beforeEach(() => {
  vi.clearAllMocks();
  routeState.driver = "openclaw";
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
      expectResponse(await post(route, body, params), { error }, 400);
      expect(routeState.withPlaywrightRouteContext).not.toHaveBeenCalled();
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
  it("coerces numeric storage keys", async () => {
    const response = await post(
      "/storage/:kind/set",
      { key: 0, value: "value" },
      { kind: "local" },
    );
    expect(response.statusCode).toBe(200);
    expect(routeState.storageSetViaPlaywright).toHaveBeenCalledWith({
      ...target,
      kind: "local",
      key: "0",
      value: "value",
    });
  });

  it("keeps cookie reads behind the current-tab URL guard", async () => {
    const response = await runRoute(getHandler("get", "/cookies"), {});
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
