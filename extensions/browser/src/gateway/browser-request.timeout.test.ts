import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { GatewayRequestHandlers } from "openclaw/plugin-sdk/gateway-runtime";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteContext, type BrowserRouteContext } from "../browser/server-context.js";
import { makeBrowserServerState } from "../browser/server-context.test-harness.js";

const m = vi.hoisted(() => ({
  context: vi.fn<() => BrowserRouteContext>(),
  dispatcher: vi.fn(),
  config: vi.fn(),
  start: vi.fn(),
  timeout: vi.fn(),
}));

vi.mock("../browser-control-state.js", () => ({ createBrowserControlContext: m.context }));
vi.mock("../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: m.dispatcher,
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: m.config,
}));
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

type Request = Parameters<GatewayRequestHandlers[string]>[0];
function request(params: Request["params"], options: Partial<Request> = {}) {
  return browserHandlers["browser.request"]({
    params,
    respond: vi.fn(),
    context: { nodeRegistry: { listConnected: () => [] } } as never,
    client: null,
    req: { type: "req", id: "local-authority", method: "browser.request" },
    isWebchatConnect: () => false,
    ...options,
  });
}

describe("browser.request local timeout", () => {
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
    { timeoutMs: undefined, revocation: "authority" },
    { timeoutMs: 1000, revocation: "client" },
  ])(
    "rechecks $revocation after local profile admission with timeout=$timeoutMs",
    async ({ timeoutMs, revocation }) => {
      const state = makeBrowserServerState();
      const context = createBrowserRouteContext({ getState: () => state });
      const profile = context.forProfile("openclaw");
      vi.spyOn(context, "forProfile").mockReturnValue(profile);
      const admission = createDeferred<void>();
      const releaseAdmission = createDeferred<void>();
      vi.spyOn(profile, "ensureBrowserAvailable").mockImplementation(async () => {
        admission.resolve();
        await releaseAdmission.promise;
      });
      const openTab = vi
        .spyOn(profile, "openTab")
        .mockResolvedValue({ targetId: "unwanted-tab", title: "", url: "about:blank" });
      m.context.mockReturnValue(context);
      m.dispatcher.mockImplementation(createBrowserRouteDispatcher);
      m.timeout.mockImplementation(withTimeout);
      const connection = new AbortController();
      const client: NonNullable<Request["client"]> = {
        connId: "browser-requester",
        connectionSignal: connection.signal,
        connect: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: "test", version: "1", platform: "test", mode: "test" },
        },
      };
      let current = true;
      const respond = vi.fn();
      const pending = request(
        {
          target: "host",
          method: "POST",
          path: "/tabs/open",
          body: { url: "about:blank" },
          timeoutMs,
        },
        { respond, context: {} as never, client, hasCurrentClientAuthority: () => current },
      );
      await admission.promise;
      if (revocation === "client") {
        client.invalidated = true;
      } else {
        current = false;
      }
      releaseAdmission.resolve();
      await pending;
      expect(connection.signal.aborted).toBe(false);
      expect(openTab).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining("requester is no longer active"),
        }),
      );
    },
  );

  it("applies timeoutMs to local browser dispatches", async () => {
    const respond = vi.fn();

    await expectDefined(
      browserHandlers["browser.request"],
      "browser request handler",
    )({
      params: {
        method: "POST",
        path: "/tabs/open",
        body: { url: "https://example.com" },
        timeoutMs: 4321,
      },
      respond: respond as never,
      context: {
        nodeRegistry: { listConnected: () => [] },
      } as never,
      client: null,
      req: { type: "req", id: "req-1", method: "browser.request" },
      isWebchatConnect: () => false,
    });

    expect(withTimeoutMock).toHaveBeenCalledTimes(1);
    const [call] = withTimeoutMock.mock.calls;
    if (!call) {
      throw new Error("expected withTimeout call");
    }
    const [dispatchTask, timeoutMs, timeoutLabel] = call;
    expect(dispatchTask).toBeTypeOf("function");
    expect(timeoutMs).toBe(4321);
    expect(timeoutLabel).toBe("browser request");
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "Error: browser request timed out",
    });
  });

  it("caps timeoutMs before local browser dispatches", async () => {
    const respond = vi.fn();

    await request(
      {
        method: "POST",
        path: "/tabs/open",
        body: { url: "https://example.com" },
        timeoutMs: Number.MAX_SAFE_INTEGER,
      },
      { respond },
    );

    expect(m.timeout).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      MAX_TIMER_TIMEOUT_MS,
      "browser request",
    );
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "Error: browser request timed out",
    });
  });
});
