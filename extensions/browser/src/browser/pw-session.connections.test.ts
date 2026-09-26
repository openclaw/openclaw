import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
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
  retirePlaywrightBrowserConnection,
  retirePlaywrightBrowserConnectionExact,
} = pwAi;

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

function makeDisconnectedReadBrowser(): BrowserMockBundle {
  const browserClose = vi.fn(async () => {});
  const page = {
    isClosed: () => true,
    on: vi.fn(),
    context: () => context,
    title: vi.fn(async () => {
      throw new Error("Target page, context or browser has been closed");
    }),
    url: vi.fn(() => {
      throw new Error("Target page, context or browser has been closed");
    }),
  } as unknown as import("playwright-core").Page;

  const context: import("playwright-core").BrowserContext = {
    pages: () => [page],
    on: vi.fn(),
    newCDPSession: vi.fn(async () => {
      throw new Error("Target page, context or browser has been closed");
    }),
  } as unknown as import("playwright-core").BrowserContext;

  const browser = {
    isConnected: () => false,
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  return { browser, browserClose };
}

function makeStuckPageTargetBrowser(): BrowserMockBundle & {
  newCDPSession: ReturnType<typeof vi.fn>;
  rejectTargetRead: (error: Error) => void;
} {
  let rejectTargetRead: ((error: Error) => void) | undefined;
  const browserClose = vi.fn(async () => {});
  const page = {
    on: vi.fn(),
    context: () => context,
    title: vi.fn(async () => "never reached"),
    url: vi.fn(() => "https://stuck.example"),
  } as unknown as import("playwright-core").Page;

  const newCDPSession = vi.fn(
    () =>
      new Promise((_, reject) => {
        rejectTargetRead = reject;
      }),
  );
  const context = {
    pages: () => [page],
    on: vi.fn(),
    newCDPSession,
  } as unknown as import("playwright-core").BrowserContext;

  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  return {
    browser,
    browserClose,
    newCDPSession,
    rejectTargetRead: (error) => rejectTargetRead?.(error),
  };
}

function makeMutatingDisconnectBrowser(): BrowserMockBundle & {
  newPage: ReturnType<typeof vi.fn>;
} {
  const browserClose = vi.fn(async () => {});
  const newPage = vi.fn(async () => {
    throw new Error("Target page, context or browser has been closed");
  });
  const context = {
    pages: () => [],
    on: vi.fn(),
    newCDPSession: vi.fn(),
    newPage,
  } as unknown as import("playwright-core").BrowserContext;

  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  return { browser, browserClose, newPage };
}

describe("pw-session connection scoping", () => {
  it.each(["pending", "cached"] as const)(
    "canceling one enumeration preserves its %s connection for another waiter",
    async (phase) => {
      const cdpUrl = "http://127.0.0.1:9222";
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
      getChromeWebSocketUrlSpy.mockResolvedValue(null);
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
    const cdpUrl = "http://127.0.0.1:9222";
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
    getChromeWebSocketUrlSpy.mockResolvedValue(null);
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

    await expect(listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" })).resolves.toEqual([
      expect.objectContaining({ targetId: "A" }),
    ]);

    expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("registers only the credential-stripped Playwright CDP endpoint", async () => {
    const browser = makeBrowser("A", "https://example.com");
    const cdpUrl = "wss://browser-user:browser-password@browserless.example/devtools/browser/id";
    connectOverCdpSpy.mockResolvedValue(browser.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await listPagesViaPlaywright({ cdpUrl });

    expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledWith(
      "wss://browserless.example/devtools/browser/id",
    );
  });

  it("releases every managed-proxy bypass after failed CDP connection attempts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const discoveryStarted = createDeferred<void>();
      const releases: Array<ReturnType<typeof vi.fn>> = [];
      registerManagedProxyBrowserCdpBypassMock.mockImplementation(() => {
        const release = vi.fn();
        releases.push(release);
        return release;
      });
      connectOverCdpSpy.mockRejectedValue(new Error("CDP socket hang up"));
      getChromeWebSocketUrlSpy.mockImplementation(async () => {
        discoveryStarted.resolve();
        return null;
      });

      await Promise.all([
        expect(listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" })).rejects.toThrow(
          "CDP socket hang up",
        ),
        discoveryStarted.promise.then(() => vi.runAllTimersAsync()),
      ]);

      expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenCalledTimes(3);
      expect(releases).toHaveLength(3);
      for (const release of releases) {
        expect(release).toHaveBeenCalledOnce();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers and releases the exact endpoint for both WebSocket connection attempts", async () => {
    const browser = makeBrowser("A", "https://example.com");
    const cdpUrl = "ws://127.0.0.1:9222/devtools/browser/original";
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

    await expect(listPagesViaPlaywright({ cdpUrl })).resolves.toEqual([
      expect.objectContaining({ targetId: "A" }),
    ]);

    expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenNthCalledWith(1, discoveredUrl);
    expect(registerManagedProxyBrowserCdpBypassMock).toHaveBeenNthCalledWith(2, cdpUrl);
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
      const cdpUrl = `wss://${username}:${password}@browserless.example/devtools/browser/id?token=${token}`;
      connectOverCdpSpy.mockRejectedValue(new Error(`connect failed for ${cdpUrl}`));
      getChromeWebSocketUrlSpy.mockImplementation(async () => {
        discoveryStarted.resolve();
        return null;
      });

      const message = listPagesViaPlaywright({ cdpUrl }).then(
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
    const cdpUrl = "https://browser-user:browser-password@browserless.example/cdp";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const discoveryStarted = createDeferred<void>();
      getChromeWebSocketUrlSpy.mockImplementation(async () => {
        discoveryStarted.resolve();
        return null;
      });

      await Promise.all([
        expect(listPagesViaPlaywright({ cdpUrl })).rejects.toThrow(
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
      cdpUrl: "http://127.0.0.1:9222",
      ssrfPolicy: {},
      error: "loopback discovery blocked",
    },
  ])(
    "does not fall back to Playwright discovery for guarded $host",
    async ({ cdpUrl, ssrfPolicy, error }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const discoveryStarted = createDeferred<void>();
        const discoveryError = new Error(error);
        getChromeWebSocketEndpointSpy.mockImplementation(async () => {
          discoveryStarted.resolve();
          throw discoveryError;
        });

        const connection = listPagesViaPlaywright({ cdpUrl, ssrfPolicy });
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
      cdpUrl: "http://127.0.0.1:9222",
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
    let resolveA: ((value: import("playwright-core").Browser) => void) | undefined;

    connectOverCdpSpy.mockImplementation((async (...args: unknown[]) => {
      const endpointText = String(args[0]);
      if (endpointText === "http://127.0.0.1:9222") {
        return await new Promise<import("playwright-core").Browser>((resolve) => {
          resolveA = resolve;
        });
      }
      if (endpointText === "http://127.0.0.1:9333") {
        return browserB.browser;
      }
      throw new Error(`unexpected endpoint: ${endpointText}`);
    }) as never);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    const pendingA = listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });
    await Promise.resolve();
    const pendingB = listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9333" });

    await vi.waitFor(() => {
      expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    });
    expect(connectOverCdpSpy).toHaveBeenNthCalledWith(1, "http://127.0.0.1:9222", {
      timeout: 5000,
      headers: {},
    });
    expect(connectOverCdpSpy).toHaveBeenNthCalledWith(2, "http://127.0.0.1:9333", {
      timeout: 5000,
      headers: {},
    });

    resolveA?.(browserA.browser);
    const [pagesA, pagesB] = await Promise.all([pendingA, pendingB]);
    expect(pagesA.map((page) => page.targetId)).toEqual(["A"]);
    expect(pagesB.map((page) => page.targetId)).toEqual(["B"]);
  });

  it("closes only the requested scoped connection", async () => {
    const browserA = makeBrowser("A", "https://a.example");
    const browserB = makeBrowser("B", "https://b.example");

    connectOverCdpSpy.mockImplementation((async (...args: unknown[]) => {
      const endpointText = String(args[0]);
      if (endpointText === "http://127.0.0.1:9222") {
        return browserA.browser;
      }
      if (endpointText === "http://127.0.0.1:9333") {
        return browserB.browser;
      }
      throw new Error(`unexpected endpoint: ${endpointText}`);
    }) as never);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });
    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9333" });

    await closePlaywrightBrowserConnection({ cdpUrl: "http://127.0.0.1:9222" });

    expect(browserA.browserClose).toHaveBeenCalledTimes(1);
    expect(browserB.browserClose).not.toHaveBeenCalled();
  });

  it("waits for an in-flight scoped connection before close returns", async () => {
    const browser = makeBrowser("A", "https://a.example");
    let resolveConnect!: (value: import("playwright-core").Browser) => void;
    connectOverCdpSpy.mockImplementationOnce(
      async () =>
        await new Promise<import("playwright-core").Browser>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    const listing = listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });
    await vi.waitFor(() => expect(connectOverCdpSpy).toHaveBeenCalledOnce());
    let closeSettled = false;
    const closing = closePlaywrightBrowserConnection({ cdpUrl: "http://127.0.0.1:9222" }).finally(
      () => {
        closeSettled = true;
      },
    );
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    resolveConnect(browser.browser);
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
    getChromeWebSocketUrlSpy.mockResolvedValue(null);
    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });

    await expect(
      closePlaywrightBrowserConnection({ cdpUrl: "http://127.0.0.1:9222" }),
    ).rejects.toThrow("disconnect failed");
    await expect(
      closePlaywrightBrowserConnection({ cdpUrl: "http://127.0.0.1:9222" }),
    ).resolves.toBeUndefined();

    expect(browser.browserClose).toHaveBeenCalledTimes(2);
  });

  it("retires a scoped adapter without waiting for a hung CDP disconnect", async () => {
    const first = makeBrowser("A", "https://a.example");
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    first.browserClose.mockReturnValue(closeGate);
    const second = makeBrowser("B", "https://b.example");
    connectOverCdpSpy.mockResolvedValueOnce(first.browser).mockResolvedValueOnce(second.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);
    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });

    expect(retirePlaywrightBrowserConnection({ cdpUrl: "http://127.0.0.1:9222" })).toBe(true);
    await expect(listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" })).resolves.toEqual([
      expect.objectContaining({ targetId: "B" }),
    ]);
    expect(first.browserClose).toHaveBeenCalledOnce();

    releaseClose();
  });

  it("awaits only the retired adapter after a same-URL successor connects", async () => {
    const first = makeBrowser("A", "https://a.example");
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    first.browserClose.mockReturnValue(closeGate);
    const successor = makeBrowser("B", "https://b.example");
    connectOverCdpSpy.mockResolvedValueOnce(first.browser).mockResolvedValueOnce(successor.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);
    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });

    const retirement = retirePlaywrightBrowserConnectionExact({
      cdpUrl: "http://127.0.0.1:9222",
    });
    await expect(listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" })).resolves.toEqual([
      expect.objectContaining({ targetId: "B" }),
    ]);
    expect(retirement.retired).toBe(true);
    expect(first.browserClose).toHaveBeenCalledOnce();
    expect(successor.browserClose).not.toHaveBeenCalled();

    releaseClose();
    await expect(retirement.close()).resolves.toBeUndefined();
    expect(successor.browserClose).not.toHaveBeenCalled();
  });

  it("refreshes one retirement to capture late work before cleanup", async () => {
    const first = makeBrowser("A", "https://a.example");
    const late = makeBrowser("B", "https://b.example");
    connectOverCdpSpy.mockResolvedValueOnce(first.browser).mockResolvedValueOnce(late.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);
    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });

    const retirement = retirePlaywrightBrowserConnectionExact({
      cdpUrl: "http://127.0.0.1:9222",
    });
    await expect(listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" })).resolves.toEqual([
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
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    browser.browserClose.mockReturnValue(closeGate);
    connectOverCdpSpy.mockResolvedValue(browser.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);
    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });

    const closing = closePlaywrightBrowserConnection({ cdpUrl: "http://127.0.0.1:9222" });
    const closingExpectation = expect(closing).rejects.toThrow("disconnect timed out");
    await vi.advanceTimersByTimeAsync(2_000);
    await closingExpectation;

    releaseClose();
    await expect(
      closePlaywrightBrowserConnection({ cdpUrl: "http://127.0.0.1:9222" }),
    ).resolves.toBeUndefined();
  });

  it("evicts only the stale cdpUrl when getPageForTargetId retries a cached connection", async () => {
    const staleA = makeEmptyBrowser();
    const refreshedA = makeBrowser("A", "https://a.example/recovered");
    const browserB = makeBrowser("B", "https://b.example");
    let callsForA = 0;

    connectOverCdpSpy.mockImplementation((async (...args: unknown[]) => {
      const endpointText = String(args[0]);
      if (endpointText === "http://127.0.0.1:9222") {
        callsForA += 1;
        return callsForA === 1 ? staleA.browser : refreshedA.browser;
      }
      if (endpointText === "http://127.0.0.1:9333") {
        return browserB.browser;
      }
      throw new Error(`unexpected endpoint: ${endpointText}`);
    }) as never);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });
    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9333" });

    const recoveredA = await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9222" });
    const stillCachedB = await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9333" });

    expect(recoveredA.url()).toBe("https://a.example/recovered");
    expect(stillCachedB.url()).toBe("https://b.example");
    expect(staleA.browserClose).toHaveBeenCalledTimes(1);
    expect(refreshedA.browserClose).not.toHaveBeenCalled();
    expect(browserB.browserClose).not.toHaveBeenCalled();
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(3);
  });

  it("reconnects listPagesViaPlaywright once after a cached transport disconnect", async () => {
    const stale = makeDisconnectedReadBrowser();
    const refreshed = makeBrowser("A", "https://a.example/recovered");
    let connectCalls = 0;

    connectOverCdpSpy.mockImplementation((async (...args: unknown[]) => {
      const endpointText = String(args[0]);
      if (endpointText !== "http://127.0.0.1:9222") {
        throw new Error(`unexpected endpoint: ${endpointText}`);
      }
      connectCalls += 1;
      return connectCalls === 1 ? stale.browser : refreshed.browser;
    }) as never);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    const pages = await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });

    expect(pages.map((page) => page.targetId)).toEqual(["A"]);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(stale.browserClose).toHaveBeenCalledTimes(1));
    expect(refreshed.browserClose).not.toHaveBeenCalled();
  });

  it("allows lifecycle retirement to recover a timed-out page enumeration", async () => {
    const stuck = makeStuckPageTargetBrowser();
    const refreshed = makeBrowser("A", "https://a.example/recovered");
    let connectCalls = 0;

    connectOverCdpSpy.mockImplementation((async (...args: unknown[]) => {
      const endpointText = String(args[0]);
      if (endpointText !== "http://127.0.0.1:9222") {
        throw new Error(`unexpected endpoint: ${endpointText}`);
      }
      connectCalls += 1;
      return connectCalls === 1 ? stuck.browser : refreshed.browser;
    }) as never);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await expect(
      listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222", timeoutMs: 20 }),
    ).rejects.toThrow(/Playwright page enumeration timed out after 20ms/);

    retirePlaywrightBrowserConnection({ cdpUrl: "http://127.0.0.1:9222" });

    await vi.waitFor(() => expect(stuck.browserClose).toHaveBeenCalledTimes(1));

    const pages = await listPagesViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      timeoutMs: 1000,
    });

    expect(pages.map((page) => page.targetId)).toEqual(["A"]);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    expect(refreshed.browserClose).not.toHaveBeenCalled();
  });

  it("does not let a retired pending connect replace or clear its successor", async () => {
    const late = makeBrowser("LATE", "https://late.example");
    const refreshed = makeBrowser("A", "https://a.example/recovered");
    let resolveLate: ((browser: import("playwright-core").Browser) => void) | undefined;
    let resolveRefreshed: ((browser: import("playwright-core").Browser) => void) | undefined;
    let connectCalls = 0;

    connectOverCdpSpy.mockImplementation((async () => {
      connectCalls += 1;
      return await new Promise<import("playwright-core").Browser>((resolve) => {
        if (connectCalls === 1) {
          resolveLate = resolve;
        } else {
          resolveRefreshed = resolve;
        }
      });
    }) as never);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await expect(
      listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222", timeoutMs: 20 }),
    ).rejects.toThrow(/Playwright page enumeration timed out after 20ms/);

    retirePlaywrightBrowserConnection({ cdpUrl: "http://127.0.0.1:9222" });

    const successor = listPagesViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      timeoutMs: 1000,
    });
    await vi.waitFor(() => expect(connectOverCdpSpy).toHaveBeenCalledTimes(2));

    resolveLate?.(late.browser);
    await vi.waitFor(() => expect(late.browserClose).toHaveBeenCalledTimes(1));

    const sharedSuccessor = listPagesViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      timeoutMs: 1000,
    });
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);

    resolveRefreshed?.(refreshed.browser);
    const [pages, sharedPages] = await Promise.all([successor, sharedSuccessor]);
    expect(pages.map((page) => page.targetId)).toEqual(["A"]);
    expect(sharedPages.map((page) => page.targetId)).toEqual(["A"]);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    expect(refreshed.browserClose).not.toHaveBeenCalled();
  });

  it("does not let a late failure from a retired read evict its healthy successor", async () => {
    const stuck = makeStuckPageTargetBrowser();
    const refreshed = makeBrowser("A", "https://a.example/recovered");
    let connectCalls = 0;

    connectOverCdpSpy.mockImplementation((async () => {
      connectCalls += 1;
      return connectCalls === 1 ? stuck.browser : refreshed.browser;
    }) as never);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await expect(
      listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222", timeoutMs: 20 }),
    ).rejects.toThrow(/Playwright page enumeration timed out after 20ms/);

    retirePlaywrightBrowserConnection({ cdpUrl: "http://127.0.0.1:9222" });

    const recovered = await listPagesViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      timeoutMs: 1000,
    });
    expect(recovered.map((page) => page.targetId)).toEqual(["A"]);

    stuck.rejectTargetRead(new Error("Target page, context or browser has been closed"));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    const stillCached = await listPagesViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      timeoutMs: 1000,
    });
    expect(stillCached.map((page) => page.targetId)).toEqual(["A"]);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    expect(refreshed.browserClose).not.toHaveBeenCalled();
  });

  it("does not let an older enumeration abort disconnect its already-connected successor", async () => {
    const cdpUrl = "http://127.0.0.1:9222";
    const stuck = makeStuckPageTargetBrowser();
    const refreshed = makeBrowser("A", "https://a.example/recovered");
    connectOverCdpSpy.mockResolvedValueOnce(stuck.browser).mockResolvedValue(refreshed.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);
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
      if (endpointText !== "http://127.0.0.1:9222") {
        throw new Error(`unexpected endpoint: ${endpointText}`);
      }
      connectCalls += 1;
      return connectCalls === 1 ? stale.browser : refreshed.browser;
    }) as never);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await expect(
      createPageViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        url: "about:blank",
      }),
    ).rejects.toThrow(/browser has been closed/);

    expect(stale.newPage).toHaveBeenCalledTimes(1);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(1);
  });
});
