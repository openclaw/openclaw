import type { GatewayRequestHandlers } from "openclaw/plugin-sdk/gateway-runtime";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { createBrowserRouteContext, type BrowserRouteContext } from "../browser/server-context.js";
import { makeBrowserServerState } from "../browser/server-context.test-harness.js";

const m = vi.hoisted(() => ({
  context: vi.fn<() => BrowserRouteContext>(),
  dispatcher: vi.fn(),
  config: vi.fn(),
  start: vi.fn(),
  timeout: vi.fn(),
}));

// mock-isolation: Timeout and revocation tests use fixture-owned browser state without starting a real browser service.
vi.mock("../browser-control-state.js", () => ({ createBrowserControlContext: m.context }));
// mock-isolation: Timeout and revocation tests use fixture-owned browser state without starting a real browser service.
vi.mock("../browser/routes/dispatcher.js", () => ({ createBrowserRouteDispatcher: m.dispatcher }));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: m.config,
}));
// mock-isolation: Timeout and revocation tests use fixture-owned browser state without starting a real browser service.
vi.mock("../control-service.js", () => ({ startBrowserControlServiceFromConfig: m.start }));
vi.mock("../sdk-node-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sdk-node-runtime.js")>()),
  withTimeout: m.timeout,
}));

const { createBrowserRouteDispatcher } = await vi.importActual<
  typeof import("../browser/routes/dispatcher.js")
>("../browser/routes/dispatcher.js");
const { withTimeout } =
  await vi.importActual<typeof import("../sdk-node-runtime.js")>("../sdk-node-runtime.js");

import { browserHandlers } from "./browser-request.js";
import { makeClient, makeRequest, deferredOperation } from "./browser-request.test-support.js";

type Request = Parameters<GatewayRequestHandlers[string]>[0];
function request(params: Request["params"], options: Partial<Request> = {}) {
  return browserHandlers["browser.request"](makeRequest(params, options));
}

beforeEach(() => {
  vi.clearAllMocks();
  m.config.mockReturnValue({ gateway: { nodes: { browser: { mode: "off" } } } });
  m.start.mockResolvedValue(true);
  m.dispatcher.mockReturnValue({
    dispatch: vi.fn(async () => ({ status: 200, body: { ok: true } })),
  });
  m.timeout.mockImplementation(async () => {
    throw new Error("browser request timed out");
  });
});

it.each([
  ["authority", undefined],
  ["client", 1000],
] as const)("rechecks %s revocation", async (revocation, timeoutMs) => {
  const state = makeBrowserServerState();
  const context = createBrowserRouteContext({ getState: () => state });
  const profile = context.forProfile("openclaw");
  vi.spyOn(context, "forProfile").mockReturnValue(profile);
  const admission = deferredOperation<void>();
  vi.spyOn(profile, "ensureBrowserAvailable").mockImplementation(admission.run);
  const openTab = vi
    .spyOn(profile, "openTab")
    .mockResolvedValue({ targetId: "unwanted-tab", title: "", url: "about:blank" });
  m.context.mockReturnValue(context);
  m.dispatcher.mockImplementation(createBrowserRouteDispatcher);
  m.timeout.mockImplementation(withTimeout);
  const connection = new AbortController();
  const client = makeClient(connection.signal, "browser-requester");
  let current = true;
  const respond = vi.fn();
  const pending = request(
    { target: "host", method: "POST", path: "/tabs/open", body: { url: "about:blank" }, timeoutMs },
    { respond, context: {} as never, client, hasCurrentClientAuthority: () => current },
  );
  await admission.entered;
  if (revocation === "client") {
    client.invalidated = true;
  } else {
    current = false;
  }
  admission.resolve();
  await pending;
  expect(connection.signal.aborted).toBe(false);
  expect(openTab).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: expect.stringContaining("requester is no longer active") }),
  );
});

it.each([
  [4321, 4321],
  [Number.MAX_SAFE_INTEGER, MAX_TIMER_TIMEOUT_MS],
])("applies and caps local dispatch timeout %s", async (timeoutMs, expectedTimeout) => {
  const respond = vi.fn();
  await request(
    {
      method: "POST",
      path: "/tabs/open",
      body: { url: "https://example.com" },
      timeoutMs,
    },
    { respond },
  );

  expect(m.timeout).toHaveBeenCalledExactlyOnceWith(
    expect.any(Function),
    expectedTimeout,
    "browser request",
  );
  expect(respond).toHaveBeenCalledWith(false, undefined, {
    code: "UNAVAILABLE",
    message: "Error: browser request timed out",
  });
});
