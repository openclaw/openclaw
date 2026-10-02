import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserMockBundle,
  makeEmptyBrowser,
  setupPwSessionConnectionTest,
} from "./pw-session.connection.test-support.js";

const {
  connectOverCdpSpy,
  getChromeWebSocketEndpointSpy,
  getChromeWebSocketUrlSpy,
  registerManagedProxyBrowserCdpBypassMock,
  pwAi,
} = setupPwSessionConnectionTest();

const {
  closePlaywrightBrowserConnection,
  createPageViaPlaywright,
  getPageForTargetId,
  listPagesViaPlaywright,
  retirePlaywrightBrowserConnectionExact,
} = pwAi;

const cdpUrl = "http://127.0.0.1:9222";

function makeBrowser(targetId: string, url: string): BrowserMockBundle {
  const browserClose = vi.fn(async () => {});
  const page = {
    on: vi.fn(),
    context: () => context,
    title: vi.fn(async () => `title:${targetId}`),
    url: vi.fn(() => url),
  } as unknown as import("playwright-core").Page;

  const context: import("playwright-core").BrowserContext = {
    pages: () => [page],
    on: vi.fn(),
    newCDPSession: vi.fn(async () => ({
      send: vi.fn(async (method: string) =>
        method === "Target.getTargetInfo"
          ? { targetInfo: { targetId, title: `title:${targetId}` } }
          : {},
      ),
      detach: vi.fn(async () => {}),
    })),
  } as unknown as import("playwright-core").BrowserContext;

  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  return { browser, browserClose };
}

function makeStuckPageTargetBrowser() {
  const fixture = makeBrowser("STUCK", "https://stuck.example");
  const read = createDeferred<import("playwright-core").CDPSession>();
  const newCDPSession = vi
    .spyOn(fixture.browser.contexts()[0]!, "newCDPSession")
    .mockImplementation(() => read.promise);
  return { ...fixture, newCDPSession, rejectTargetRead: read.reject };
}

function makeMutatingDisconnectBrowser() {
  const fixture = makeEmptyBrowser();
  const newPage = vi.fn(async () => {
    throw new Error("Target page, context or browser has been closed");
  });
  Object.assign(fixture.browser.contexts()[0]!, { newPage });
  return { ...fixture, newPage };
}

beforeEach(() => {
  getChromeWebSocketUrlSpy.mockResolvedValue(null);
});

describe("pw-session connection scoping", () => {
  it.each(["pending", "cached"] as const)(
    "canceling one enumeration preserves its %s connection for another waiter",
    async (phase) => {
      const gate = createDeferred<void>();
      const started = createDeferred<void>();
      const fixture = makeBrowser("A", "https://a.example/");
      connectOverCdpSpy.mockImplementation(async () => {
        if (phase === "pending") {
          started.resolve();
          await gate.promise;
        }
        return fixture.browser;
      });
      if (phase === "cached") {
        await listPagesViaPlaywright({ cdpUrl });
        vi.spyOn(fixture.browser.contexts()[0]!, "newCDPSession").mockImplementation(
          async () =>
            ({
              send: async () => {
                started.resolve();
                await gate.promise;
                return { targetInfo: { targetId: "A", title: "title:A" } };
              },
              detach: async () => {},
            }) as never,
        );
      }
      const controller = new AbortController();
      const canceled = listPagesViaPlaywright({ cdpUrl, signal: controller.signal });
      const rejected = expect(canceled).rejects.toThrow("cancel one waiter");
      const sibling = listPagesViaPlaywright({ cdpUrl }).then(
        (value) => value,
        (error: unknown) => error,
      );
      try {
        await started.promise;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        controller.abort(new Error("cancel one waiter"));
        await rejected;
        gate.resolve();
        expect(await sibling).toEqual([
          { targetId: "A", title: "title:A", url: "https://a.example/", type: "page" },
        ]);
        expect(fixture.browserClose).not.toHaveBeenCalled();
        expect(connectOverCdpSpy).toHaveBeenCalledOnce();
      } finally {
        gate.resolve();
        await sibling;
      }
    },
  );

  it("reuses a connection published while its endpoint policy check was pending", async () => {
    const gate = createDeferred<void>();
    const started = createDeferred<void>();
    const allowed = vi
      .spyOn(await import("./cdp.helpers.js"), "assertCdpEndpointAllowed")
      .mockImplementationOnce(async () => {
        started.resolve();
        await gate.promise;
        return undefined;
      });
    const browser = makeBrowser("A", "https://a.example/");
    connectOverCdpSpy.mockResolvedValue(browser.browser);
    const first = listPagesViaPlaywright({ cdpUrl });
    try {
      await started.promise;
      await expect(listPagesViaPlaywright({ cdpUrl })).resolves.toMatchObject([{ targetId: "A" }]);
      gate.resolve();
      await first;

      expect(connectOverCdpSpy).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await first;
      allowed.mockRestore();
    }
  });

  it("keeps the exact managed-proxy bypass active through a discovered CDP handshake", async () => {
    const browser = makeBrowser("A", "https://example.com");
    const wsUrl = "ws://127.0.0.1:9222/devtools/browser/discovered";
    const release = vi.fn();
    registerManagedProxyBrowserCdpBypassMock.mockReturnValue(release);
    getChromeWebSocketUrlSpy.mockResolvedValue({ url: wsUrl });
    connectOverCdpSpy.mockImplementationOnce(async () => {
      expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledWith(wsUrl);
      expect(release).not.toHaveBeenCalled();
      return browser.browser;
    });

    await expect(listPagesViaPlaywright({ cdpUrl })).resolves.toEqual([
      expect.objectContaining({ targetId: "A" }),
    ]);

    expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("registers and releases the exact endpoint for both WebSocket connection attempts", async () => {
    const browser = makeBrowser("A", "https://example.com");
    const endpoint = "ws://127.0.0.1:9222/devtools/browser/original";
    const discoveredUrl = "ws://127.0.0.1:9222/devtools/browser/discovered";
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    registerManagedProxyBrowserCdpBypassMock.mockImplementation(() => {
      const release = vi.fn();
      releases.push(release);
      return release;
    });
    getChromeWebSocketUrlSpy.mockResolvedValue({ url: discoveredUrl });
    connectOverCdpSpy
      .mockRejectedValueOnce(new Error("stale discovered endpoint"))
      .mockResolvedValueOnce(browser.browser);

    await expect(listPagesViaPlaywright({ cdpUrl: endpoint })).resolves.toEqual([
      expect.objectContaining({ targetId: "A" }),
    ]);

    expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenNthCalledWith(1, discoveredUrl);
    expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenNthCalledWith(2, endpoint);
    expect(releases).toHaveLength(2);
    for (const release of releases) {
      expect(release).toHaveBeenCalledOnce();
    }
  });

  it("keeps URL credentials out of Playwright and escaped connection errors", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const discoveryStarted = createDeferred<void>();
      const username = "browser-user";
      const password = "browser-password";
      const token = "browser-token";
      const endpoint = `wss://${username}:${password}@browserless.example/devtools/browser/id?token=${token}`;
      connectOverCdpSpy.mockRejectedValue(new Error(`connect failed for ${endpoint}`));
      getChromeWebSocketUrlSpy.mockImplementation(async () => {
        discoveryStarted.resolve();
        return null;
      });

      const message = listPagesViaPlaywright({ cdpUrl: endpoint }).then(
        () => "",
        (err: unknown) => String(err),
      );
      await Promise.all([
        message.then((text) => {
          expect(connectOverCdpSpy).toHaveBeenCalledTimes(3);
          expect(connectOverCdpSpy).toHaveBeenCalledWith(
            "wss://browserless.example/devtools/browser/id?token=browser-token",
            {
              timeout: expect.any(Number),
              headers: {
                Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
              },
            },
          );
          expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledWith(
            "wss://browserless.example/devtools/browser/id?token=browser-token",
          );
          expect(text).toContain("browserless.example/devtools/browser/id");
          expect(text).not.toContain(username);
          expect(text).not.toContain(password);
          expect(text).not.toContain(token);
        }),
        discoveryStarted.promise.then(() => vi.runAllTimersAsync()),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps credentialed HTTP discovery out of Playwright's redirect path", async () => {
    const endpoint = "https://browser-user:browser-password@browserless.example/cdp";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const discoveryStarted = createDeferred<void>();
      getChromeWebSocketUrlSpy.mockImplementation(async () => {
        discoveryStarted.resolve();
        return null;
      });

      await Promise.all([
        expect(listPagesViaPlaywright({ cdpUrl: endpoint })).rejects.toThrow(
          "Authenticated CDP HTTP endpoint did not expose a usable WebSocket URL.",
        ),
        discoveryStarted.promise.then(() => vi.runAllTimersAsync()),
      ]);

      expect(connectOverCdpSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      host: "non-loopback CDP hosts",
      cdpUrl: "http://93.184.216.34:9222",
      ssrfPolicy: { allowPrivateNetwork: true },
      error: "discovery unavailable",
    },
    {
      host: "loopback HTTP CDP hosts",
      cdpUrl,
      ssrfPolicy: {},
      error: "loopback discovery blocked",
    },
  ])(
    "does not fall back to Playwright discovery for guarded $host",
    async ({ cdpUrl: endpoint, ssrfPolicy, error }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const discoveryStarted = createDeferred<void>();
        const discoveryError = new Error(error);
        getChromeWebSocketEndpointSpy.mockImplementation(async () => {
          discoveryStarted.resolve();
          throw discoveryError;
        });

        const connection = listPagesViaPlaywright({ cdpUrl: endpoint, ssrfPolicy });
        await Promise.all([
          expect(connection).rejects.toThrow(
            "Guarded CDP endpoint did not expose a usable WebSocket URL.",
          ),
          expect(connection).rejects.toThrow(error),
          discoveryStarted.promise.then(() => vi.runAllTimersAsync()),
        ]);

        expect(connectOverCdpSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("allows loopback CDP control without widening the navigation allowlist", async () => {
    const browser = makeBrowser("A", "https://example.com");
    connectOverCdpSpy.mockResolvedValue(browser.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue({
      url: "ws://127.0.0.1:9222/devtools/browser/local",
    });
    const ssrfPolicy = {
      dangerouslyAllowPrivateNetwork: true,
      allowedHostnames: ["example.com"],
    };

    const page = await getPageForTargetId({
      cdpUrl,
      ssrfPolicy,
    });

    expect(page.url()).toBe("https://example.com");
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(1);
    expect(ssrfPolicy).toStrictEqual({
      dangerouslyAllowPrivateNetwork: true,
      allowedHostnames: ["example.com"],
    });
  });

  it("does not share in-flight connectOverCDP promises across different cdpUrls", async () => {
    const browserA = makeBrowser("A", "https://a.example");
    const browserB = makeBrowser("B", "https://b.example");
    const pendingBrowser = createDeferred<import("playwright-core").Browser>();
    connectOverCdpSpy
      .mockImplementationOnce(() => pendingBrowser.promise)
      .mockResolvedValueOnce(browserB.browser);

    const pendingA = listPagesViaPlaywright({ cdpUrl });
    await Promise.resolve();
    const pendingB = listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9333" });

    await vi.waitFor(() => {
      expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    });
    expect(connectOverCdpSpy).toHaveBeenNthCalledWith(1, cdpUrl, {
      timeout: 5000,
      headers: {},
    });
    expect(connectOverCdpSpy).toHaveBeenNthCalledWith(2, "http://127.0.0.1:9333", {
      timeout: 5000,
      headers: {},
    });

    pendingBrowser.resolve(browserA.browser);
    const [pagesA, pagesB] = await Promise.all([pendingA, pendingB]);
    expect(pagesA.map((page) => page.targetId)).toEqual(["A"]);
    expect(pagesB.map((page) => page.targetId)).toEqual(["B"]);
  });

  it("waits for an in-flight scoped connection before close returns", async () => {
    const browser = makeBrowser("A", "https://a.example");
    const pendingBrowser = createDeferred<import("playwright-core").Browser>();
    connectOverCdpSpy.mockImplementationOnce(() => pendingBrowser.promise);

    const listing = listPagesViaPlaywright({ cdpUrl });
    await vi.waitFor(() => expect(connectOverCdpSpy).toHaveBeenCalledOnce());
    let closeSettled = false;
    const closing = closePlaywrightBrowserConnection({ cdpUrl }).finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    pendingBrowser.resolve(browser.browser);
    await expect(listing).rejects.toThrow("superseded");
    await expect(closing).resolves.toBeUndefined();
    expect(browser.browserClose).toHaveBeenCalledOnce();
  });

  it("retains a scoped connection until a failed disconnect succeeds on retry", async () => {
    const browser = makeBrowser("A", "https://a.example");
    browser.browserClose
      .mockRejectedValueOnce(new Error("disconnect failed"))
      .mockResolvedValue(undefined);
    connectOverCdpSpy.mockResolvedValue(browser.browser);
    await listPagesViaPlaywright({ cdpUrl });

    await expect(closePlaywrightBrowserConnection({ cdpUrl })).rejects.toThrow("disconnect failed");
    await expect(closePlaywrightBrowserConnection({ cdpUrl })).resolves.toBeUndefined();

    expect(browser.browserClose).toHaveBeenCalledTimes(2);
  });

  it("awaits only the retired adapter after a same-URL successor connects", async () => {
    const first = makeBrowser("A", "https://a.example");
    const closeGate = createDeferred<void>();
    first.browserClose.mockReturnValue(closeGate.promise);
    const successor = makeBrowser("B", "https://b.example");
    connectOverCdpSpy.mockResolvedValueOnce(first.browser).mockResolvedValueOnce(successor.browser);
    await listPagesViaPlaywright({ cdpUrl });

    const retirement = retirePlaywrightBrowserConnectionExact({
      cdpUrl,
    });
    await expect(listPagesViaPlaywright({ cdpUrl })).resolves.toEqual([
      expect.objectContaining({ targetId: "B" }),
    ]);
    expect(retirement.retired).toBe(true);
    expect(first.browserClose).toHaveBeenCalledOnce();
    expect(successor.browserClose).not.toHaveBeenCalled();

    closeGate.resolve();
    await expect(retirement.close()).resolves.toBeUndefined();
    expect(successor.browserClose).not.toHaveBeenCalled();
  });

  it("refreshes one retirement to capture late work before cleanup", async () => {
    const first = makeBrowser("A", "https://a.example");
    const late = makeBrowser("B", "https://b.example");
    connectOverCdpSpy.mockResolvedValueOnce(first.browser).mockResolvedValueOnce(late.browser);
    await listPagesViaPlaywright({ cdpUrl });

    const retirement = retirePlaywrightBrowserConnectionExact({
      cdpUrl,
    });
    await expect(listPagesViaPlaywright({ cdpUrl })).resolves.toEqual([
      expect.objectContaining({ targetId: "B" }),
    ]);
    expect(late.browserClose).not.toHaveBeenCalled();

    expect(retirement.refresh?.()).toBe(true);
    await expect(retirement.close()).resolves.toBeUndefined();
    expect(first.browserClose).toHaveBeenCalledOnce();
    expect(late.browserClose).toHaveBeenCalledOnce();
  });

  it("bounds awaited disconnect verification while retaining the exact adapter", async () => {
    vi.useFakeTimers();
    const browser = makeBrowser("A", "https://a.example");
    const closeGate = createDeferred<void>();
    browser.browserClose.mockReturnValue(closeGate.promise);
    connectOverCdpSpy.mockResolvedValue(browser.browser);
    await listPagesViaPlaywright({ cdpUrl });

    const closing = closePlaywrightBrowserConnection({ cdpUrl });
    const closingExpectation = expect(closing).rejects.toThrow("disconnect timed out");
    await vi.advanceTimersByTimeAsync(2_000);
    await closingExpectation;

    closeGate.resolve();
    await expect(closePlaywrightBrowserConnection({ cdpUrl })).resolves.toBeUndefined();
  });

  it("evicts only the stale cdpUrl when getPageForTargetId retries a cached connection", async () => {
    const staleA = makeEmptyBrowser();
    const refreshedA = makeBrowser("A", "https://a.example/recovered");
    const browserB = makeBrowser("B", "https://b.example");
    let callsForA = 0;

    connectOverCdpSpy.mockImplementation((async (...args: unknown[]) => {
      const endpointText = String(args[0]);
      if (endpointText === cdpUrl) {
        callsForA += 1;
        return callsForA === 1 ? staleA.browser : refreshedA.browser;
      }
      if (endpointText === "http://127.0.0.1:9333") {
        return browserB.browser;
      }
      throw new Error(`unexpected endpoint: ${endpointText}`);
    }) as never);

    await listPagesViaPlaywright({ cdpUrl });
    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9333" });

    const recoveredA = await getPageForTargetId({ cdpUrl });
    const stillCachedB = await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9333" });

    expect(recoveredA.url()).toBe("https://a.example/recovered");
    expect(stillCachedB.url()).toBe("https://b.example");
    expect(staleA.browserClose).toHaveBeenCalledTimes(1);
    expect(refreshedA.browserClose).not.toHaveBeenCalled();
    expect(browserB.browserClose).not.toHaveBeenCalled();
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(3);
  });

  it("does not let a retired pending connect replace or clear its successor", async () => {
    const late = makeBrowser("LATE", "https://late.example");
    const refreshed = makeBrowser("A", "https://a.example/recovered");
    const pendingLate = createDeferred<import("playwright-core").Browser>();
    const pendingRefreshed = createDeferred<import("playwright-core").Browser>();
    connectOverCdpSpy
      .mockImplementationOnce(() => pendingLate.promise)
      .mockImplementation(() => pendingRefreshed.promise);

    await expect(listPagesViaPlaywright({ cdpUrl, timeoutMs: 20 })).rejects.toThrow(
      /Playwright page enumeration timed out after 20ms/,
    );

    retirePlaywrightBrowserConnectionExact({ cdpUrl });

    const successor = listPagesViaPlaywright({
      cdpUrl,
      timeoutMs: 1000,
    });
    await vi.waitFor(() => expect(connectOverCdpSpy).toHaveBeenCalledTimes(2));

    pendingLate.resolve(late.browser);
    await vi.waitFor(() => expect(late.browserClose).toHaveBeenCalledTimes(1));

    const sharedSuccessor = listPagesViaPlaywright({
      cdpUrl,
      timeoutMs: 1000,
    });
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);

    pendingRefreshed.resolve(refreshed.browser);
    const [pages, sharedPages] = await Promise.all([successor, sharedSuccessor]);
    expect(pages.map((page) => page.targetId)).toEqual(["A"]);
    expect(sharedPages.map((page) => page.targetId)).toEqual(["A"]);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    expect(refreshed.browserClose).not.toHaveBeenCalled();
  });

  it("does not let a late failure from a retired read evict its healthy successor", async () => {
    const stuck = makeStuckPageTargetBrowser();
    const refreshed = makeBrowser("A", "https://a.example/recovered");
    connectOverCdpSpy.mockResolvedValueOnce(stuck.browser).mockResolvedValue(refreshed.browser);

    await expect(listPagesViaPlaywright({ cdpUrl, timeoutMs: 20 })).rejects.toThrow(
      /Playwright page enumeration timed out after 20ms/,
    );

    retirePlaywrightBrowserConnectionExact({ cdpUrl });

    const recovered = await listPagesViaPlaywright({
      cdpUrl,
      timeoutMs: 1000,
    });
    expect(recovered.map((page) => page.targetId)).toEqual(["A"]);

    stuck.rejectTargetRead(new Error("Target page, context or browser has been closed"));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    const stillCached = await listPagesViaPlaywright({
      cdpUrl,
      timeoutMs: 1000,
    });
    expect(stillCached.map((page) => page.targetId)).toEqual(["A"]);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    expect(refreshed.browserClose).not.toHaveBeenCalled();
  });

  it("does not let an older enumeration abort disconnect its already-connected successor", async () => {
    const stuck = makeStuckPageTargetBrowser();
    const refreshed = makeBrowser("A", "https://a.example/recovered");
    connectOverCdpSpy.mockResolvedValueOnce(stuck.browser).mockResolvedValue(refreshed.browser);
    const controller = new AbortController();
    const listing = listPagesViaPlaywright({ cdpUrl, signal: controller.signal });
    const rejected = expect(listing).rejects.toThrow("cancelled obsolete enumeration");
    await vi.waitFor(() => expect(stuck.newCDPSession).toHaveBeenCalledOnce());

    await closePlaywrightBrowserConnection({ cdpUrl });
    await expect(listPagesViaPlaywright({ cdpUrl })).resolves.toMatchObject([{ targetId: "A" }]);
    controller.abort(new Error("cancelled obsolete enumeration"));
    await rejected;

    expect(refreshed.browserClose).not.toHaveBeenCalled();
    await expect(listPagesViaPlaywright({ cdpUrl })).resolves.toMatchObject([{ targetId: "A" }]);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    stuck.rejectTargetRead(new Error("Target page, context or browser has been closed"));
  });

  it("does not replay mutating page creation after an ambiguous disconnect", async () => {
    const stale = makeMutatingDisconnectBrowser();
    const refreshed = makeBrowser("A", "https://a.example/recovered");
    let connectCalls = 0;

    connectOverCdpSpy.mockImplementation((async (...args: unknown[]) => {
      const endpointText = String(args[0]);
      if (endpointText !== cdpUrl) {
        throw new Error(`unexpected endpoint: ${endpointText}`);
      }
      connectCalls += 1;
      return connectCalls === 1 ? stale.browser : refreshed.browser;
    }) as never);

    await expect(
      createPageViaPlaywright({
        cdpUrl,
        url: "about:blank",
      }),
    ).rejects.toThrow(/browser has been closed/);

    expect(stale.newPage).toHaveBeenCalledTimes(1);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(1);
  });
});
