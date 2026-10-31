import { EventEmitter, getEventListeners } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupPwSessionConnectionTest } from "./pw-session.connection.test-support.js";

// These fixtures count native-inventory browser sessions; keep the connection's
// one-time headless probe out of them.
vi.mock("./pw-session-webauthn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pw-session-webauthn.js")>()),
  isHeadlessChromium: async () => false,
}));

const { connectOverCdpSpy, getChromeWebSocketUrlSpy, markPageRefBlocked, markTargetBlocked, pwAi } =
  setupPwSessionConnectionTest();

const {
  closePageByTargetIdViaPlaywright,
  focusPageByTargetIdViaPlaywright,
  listPagesViaPlaywright,
} = pwAi;

const cdpUrl = "http://127.0.0.1:9222";

function tab(targetId: string, title: string, url: string) {
  return { targetId, title, url };
}
const expectedTabs = (...tabs: ReturnType<typeof tab>[]) =>
  tabs.map(({ targetId, title, url }) => ({ targetId, title, url, type: "page" }));
const stuck = (suffix: "A" | "B") => ({
  ...tab(`STUCK_${suffix}`, `Stuck ${suffix}`, `https://stuck-${suffix.toLowerCase()}.example`),
  readTargetInfo: () => new Promise<never>(() => {}),
});

function makePageEnumerationBrowser(
  specs: Array<{
    targetId: string;
    title: string;
    url: string;
    readTitle?: () => Promise<string>;
    readTargetInfo?: () => Promise<{ targetInfo: { targetId: string; title: string } }>;
    isClosed?: () => boolean;
    detach?: () => Promise<void>;
    published?: boolean;
  }>,
) {
  const browserClose = vi.fn(async () => {});
  const specByPage = new WeakMap<import("playwright-core").Page, (typeof specs)[number]>();
  const pageEvents: EventEmitter[] = [];
  const pages = specs
    .filter((spec) => spec.published !== false)
    .map((spec) => {
      const events = new EventEmitter();
      pageEvents.push(events);
      const page = {
        on: events.on.bind(events),
        off: events.off.bind(events),
        context: () => context,
        title: vi.fn(spec.readTitle ?? (async () => spec.title)),
        url: vi.fn(() => spec.url),
        isClosed: spec.isClosed ?? (() => false),
      } as unknown as import("playwright-core").Page;
      specByPage.set(page, spec);
      return page;
    });
  const newCDPSession = vi.fn(async (page: import("playwright-core").Page) => {
    const spec = specByPage.get(page);
    if (!spec) {
      throw new Error("unexpected page");
    }
    return {
      send: vi.fn(async (method: string) => {
        if (method !== "Target.getTargetInfo") {
          return {};
        }
        return await (spec.readTargetInfo?.() ??
          Promise.resolve({ targetInfo: { targetId: spec.targetId, title: spec.title } }));
      }),
      detach: vi.fn(spec.detach ?? (async () => {})),
    };
  });
  const contextEvents = new EventEmitter();
  const browserEvents = new EventEmitter();
  const context = {
    pages: () => pages.filter((page) => !page.isClosed()),
    on: contextEvents.on.bind(contextEvents),
    off: contextEvents.off.bind(contextEvents),
    newCDPSession,
  } as unknown as import("playwright-core").BrowserContext;
  const browser = {
    contexts: () => [context],
    on: browserEvents.on.bind(browserEvents),
    off: browserEvents.off.bind(browserEvents),
    close: browserClose,
    isConnected: vi.fn(() => true),
    newBrowserCDPSession: vi.fn(async () => ({
      send: vi.fn(async () => ({
        targetInfos: specs
          .filter((spec) => !spec.isClosed?.())
          .map((spec) => ({ targetId: spec.targetId, type: "page", url: spec.url })),
      })),
      detach: vi.fn(async () => {}),
    })),
  } as unknown as import("playwright-core").Browser;

  return { browser, browserClose, pages, newCDPSession, contextEvents, browserEvents, pageEvents };
}

type EnumerationBrowser = ReturnType<typeof makePageEnumerationBrowser>;
function installInventory(fixture: EnumerationBrowser, send: () => Promise<unknown>) {
  const detach = vi.fn(async () => {});
  Object.assign(fixture.browser, { newBrowserCDPSession: async () => ({ send, detach }) });
  return detach;
}
function expectObservedConnection(fixture: EnumerationBrowser) {
  expect(connectOverCdpSpy).toHaveBeenCalledOnce();
  expect(fixture.browserClose).not.toHaveBeenCalled();
  expect(fixture.contextEvents.listenerCount("page")).toBe(1);
  expect(fixture.browserEvents.listenerCount("disconnected")).toBe(1);
}

beforeEach(() => {
  getChromeWebSocketUrlSpy.mockResolvedValue(null);
});

describe("pw-session page enumeration", () => {
  it("does not wait for an extension-internal target that Playwright does not publish", async () => {
    const fixture = makePageEnumerationBrowser([
      {
        targetId: "EXTENSION",
        title: "Other extension",
        url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html",
        published: false,
      },
      tab("GOODREADS", "My Books", "https://www.goodreads.com/review/list"),
    ]);
    connectOverCdpSpy.mockResolvedValue(fixture.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await expect(
      listPagesViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        requireCompleteTargetList: true,
      }),
    ).resolves.toEqual(
      expectedTabs(tab("GOODREADS", "My Books", "https://www.goodreads.com/review/list")),
    );
  });

  it("reconciles a page closed between native discovery and Page enumeration", async () => {
    vi.useFakeTimers();
    let closed = false;
    const fixture = makePageEnumerationBrowser([
      { ...tab("A", "Closing", "https://a.example/"), isClosed: () => closed },
      tab("B", "Survivor", "https://b.example/"),
    ]);
    const inventory = vi.fn(async () => {
      const targetIds = closed ? ["B"] : ["A", "B"];
      if (!closed) {
        closed = true;
        fixture.pageEvents[0]!.emit("close");
      }
      return { targetInfos: targetIds.map((targetId) => ({ targetId, type: "page" })) };
    });
    installInventory(fixture, inventory);
    connectOverCdpSpy.mockResolvedValue(fixture.browser);
    const requireCompleteTargetList = true;
    const listing = listPagesViaPlaywright({ cdpUrl, requireCompleteTargetList, timeoutMs: 100 });
    const result = expect(listing).resolves.toEqual(
      expectedTabs(tab("B", "Survivor", "https://b.example/")),
    );
    void result.catch(() => {});
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(inventory).toHaveBeenCalledTimes(2);
    expect(connectOverCdpSpy).toHaveBeenCalledOnce();
    expect(fixture.browserClose).not.toHaveBeenCalled();
    expect(fixture.pageEvents.map((events) => events.listenerCount("close"))).toEqual([1, 1]);
  });

  it.each([
    { disconnect: false, unresolved: false },
    { disconnect: true, unresolved: true },
  ])(
    "reconciles a closed page (disconnected: $disconnect, metadata unresolved: $unresolved)",
    async ({ disconnect, unresolved }) => {
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      let closed = false;
      const fixture = makePageEnumerationBrowser([
        {
          ...tab("A", "Closing", "https://a.example/"),
          isClosed: () => closed,
          readTargetInfo: async () => {
            started.resolve();
            await release.promise;
            if (unresolved) {
              return { targetInfo: { targetId: "", title: "" } };
            }
            throw new Error("Target page, context or browser has been closed");
          },
        },
        tab("B", "Survivor", "https://b.example/"),
      ]);
      const survivor = { ...tab("B", "Survivor", "https://b.example/"), type: "page" };
      const replacement = makePageEnumerationBrowser([survivor]);
      connectOverCdpSpy
        .mockResolvedValueOnce(fixture.browser)
        .mockResolvedValue(replacement.browser);
      const listing = listPagesViaPlaywright({
        cdpUrl,
        requireCompleteTargetList: true,
        timeoutMs: 1_000,
      });
      const listed = expect(listing).resolves.toEqual([survivor]);
      void listed.catch(() => {});
      await started.promise;
      closed = true;
      if (disconnect) {
        vi.spyOn(fixture.browser, "isConnected").mockReturnValue(false);
        fixture.browserEvents.emit("disconnected");
      }
      release.resolve();
      await listed;
      expect(connectOverCdpSpy).toHaveBeenCalledTimes(disconnect ? 2 : 1);
      if (!disconnect) {
        expect(fixture.browserClose).not.toHaveBeenCalled();
      }
      expect(replacement.browserClose).not.toHaveBeenCalled();
    },
  );

  it("times out stuck target-info reads in one window and shares them across enumerations", async () => {
    vi.useFakeTimers();
    const fixture = makePageEnumerationBrowser([
      { ...stuck("A"), detach: () => new Promise(() => {}) },
      { ...stuck("B"), detach: () => new Promise(() => {}) },
      {
        ...tab("HEALTHY", "Healthy title", "https://healthy.example"),
        readTitle: () => new Promise<string>(() => {}),
      },
    ]);
    connectOverCdpSpy.mockResolvedValue(fixture.browser);

    let listed: Array<Awaited<ReturnType<typeof listPagesViaPlaywright>>> | undefined;
    void Promise.all([listPagesViaPlaywright({ cdpUrl }), listPagesViaPlaywright({ cdpUrl })]).then(
      (pages) => {
        listed = pages;
      },
    );
    await vi.advanceTimersByTimeAsync(2_000);

    const healthy = [
      { ...tab("HEALTHY", "Healthy title", "https://healthy.example"), type: "page" },
    ];
    expect(listed).toEqual([healthy, healthy]);
    expect(
      fixture.pages
        .slice(0, 2)
        .map(
          (page) =>
            fixture.newCDPSession.mock.calls.filter(([candidate]) => candidate === page).length,
        ),
    ).toEqual([1, 1]);
  });

  it("reports unavailable when every accessible page identity is unresolved", async () => {
    vi.useFakeTimers();
    const fixture = makePageEnumerationBrowser([stuck("A"), stuck("B")]);
    connectOverCdpSpy.mockResolvedValue(fixture.browser);

    const listing = listPagesViaPlaywright({ cdpUrl });
    const unavailable = expect(listing).rejects.toThrow(/target identities.*unavailable/i);
    await vi.advanceTimersByTimeAsync(2_000);

    await unavailable;
  });

  it.each(["during discovery", "after discovery", "during metadata"] as const)(
    "observes pages published %s without repeating the complete target inventory",
    async (timing) => {
      const metadataRead = createDeferred<void>();
      const releaseMetadata = createDeferred<void>();
      const fixture = makePageEnumerationBrowser([
        {
          ...tab("EXISTING", "Existing", "https://existing.example"),
          readTargetInfo: async () => {
            metadataRead.resolve();
            if (timing === "during metadata") {
              await releaseMetadata.promise;
            }
            return { targetInfo: { targetId: "EXISTING", title: "Existing" } };
          },
        },
        tab("RECOVERED", "Recovered", "https://recovered.example"),
      ]);
      let published = false;
      const context = fixture.browser.contexts()[0]!;
      vi.spyOn(context, "pages").mockImplementation(() =>
        published ? fixture.pages : fixture.pages.slice(0, 1),
      );
      const publish = () => {
        published = true;
        fixture.contextEvents.emit("page", fixture.pages[1]);
      };
      const inventoryRead = vi.fn(async () => {
        if (timing === "during discovery") {
          publish();
        }
        return {
          targetInfos: [
            { targetId: "EXISTING", type: "page" },
            { targetId: "RECOVERED", type: "page", title: "native title" },
          ],
        };
      });
      installInventory(fixture, inventoryRead);
      connectOverCdpSpy.mockResolvedValue(fixture.browser);

      const listing = listPagesViaPlaywright({ cdpUrl, requireCompleteTargetList: true });
      const result = expect(listing).resolves.toEqual(
        expectedTabs(
          tab("EXISTING", "Existing", "https://existing.example"),
          tab("RECOVERED", "Recovered", "https://recovered.example"),
        ),
      );
      void result.catch(() => {});
      await metadataRead.promise;
      if (timing === "after discovery") {
        // Let the first page read finish before the recovered Page exists.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      if (timing !== "during discovery") {
        publish();
        releaseMetadata.resolve();
      }
      await result;
      expect(inventoryRead).toHaveBeenCalledOnce();
      expectObservedConnection(fixture);
    },
  );

  it.each(["rejected-metadata", "blocked-target", "unresolved-blocked-page"] as const)(
    "enforces enumeration completeness: %s",
    async (mode) => {
      vi.useFakeTimers();
      const blockedPage = mode === "unresolved-blocked-page";
      const fixture = makePageEnumerationBrowser(
        ["A", "B"].map((targetId) => ({
          targetId,
          title: `projected:${targetId}`,
          url: "https://same.example/",
          readTargetInfo: async () => {
            if (targetId === "B" && mode === "rejected-metadata") {
              throw new Error("Target metadata unavailable");
            }
            return {
              targetInfo: {
                targetId: targetId === "B" && blockedPage ? "" : targetId,
                title: `projected:${targetId}`,
              },
            };
          },
        })),
      );
      const inventoryRead = vi.fn(async () => ({
        targetInfos: [
          ...["A", "B"].map((targetId) => ({
            targetId,
            type: "page",
            title: "native title",
            url: "https://native.example/",
          })),
          { targetId: "WORKER", type: "service_worker" },
        ],
      }));
      const detach = installInventory(fixture, inventoryRead);
      connectOverCdpSpy.mockResolvedValue(fixture.browser);
      if (mode === "blocked-target") {
        markTargetBlocked(cdpUrl, "B");
      }
      if (blockedPage) {
        markPageRefBlocked(cdpUrl, fixture.pages[1]!);
      }
      const listing = listPagesViaPlaywright({
        cdpUrl,
        requireCompleteTargetList: true,
        timeoutMs: 100,
      });
      if (mode === "blocked-target") {
        await expect(listing).resolves.toEqual([
          { targetId: "A", title: "projected:A", url: "https://same.example/", type: "page" },
        ]);
      } else {
        const rejected = expect(listing).rejects.toThrow(
          blockedPage
            ? "Playwright page enumeration timed out after 100ms"
            : /target identities.*unavailable/i,
        );
        await vi.advanceTimersByTimeAsync(100);
        await rejected;
      }
      expect(inventoryRead).toHaveBeenCalledOnce();
      expect(detach).toHaveBeenCalledOnce();
      expectObservedConnection(fixture);
      if (blockedPage) {
        expect(fixture.newCDPSession).not.toHaveBeenCalledWith(fixture.pages[1]);
      }
    },
  );

  it.each(["abort", "disconnect"] as const)("releases a publication wait on %s", async (stop) => {
    const specs = [tab("A", "A", "https://a.example/")];
    const fixture = makePageEnumerationBrowser(specs);
    const context = fixture.browser.contexts()[0]!;
    vi.spyOn(context, "pages").mockReturnValue([]);
    const inventoryRead = createDeferred<void>();
    installInventory(fixture, async () => {
      inventoryRead.resolve();
      return { targetInfos: [{ targetId: "A", type: "page" }] };
    });
    const successor = makePageEnumerationBrowser(specs);
    connectOverCdpSpy.mockResolvedValueOnce(fixture.browser).mockResolvedValue(successor.browser);
    const controller = new AbortController();
    const listing = listPagesViaPlaywright({
      cdpUrl,
      requireCompleteTargetList: true,
      signal: controller.signal,
    });
    const result =
      stop === "abort"
        ? expect(listing).rejects.toThrow("cancelled publication")
        : expect(listing).resolves.toEqual([{ ...specs[0], type: "page" }]);
    void result.catch(() => {});
    await inventoryRead.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    if (stop === "abort") {
      controller.abort(new Error("cancelled publication"));
    } else {
      fixture.browserEvents.emit("disconnected");
    }
    await result;
    fixture.contextEvents.emit("page", fixture.pages[0]);
    expect(fixture.newCDPSession).not.toHaveBeenCalled();
    expect(fixture.contextEvents.listenerCount("page")).toBe(1);
    expect(fixture.browserEvents.listenerCount("disconnected")).toBe(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(stop === "abort" ? 1 : 2);
    expect(successor.browserClose).not.toHaveBeenCalled();
  });

  it.each(["attach", "read"] as const)(
    "releases only its own native inventory session when cancelled during %s",
    async (phase) => {
      const fixture = makePageEnumerationBrowser([tab("A", "A", "https://a.example/")]);
      const gate = createDeferred<void>();
      const started = createDeferred<void>();
      const detach = vi.fn(async () => {});
      const send = vi.fn(async () => {
        if (phase === "read") {
          started.resolve();
          await gate.promise;
        }
        return { targetInfos: [{ targetId: "A", type: "page" }] };
      });
      Object.assign(fixture.browser, {
        newBrowserCDPSession: async () => {
          if (phase === "attach") {
            started.resolve();
            await gate.promise;
          }
          return { send, detach };
        },
      });
      connectOverCdpSpy.mockResolvedValue(fixture.browser);
      const controller = new AbortController();
      const listing = listPagesViaPlaywright({
        cdpUrl,
        requireCompleteTargetList: true,
        signal: controller.signal,
      });
      const rejected = expect(listing).rejects.toThrow("cancel native inventory");
      await started.promise;
      controller.abort(new Error("cancel native inventory"));
      await rejected;
      gate.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(detach).toHaveBeenCalledOnce();
      if (phase === "attach") {
        expect(send).not.toHaveBeenCalled();
      }
      expect(fixture.browserClose).not.toHaveBeenCalled();
      await expect(listPagesViaPlaywright({ cdpUrl })).resolves.toMatchObject([{ targetId: "A" }]);
    },
  );

  it.each([
    ["focus", focusPageByTargetIdViaPlaywright, "bringToFront"],
    ["close", closePageByTargetIdViaPlaywright, "close"],
  ] as const)(
    "does not %s after cancellation during target resolution",
    async (_name, run, method) => {
      const targetInfoStarted = createDeferred<void>();
      const targetInfoReleased = createDeferred<void>();
      const fixture = makePageEnumerationBrowser([
        {
          ...tab("T1", "Tab 1", "https://example.com"),
          readTargetInfo: async () => {
            targetInfoStarted.resolve();
            await targetInfoReleased.promise;
            return { targetInfo: { targetId: "T1", title: "Tab 1" } };
          },
        },
      ]);
      const finalIo = vi.fn(async () => {});
      Object.assign(fixture.pages[0]!, { [method]: finalIo });
      connectOverCdpSpy.mockResolvedValue(fixture.browser);

      const controller = new AbortController();
      const operation = run({
        cdpUrl,
        targetId: "T1",
        signal: controller.signal,
      });
      await targetInfoStarted.promise;
      controller.abort(new Error("cancelled target resolution"));
      targetInfoReleased.resolve();

      await expect(operation).rejects.toThrow("cancelled target resolution");
      expect(finalIo).not.toHaveBeenCalled();
    },
  );
});
