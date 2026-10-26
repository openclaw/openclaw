import { beforeEach, expect, it, vi } from "vitest";
import { createBrowserRouteContext, type BrowserRouteContext } from "../browser/server-context.js";
import { makeBrowserServerState } from "../browser/server-context.test-harness.js";

const m = vi.hoisted(() => ({
  context: vi.fn<() => BrowserRouteContext>(),
  config: vi.fn(),
  start: vi.fn(),
}));

// mock-isolation: Timeout and revocation tests use fixture-owned browser state without starting a real browser service.
vi.mock("../browser-control-state.js", () => ({ createBrowserControlContext: m.context }));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: m.config,
}));
// mock-isolation: Timeout and revocation tests use fixture-owned browser state without starting a real browser service.
vi.mock("../control-service.js", () => ({ startBrowserControlServiceFromConfig: m.start }));

import { browserHandlers } from "./browser-request.js";
import { makeClient, makeRequest, deferredOperation } from "./browser-request.test-support.js";

beforeEach(() => {
  vi.clearAllMocks();
  m.config.mockReturnValue({ gateway: { nodes: { browser: { mode: "off" } } } });
  m.start.mockResolvedValue(true);
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
  const connection = new AbortController();
  const client = makeClient(connection.signal, "browser-requester");
  let current = true;
  const respond = vi.fn();
  const pending = browserHandlers["browser.request"](
    makeRequest(
      {
        target: "host",
        method: "POST",
        path: "/tabs/open",
        body: { url: "about:blank" },
        timeoutMs,
      },
      { respond, client, hasCurrentClientAuthority: () => current },
    ),
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
    expect.objectContaining({
      code: "UNAVAILABLE",
      message: expect.stringContaining("requester is no longer active"),
    }),
  );
});
