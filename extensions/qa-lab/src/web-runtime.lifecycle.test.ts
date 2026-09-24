import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launch = vi.hoisted(() => vi.fn());

vi.mock("playwright-core", () => ({
  chromium: { launch },
}));

let webRuntime: typeof import("./web-runtime.js");
let expectedTeardownErrors: unknown[] = [];

const pageParams = { url: "http://127.0.0.1:3000/chat", channel: "chrome" as const };

function makeBrowser() {
  const closeOrder: string[] = [];
  const page = {
    on: vi.fn(),
    goto: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    title: vi.fn(async () => "QA"),
    url: vi.fn(() => pageParams.url),
    locator: vi.fn(() => ({
      waitFor: vi.fn(async () => undefined),
      textContent: vi.fn(async () => "page body"),
    })),
  };
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {
      closeOrder.push("context");
    }),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => {
      closeOrder.push("browser");
    }),
  };
  return { page, context, browser, closeOrder };
}

function expectCleanupErrors(error: unknown, expected: readonly unknown[]) {
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) {
    throw error;
  }
  expect(error.errors).toHaveLength(expected.length);
  for (const [index, expectedError] of expected.entries()) {
    expect(error.errors[index]).toBe(expectedError);
  }
  return error;
}

beforeEach(async () => {
  // Failed closes remain owned. Isolate each test's registry without a production reset API.
  vi.resetModules();
  launch.mockReset();
  expectedTeardownErrors = [];
  webRuntime = await import("./web-runtime.js");
});

afterEach(async () => {
  if (expectedTeardownErrors.length === 0) {
    await webRuntime.closeQaWebSessions();
  } else {
    expectCleanupErrors(
      await webRuntime.closeQaWebSessions().catch((error: unknown) => error),
      expectedTeardownErrors,
    );
  }
});

describe("QA web acquisition ownership", () => {
  it.each([
    { phase: "launch", order: [] },
    { phase: "context", order: ["browser"] },
    { phase: "page", order: ["context", "browser"] },
    { phase: "navigation", order: ["context", "browser"] },
  ] as const)("rolls back $phase failure without replacing the error", async ({ phase, order }) => {
    const fixture = makeBrowser();
    launch.mockResolvedValue(fixture.browser);
    const error = new Error(`${phase} failed`);
    const operations = {
      launch,
      context: fixture.browser.newContext,
      page: fixture.context.newPage,
      navigation: fixture.page.goto,
    };
    operations[phase].mockRejectedValueOnce(error);

    await expect(webRuntime.qaWebOpenPage(pageParams)).rejects.toBe(error);

    expect(fixture.closeOrder).toEqual(order);
    await webRuntime.closeQaWebSessions();
    expect(fixture.closeOrder).toEqual(order);
  });

  it("keeps the existing empty title fallback when the page is still owned", async () => {
    const fixture = makeBrowser();
    launch.mockResolvedValue(fixture.browser);
    fixture.page.title.mockRejectedValueOnce(new Error("title unavailable"));

    const opened = await webRuntime.qaWebOpenPage(pageParams);

    expect(opened).toMatchObject({ title: "", url: pageParams.url });
    expect(fixture.context.close).not.toHaveBeenCalled();
    await webRuntime.closeQaWebSessions([opened.pageId]);
    expect(fixture.closeOrder).toEqual(["context", "browser"]);
  });

  it("does not reserve or launch for an already aborted scenario", async () => {
    const controller = new AbortController();
    const error = new Error("scenario already timed out");
    controller.abort(error);
    const owner = new Set<string>();
    const open = webRuntime.createQaWebPageOpener(owner, controller.signal);

    await expect(open(pageParams)).rejects.toBe(error);

    expect(owner.size).toBe(0);
    expect(launch).not.toHaveBeenCalled();
    const fixture = makeBrowser();
    launch.mockResolvedValueOnce(fixture.browser);
    await webRuntime.createQaWebPageOpener(owner)(pageParams);
    expect(owner.size).toBe(1);
  });

  it.each(["launch", "context", "page", "navigation", "title"] as const)(
    "cancels pending %s, joins its late success and removes the listener",
    async (phase) => {
      const fixture = makeBrowser();
      const controller = new AbortController();
      const error = new Error("scenario timed out");
      const started = createDeferred<void>();
      const released = createDeferred<void>();
      const browserClosed = createDeferred<void>();
      const delay =
        <T>(value: T) =>
        async () => {
          started.resolve();
          await released.promise;
          return value;
        };
      launch.mockResolvedValue(fixture.browser);
      if (phase === "launch") {
        launch.mockImplementationOnce(delay(fixture.browser));
      } else if (phase === "context") {
        fixture.browser.newContext.mockImplementationOnce(delay(fixture.context));
      } else if (phase === "page") {
        fixture.context.newPage.mockImplementationOnce(delay(fixture.page));
      } else if (phase === "navigation") {
        fixture.page.goto.mockImplementationOnce(delay(undefined));
      } else {
        fixture.page.title.mockImplementationOnce(delay("late title"));
      }
      fixture.browser.close.mockImplementationOnce(async () => {
        fixture.closeOrder.push("browser");
        browserClosed.resolve();
      });
      const added = vi.spyOn(controller.signal, "addEventListener");
      const removed = vi.spyOn(controller.signal, "removeEventListener");
      const owner = new Set<string>();
      const fulfilled = vi.fn();
      const opening = webRuntime
        .createQaWebPageOpener(
          owner,
          controller.signal,
        )(pageParams)
        .then(fulfilled)
        .catch((failure: unknown) => failure);
      try {
        await started.promise;
        controller.abort(error);
        if (phase !== "launch") {
          await browserClosed.promise;
        }
        expect(owner.size).toBe(1);
        expect(fulfilled).not.toHaveBeenCalled();
        released.resolve();

        await expect(opening).resolves.toBe(error);
        expect(fulfilled).not.toHaveBeenCalled();
        expect(owner.size).toBe(0);
        expect(fixture.browser.close).toHaveBeenCalledOnce();
        if (phase === "launch") {
          expect(fixture.browser.newContext).not.toHaveBeenCalled();
          expect(fixture.closeOrder).toEqual(["browser"]);
        } else {
          expect(fixture.context.close).toHaveBeenCalledOnce();
          expect(fixture.closeOrder).toEqual(
            phase === "context" ? ["browser", "context"] : ["context", "browser"],
          );
        }
        expect(added).toHaveBeenCalledOnce();
        expect(removed).toHaveBeenCalledOnce();
        expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);
        await expect(webRuntime.closeQaWebSessions(owner)).resolves.toBeUndefined();
      } finally {
        released.resolve();
        await opening;
        added.mockRestore();
        removed.mockRestore();
      }
    },
  );

  it.each(["ready", "failure"] as const)(
    "detaches the signal after %s settlement without closing ready pages on later abort",
    async (settlement) => {
      const fixture = makeBrowser();
      const controller = new AbortController();
      const added = vi.spyOn(controller.signal, "addEventListener");
      const removed = vi.spyOn(controller.signal, "removeEventListener");
      const owner = new Set<string>();
      const open = webRuntime.createQaWebPageOpener(owner, controller.signal);
      const error = new Error("navigation failed");
      launch.mockResolvedValueOnce(fixture.browser);
      if (settlement === "failure") {
        fixture.page.goto.mockRejectedValueOnce(error);
      }
      try {
        if (settlement === "ready") {
          const opened = await open(pageParams);
          controller.abort(new Error("later scenario timeout"));
          await expect(webRuntime.qaWebSnapshot({ pageId: opened.pageId })).resolves.toMatchObject({
            text: "page body",
          });
          expect(owner.has(opened.pageId)).toBe(true);
          expect(fixture.closeOrder).toEqual([]);
        } else {
          await expect(open(pageParams)).rejects.toBe(error);
          controller.abort(new Error("later scenario timeout"));
          expect(fixture.closeOrder).toEqual(["context", "browser"]);
          expect(owner.size).toBe(0);
        }
        expect(fixture.page.goto).toHaveBeenCalledWith(pageParams.url, {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
          signal: controller.signal,
        });
        expect(removed).toHaveBeenCalledOnce();
        expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);
      } finally {
        added.mockRestore();
        removed.mockRestore();
      }
    },
  );

  it("retains genuine close failures after cancellation without retrying the handles", async () => {
    const fixture = makeBrowser();
    const controller = new AbortController();
    const reason = new Error("scenario timed out");
    const acquisitionError = new Error("navigation failed during cancellation");
    const contextError = new Error("context cleanup failed");
    const browserError = new Error("browser cleanup failed");
    expectedTeardownErrors = [contextError, browserError];
    const owner = new Set<string>();
    launch.mockResolvedValueOnce(fixture.browser);
    fixture.page.goto.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw acquisitionError;
    });
    fixture.context.close.mockRejectedValueOnce(contextError);
    fixture.browser.close.mockRejectedValueOnce(browserError);

    const error = expectCleanupErrors(
      await webRuntime
        .createQaWebPageOpener(
          owner,
          controller.signal,
        )(pageParams)
        .catch((failure: unknown) => failure),
      [reason, contextError, browserError],
    );
    expect(error.cause).toBe(acquisitionError);
    expect(owner.size).toBe(1);
    expectCleanupErrors(
      await webRuntime.closeQaWebSessions(owner).catch((failure: unknown) => failure),
      [contextError, browserError],
    );
    expectCleanupErrors(
      await webRuntime.closeQaWebSessions().catch((failure: unknown) => failure),
      [contextError, browserError],
    );
    expect(fixture.context.close).toHaveBeenCalledOnce();
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  });

  it("reserves the page before launch and can close before acquisition starts", async () => {
    const owner = new Set<string>();
    const openPage = webRuntime.createQaWebPageOpener(owner);
    const opening = openPage(pageParams).catch((error: unknown) => error);

    expect(owner.size).toBe(1);
    const closing = webRuntime.closeQaWebSessions(owner);

    await expect(opening).resolves.toEqual(new Error("web session closed while opening"));
    await closing;
    expect(launch).not.toHaveBeenCalled();
    expect(owner.size).toBe(0);
  });

  it("joins delayed launch and closes its late browser without creating a context", async () => {
    const fixture = makeBrowser();
    const started = createDeferred<void>();
    const acquired = createDeferred<typeof fixture.browser>();
    launch.mockImplementationOnce(() => {
      started.resolve();
      return acquired.promise;
    });
    const owner = new Set<string>();
    const opening = webRuntime
      .createQaWebPageOpener(owner)(pageParams)
      .catch((error: unknown) => error);
    await started.promise;
    const settled = vi.fn();
    const closing = webRuntime.closeQaWebSessions(owner).then(settled);
    try {
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      expect(owner.size).toBe(1);
    } finally {
      acquired.resolve(fixture.browser);
    }

    await closing;
    await expect(opening).resolves.toEqual(new Error("web session closed while opening"));
    expect(fixture.closeOrder).toEqual(["browser"]);
    expect(fixture.browser.newContext).not.toHaveBeenCalled();
    expect(owner.size).toBe(0);
  });

  it("closes a known browser before joining newContext and closes the late context", async () => {
    const fixture = makeBrowser();
    const started = createDeferred<void>();
    const acquired = createDeferred<typeof fixture.context>();
    const browserClosed = createDeferred<void>();
    launch.mockResolvedValueOnce(fixture.browser);
    fixture.browser.newContext.mockImplementationOnce(() => {
      started.resolve();
      return acquired.promise;
    });
    fixture.browser.close.mockImplementationOnce(async () => {
      fixture.closeOrder.push("browser");
      browserClosed.resolve();
    });
    const owner = new Set<string>();
    const opening = webRuntime
      .createQaWebPageOpener(owner)(pageParams)
      .catch((error: unknown) => error);
    await started.promise;
    const settled = vi.fn();
    const closing = webRuntime.closeQaWebSessions(owner).then(settled);
    try {
      await browserClosed.promise;
      expect(settled).not.toHaveBeenCalled();
      expect(fixture.context.close).not.toHaveBeenCalled();
    } finally {
      acquired.resolve(fixture.context);
    }

    await closing;
    await expect(opening).resolves.toEqual(new Error("web session closed while opening"));
    expect(fixture.closeOrder).toEqual(["browser", "context"]);
    expect(fixture.context.newPage).not.toHaveBeenCalled();
    expect(owner.size).toBe(0);
  });

  it("closes context and browser before joining a late newPage result", async () => {
    const fixture = makeBrowser();
    const started = createDeferred<void>();
    const acquired = createDeferred<typeof fixture.page>();
    const browserClosed = createDeferred<void>();
    launch.mockResolvedValueOnce(fixture.browser);
    fixture.context.newPage.mockImplementationOnce(() => {
      started.resolve();
      return acquired.promise;
    });
    fixture.browser.close.mockImplementationOnce(async () => {
      fixture.closeOrder.push("browser");
      browserClosed.resolve();
    });
    const owner = new Set<string>();
    const opening = webRuntime
      .createQaWebPageOpener(owner)(pageParams)
      .catch((error: unknown) => error);
    await started.promise;
    const settled = vi.fn();
    const closing = webRuntime.closeQaWebSessions(owner).then(settled);
    try {
      await browserClosed.promise;
      expect(settled).not.toHaveBeenCalled();
      expect(fixture.closeOrder).toEqual(["context", "browser"]);
    } finally {
      acquired.resolve(fixture.page);
    }

    await closing;
    await expect(opening).resolves.toEqual(new Error("web session closed while opening"));
    expect(fixture.page.goto).not.toHaveBeenCalled();
    expect(fixture.context.close).toHaveBeenCalledOnce();
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  });

  it("does not report the acquisition rejection caused by close as cleanup failure", async () => {
    const fixture = makeBrowser();
    const started = createDeferred<void>();
    const navigation = createDeferred<void>();
    const closedError = new Error("navigation target closed");
    launch.mockResolvedValueOnce(fixture.browser);
    fixture.page.goto.mockImplementationOnce(() => {
      started.resolve();
      return navigation.promise;
    });
    fixture.context.close.mockImplementationOnce(async () => {
      fixture.closeOrder.push("context");
      navigation.reject(closedError);
    });
    const owner = new Set<string>();
    const opening = webRuntime
      .createQaWebPageOpener(owner)(pageParams)
      .catch((error: unknown) => error);
    await started.promise;

    await expect(webRuntime.closeQaWebSessions(owner)).resolves.toBeUndefined();
    await expect(opening).resolves.toBe(closedError);
    expect(fixture.closeOrder).toEqual(["context", "browser"]);
    expect(fixture.page.title).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "does not publish a page when title lookup finishes with %s after close",
    async (settlement) => {
      const fixture = makeBrowser();
      const started = createDeferred<void>();
      const title = createDeferred<string>();
      const browserClosed = createDeferred<void>();
      launch.mockResolvedValueOnce(fixture.browser);
      fixture.page.title.mockImplementationOnce(() => {
        started.resolve();
        return title.promise;
      });
      fixture.browser.close.mockImplementationOnce(async () => {
        fixture.closeOrder.push("browser");
        browserClosed.resolve();
      });
      const owner = new Set<string>();
      const opening = webRuntime
        .createQaWebPageOpener(owner)(pageParams)
        .catch((error: unknown) => error);
      await started.promise;
      const closing = webRuntime.closeQaWebSessions(owner);
      try {
        await browserClosed.promise;
        expect(fixture.closeOrder).toEqual(["context", "browser"]);
      } finally {
        const finish = {
          resolve: () => title.resolve("late title"),
          reject: () => title.reject(new Error("title target closed")),
        };
        finish[settlement]();
      }

      await closing;
      await expect(opening).resolves.toEqual(new Error("web session closed while opening"));
      expect(owner.size).toBe(0);
    },
  );

  it("keeps failed rollback visible after a passing retry and preserves the original cause", async () => {
    const fixture = makeBrowser();
    const retry = makeBrowser();
    const openError = new Error("navigation failed");
    const contextError = new Error("context cleanup failed");
    const browserError = new Error("browser cleanup failed");
    expectedTeardownErrors = [contextError, browserError];
    launch.mockResolvedValueOnce(fixture.browser).mockResolvedValueOnce(retry.browser);
    fixture.page.goto.mockRejectedValueOnce(openError);
    fixture.context.close.mockRejectedValueOnce(contextError);
    fixture.browser.close.mockRejectedValueOnce(browserError);
    const owner = new Set<string>();
    const openPage = webRuntime.createQaWebPageOpener(owner);
    const failed = expectCleanupErrors(
      await openPage(pageParams).catch((error: unknown) => error),
      [openError, contextError, browserError],
    );
    expect(failed.message).toBe("web page open and cleanup failed");
    expect(failed.cause).toBe(openError);
    expect(fixture.context.close).toHaveBeenCalledOnce();
    expect(fixture.browser.close).toHaveBeenCalledOnce();
    expect(owner.size).toBe(1);

    const openedRetry = await openPage(pageParams);
    await expect(webRuntime.qaWebSnapshot({ pageId: openedRetry.pageId })).resolves.toMatchObject({
      text: "page body",
    });
    expect(owner.size).toBe(2);
    expectCleanupErrors(
      await webRuntime.closeQaWebSessions(owner).catch((error: unknown) => error),
      [contextError, browserError],
    );
    expect(owner.size).toBe(1);
    expect(retry.closeOrder).toEqual(["context", "browser"]);
    expect(fixture.context.close).toHaveBeenCalledOnce();
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  });
});

describe("QA web teardown ownership", () => {
  it("joins concurrent selected and global close calls until context and browser settle", async () => {
    const fixture = makeBrowser();
    const started = createDeferred<void>();
    const contextClosed = createDeferred<void>();
    launch.mockResolvedValueOnce(fixture.browser);
    fixture.context.close.mockImplementationOnce(() => {
      started.resolve();
      return contextClosed.promise;
    });
    const opened = await webRuntime.qaWebOpenPage(pageParams);
    const settled = vi.fn();
    const first = webRuntime.closeQaWebSessions([opened.pageId]).then(settled);
    await started.promise;
    const second = webRuntime.closeQaWebSessions([opened.pageId]).then(settled);
    const all = webRuntime.closeQaWebSessions().then(settled);
    try {
      await expect(webRuntime.qaWebSnapshot({ pageId: opened.pageId })).rejects.toThrow(
        `unknown web session: ${opened.pageId}`,
      );
      expect(settled).not.toHaveBeenCalled();
      expect(fixture.context.close).toHaveBeenCalledOnce();
      expect(fixture.browser.close).not.toHaveBeenCalled();
    } finally {
      contextClosed.resolve();
    }

    await Promise.all([first, second, all]);
    expect(settled).toHaveBeenCalledTimes(3);
    expect(fixture.context.close).toHaveBeenCalledOnce();
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  });

  it("returns the same cleanup failures to concurrent and later selected or global callers", async () => {
    const fixture = makeBrowser();
    const started = createDeferred<void>();
    const contextClosed = createDeferred<void>();
    const contextError = new Error("context close failed");
    const browserError = new Error("browser close failed");
    expectedTeardownErrors = [contextError, browserError];
    launch.mockResolvedValueOnce(fixture.browser);
    fixture.context.close.mockImplementationOnce(() => {
      started.resolve();
      return contextClosed.promise;
    });
    fixture.browser.close.mockRejectedValueOnce(browserError);
    const opened = await webRuntime.qaWebOpenPage(pageParams);
    const first = webRuntime.closeQaWebSessions([opened.pageId]).catch((error: unknown) => error);
    await started.promise;
    const second = webRuntime.closeQaWebSessions([opened.pageId]).catch((error: unknown) => error);
    contextClosed.reject(contextError);

    const errors = await Promise.all([first, second]);
    for (const error of errors) {
      expectCleanupErrors(error, [contextError, browserError]);
    }
    expectCleanupErrors(
      await webRuntime.closeQaWebSessions([opened.pageId]).catch((error: unknown) => error),
      [contextError, browserError],
    );
    expectCleanupErrors(await webRuntime.closeQaWebSessions().catch((error: unknown) => error), [
      contextError,
      browserError,
    ]);
    expect(fixture.context.close).toHaveBeenCalledOnce();
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  });

  it("seals an empty suite synchronously and refuses both existing and later openers", async () => {
    const owner = new Set<string>();
    const openPage = webRuntime.createQaWebPageOpener(owner);
    const closing = webRuntime.closeQaWebSessions(owner);

    await expect(openPage(pageParams)).rejects.toThrow("web session owner is closed");
    await expect(webRuntime.createQaWebPageOpener(owner)(pageParams)).rejects.toThrow(
      "web session owner is closed",
    );
    await closing;
    expect(launch).not.toHaveBeenCalled();
    expect(owner.size).toBe(0);
  });

  it("keeps retries and later pages usable until their exact suite tears down", async () => {
    const failed = makeBrowser();
    const retry = makeBrowser();
    const later = makeBrowser();
    const failure = new Error("first page failed");
    failed.page.goto.mockRejectedValueOnce(failure);
    launch
      .mockResolvedValueOnce(failed.browser)
      .mockResolvedValueOnce(retry.browser)
      .mockResolvedValueOnce(later.browser);
    const owner = new Set<string>();
    const openPage = webRuntime.createQaWebPageOpener(owner);

    await expect(openPage(pageParams)).rejects.toBe(failure);
    const openedRetry = await openPage(pageParams);
    await webRuntime.closeQaWebSessions([openedRetry.pageId]);
    const openedLater = await webRuntime.createQaWebPageOpener(owner)(pageParams);
    await expect(webRuntime.qaWebSnapshot({ pageId: openedLater.pageId })).resolves.toMatchObject({
      text: "page body",
    });
    await webRuntime.closeQaWebSessions(owner);

    await expect(openPage(pageParams)).rejects.toThrow("web session owner is closed");
    expect(launch).toHaveBeenCalledTimes(3);
    expect(failed.closeOrder).toEqual(["context", "browser"]);
    expect(retry.closeOrder).toEqual(["context", "browser"]);
    expect(later.closeOrder).toEqual(["context", "browser"]);
  });

  it("does not close or seal another suite", async () => {
    const first = makeBrowser();
    const second = makeBrowser();
    const later = makeBrowser();
    launch
      .mockResolvedValueOnce(first.browser)
      .mockResolvedValueOnce(second.browser)
      .mockResolvedValueOnce(later.browser);
    const firstOwner = new Set<string>();
    const secondOwner = new Set<string>();
    await webRuntime.createQaWebPageOpener(firstOwner)(pageParams);
    const secondPage = await webRuntime.createQaWebPageOpener(secondOwner)(pageParams);

    await webRuntime.closeQaWebSessions(firstOwner);
    await expect(webRuntime.qaWebSnapshot({ pageId: secondPage.pageId })).resolves.toMatchObject({
      text: "page body",
    });
    await webRuntime.createQaWebPageOpener(secondOwner)(pageParams);

    expect(first.closeOrder).toEqual(["context", "browser"]);
    expect(second.closeOrder).toEqual([]);
    expect(later.closeOrder).toEqual([]);
    await webRuntime.closeQaWebSessions(secondOwner);
    expect(second.closeOrder).toEqual(["context", "browser"]);
    expect(later.closeOrder).toEqual(["context", "browser"]);
  });

  it("attempts every selected session even when an earlier context close fails", async () => {
    const first = makeBrowser();
    const second = makeBrowser();
    const failure = new Error("first context failed");
    expectedTeardownErrors = [failure];
    first.context.close.mockRejectedValueOnce(failure);
    launch.mockResolvedValueOnce(first.browser).mockResolvedValueOnce(second.browser);
    const firstPage = await webRuntime.qaWebOpenPage(pageParams);
    const secondPage = await webRuntime.qaWebOpenPage(pageParams);

    await expect(
      webRuntime.closeQaWebSessions([firstPage.pageId, secondPage.pageId]),
    ).rejects.toMatchObject({ errors: [failure] });
    expect(first.browser.close).toHaveBeenCalledOnce();
    expect(second.closeOrder).toEqual(["context", "browser"]);
  });
});
