import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadConfigMock,
  resolveBrowserConfigMock,
  dispatcherDispatchMock,
  createBrowserRouteDispatcherMock,
  createBrowserControlContextMock,
  startBrowserControlServiceFromConfigMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  resolveBrowserConfigMock: vi.fn(),
  dispatcherDispatchMock: vi.fn(),
  createBrowserRouteDispatcherMock: vi.fn(() => ({
    dispatch: dispatcherDispatchMock,
  })),
  createBrowserControlContextMock: vi.fn(() => ({})),
  startBrowserControlServiceFromConfigMock: vi.fn(async () => true),
}));

vi.mock("../core-api.js", async () => ({
  ...(await vi.importActual<object>("../core-api.js")),
  createBrowserControlContext: createBrowserControlContextMock,
  createBrowserRouteDispatcher: createBrowserRouteDispatcherMock,
  loadConfig: loadConfigMock,
  resolveBrowserConfig: resolveBrowserConfigMock,
  startBrowserControlServiceFromConfig: startBrowserControlServiceFromConfigMock,
}));

import { browserHandlers } from "./browser-request.js";

describe("browser.request local timeout forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({
      gateway: { nodes: { browser: { mode: "off" } } },
      browser: {},
    });
    resolveBrowserConfigMock.mockReturnValue({
      enabled: true,
      defaultProfile: "openclaw",
      profiles: {
        openclaw: {
          name: "openclaw",
          driver: "playwright",
        },
      },
    });
  });

  it("passes an abort signal to local dispatch and times out cleanly", async () => {
    let observedSignal: AbortSignal | undefined;
    dispatcherDispatchMock.mockImplementationOnce(async ({ signal }: { signal?: AbortSignal }) => {
      observedSignal = signal;
      await new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    const respond = vi.fn();

    await browserHandlers["browser.request"]({
      params: {
        method: "POST",
        path: "/act",
        body: { kind: "click", ref: "e1" },
        timeoutMs: 5,
      },
      respond: respond as never,
      context: {
        nodeRegistry: {
          listConnected: () => [],
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-1", method: "browser.request" },
      isWebchatConnect: () => false,
    });

    expect(createBrowserRouteDispatcherMock).toHaveBeenCalled();
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("browser request timed out"),
      }),
    );
  });

  it("passes an abort signal to local batch acts and times out cleanly", async () => {
    let observedSignal: AbortSignal | undefined;
    dispatcherDispatchMock.mockImplementationOnce(async ({ signal }: { signal?: AbortSignal }) => {
      observedSignal = signal;
      await new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    const respond = vi.fn();

    await browserHandlers["browser.request"]({
      params: {
        method: "POST",
        path: "/act",
        body: {
          kind: "batch",
          actions: [{ kind: "click", ref: "e1" }],
        },
        timeoutMs: 5,
      },
      respond: respond as never,
      context: {
        nodeRegistry: {
          listConnected: () => [],
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-1b", method: "browser.request" },
      isWebchatConnect: () => false,
    });

    expect(createBrowserRouteDispatcherMock).toHaveBeenCalled();
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("browser request timed out"),
      }),
    );
  });

  it("leaves non-abort-aware local routes on the direct dispatch path", async () => {
    let observedSignal: AbortSignal | undefined;
    dispatcherDispatchMock.mockImplementationOnce(async ({ signal }: { signal?: AbortSignal }) => {
      observedSignal = signal;
      return { status: 200, body: { ok: true } };
    });

    const respond = vi.fn();

    await browserHandlers["browser.request"]({
      params: {
        method: "POST",
        path: "/highlight",
        body: { ref: "e1" },
        timeoutMs: 5,
      },
      respond: respond as never,
      context: {
        nodeRegistry: {
          listConnected: () => [],
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-2", method: "browser.request" },
      isWebchatConnect: () => false,
    });

    expect(observedSignal).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("keeps timeoutMs active for local non-act routes that used to inherit the generic wrapper", async () => {
    let observedSignal: AbortSignal | undefined;
    dispatcherDispatchMock.mockImplementationOnce(async ({ signal }: { signal?: AbortSignal }) => {
      observedSignal = signal;
      return { status: 200, body: { ok: true } };
    });

    const respond = vi.fn();

    await browserHandlers["browser.request"]({
      params: {
        method: "POST",
        path: "/tabs/open",
        body: { url: "https://example.com" },
        timeoutMs: 5,
      },
      respond: respond as never,
      context: {
        nodeRegistry: {
          listConnected: () => [],
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-2b", method: "browser.request" },
      isWebchatConnect: () => false,
    });

    expect(observedSignal).toBeDefined();
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("does not let browser config parse failures escape the timeout gate", async () => {
    resolveBrowserConfigMock.mockImplementationOnce(() => {
      throw new Error("invalid browser config");
    });

    let observedSignal: AbortSignal | undefined;
    dispatcherDispatchMock.mockImplementationOnce(async ({ signal }: { signal?: AbortSignal }) => {
      observedSignal = signal;
      return { status: 200, body: { ok: true } };
    });

    const respond = vi.fn();

    await browserHandlers["browser.request"]({
      params: {
        method: "POST",
        path: "/tabs/open",
        body: { url: "https://example.com" },
        timeoutMs: 5,
      },
      respond: respond as never,
      context: {
        nodeRegistry: {
          listConnected: () => [],
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-2c", method: "browser.request" },
      isWebchatConnect: () => false,
    });

    expect(observedSignal).toBeDefined();
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("leaves existing-session profiles on the direct dispatch path", async () => {
    resolveBrowserConfigMock.mockReturnValue({
      enabled: true,
      defaultProfile: "existing",
      profiles: {
        existing: {
          name: "existing",
          driver: "existing-session",
        },
      },
    });

    let observedSignal: AbortSignal | undefined;
    dispatcherDispatchMock.mockImplementationOnce(async ({ signal }: { signal?: AbortSignal }) => {
      observedSignal = signal;
      return { status: 200, body: { ok: true } };
    });

    const respond = vi.fn();

    await browserHandlers["browser.request"]({
      params: {
        method: "POST",
        path: "/navigate",
        body: { url: "https://example.com" },
        timeoutMs: 5,
      },
      respond: respond as never,
      context: {
        nodeRegistry: {
          listConnected: () => [],
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-3", method: "browser.request" },
      isWebchatConnect: () => false,
    });

    expect(observedSignal).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("leaves the built-in user existing-session profile on the direct dispatch path", async () => {
    resolveBrowserConfigMock.mockReturnValue({
      enabled: true,
      defaultProfile: "user",
      profiles: {
        user: {
          name: "user",
          driver: "existing-session",
        },
      },
    });

    let observedSignal: AbortSignal | undefined;
    dispatcherDispatchMock.mockImplementationOnce(async ({ signal }: { signal?: AbortSignal }) => {
      observedSignal = signal;
      return { status: 200, body: { ok: true } };
    });

    const respond = vi.fn();

    await browserHandlers["browser.request"]({
      params: {
        method: "POST",
        path: "/navigate",
        body: { url: "https://example.com", profile: "user" },
        timeoutMs: 5,
      },
      respond: respond as never,
      context: {
        nodeRegistry: {
          listConnected: () => [],
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-4", method: "browser.request" },
      isWebchatConnect: () => false,
    });

    expect(observedSignal).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });
});
