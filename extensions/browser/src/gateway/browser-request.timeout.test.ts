// Browser tests cover browser request.timeout plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRouteDispatcher } from "../browser/routes/dispatcher.js";
import { createBrowserRouteContext, type BrowserRouteContext } from "../browser/server-context.js";
import { makeBrowserServerState } from "../browser/server-context.test-harness.js";
import type { GatewayRequestHandlers } from "../core-api.js";
import { withTimeout } from "../sdk-node-runtime.js";

const {
  createBrowserControlContextMock,
  createBrowserRouteDispatcherMock,
  loadConfigMock,
  startBrowserControlServiceFromConfigMock,
  withTimeoutMock,
} = vi.hoisted(() => ({
  createBrowserControlContextMock: vi.fn<() => BrowserRouteContext>(),
  createBrowserRouteDispatcherMock: vi.fn(),
  loadConfigMock: vi.fn(),
  startBrowserControlServiceFromConfigMock: vi.fn(),
  withTimeoutMock: vi.fn(),
}));

vi.mock("../core-api.js", async () => {
  const actual = await vi.importActual<typeof import("../core-api.js")>("../core-api.js");
  return {
    ...actual,
    createBrowserControlContext: createBrowserControlContextMock,
    createBrowserRouteDispatcher: createBrowserRouteDispatcherMock,
    loadConfig: loadConfigMock,
    startBrowserControlServiceFromConfig: startBrowserControlServiceFromConfigMock,
    withTimeout: withTimeoutMock,
  };
});

import { browserHandlers } from "./browser-request.js";

describe("browser.request local timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({
      gateway: { nodes: { browser: { mode: "off" } } },
    });
    startBrowserControlServiceFromConfigMock.mockResolvedValue(true);
    createBrowserRouteDispatcherMock.mockReturnValue({
      dispatch: vi.fn(async () => ({ status: 200, body: { ok: true } })),
    });
    withTimeoutMock.mockImplementation(async () => {
      throw new Error("browser request timed out");
    });
  });

  it.each([
    { timeoutMs: undefined, revocation: "authority" },
    { timeoutMs: 1000, revocation: "authority" },
    { timeoutMs: undefined, revocation: "client" },
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
      const openTab = vi.spyOn(profile, "openTab").mockResolvedValue({
        targetId: "unwanted-tab",
        title: "",
        url: "about:blank",
      });
      createBrowserControlContextMock.mockReturnValue(context);
      createBrowserRouteDispatcherMock.mockImplementation(createBrowserRouteDispatcher);
      withTimeoutMock.mockImplementation(withTimeout);
      const connection = new AbortController();
      const client: NonNullable<Parameters<GatewayRequestHandlers[string]>[0]["client"]> = {
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
      const pending = expectDefined(
        browserHandlers["browser.request"],
        "browser request handler",
      )({
        params: {
          target: "host",
          method: "POST",
          path: "/tabs/open",
          body: { url: "about:blank" },
          timeoutMs,
        },
        respond,
        context: {} as never,
        client,
        hasCurrentClientAuthority: () => current,
        req: { type: "req", id: "local-authority", method: "browser.request" },
        isWebchatConnect: () => false,
      });
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

    await expectDefined(
      browserHandlers["browser.request"],
      "browser request handler",
    )({
      params: {
        method: "POST",
        path: "/tabs/open",
        body: { url: "https://example.com" },
        timeoutMs: Number.MAX_SAFE_INTEGER,
      },
      respond: respond as never,
      context: {
        nodeRegistry: { listConnected: () => [] },
      } as never,
      client: null,
      req: { type: "req", id: "req-1", method: "browser.request" },
      isWebchatConnect: () => false,
    });

    const [, timeoutMs] = withTimeoutMock.mock.calls.at(-1) ?? [];
    expect(timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
