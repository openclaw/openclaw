import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launch = vi.hoisted(() => vi.fn());

vi.mock("playwright-core", () => ({ chromium: { launch } }));

let webRuntime: typeof import("./web-runtime.js");
let openPage: ReturnType<typeof webRuntime.createQaWebPageOpener>;
let owner: Set<string>;
let fixture: ReturnType<typeof makeBrowser>;
let expectedTeardownErrors: unknown[] = [];

const pageParams = { url: "http://127.0.0.1:3000/chat", channel: "chrome" as const };
const failure = (error: unknown) => error;
const open = (signal?: AbortSignal) => webRuntime.createQaWebPageOpener(owner, signal)(pageParams);

function makeBrowser() {
  const closeOrder: string[] = [];
  const browserClosed = createDeferred<void>();
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
      browserClosed.resolve();
    }),
  };
  launch.mockResolvedValueOnce(browser);
  return { page, context, browser, closeOrder, browserClosed: browserClosed.promise };
}

function expectCleanupErrors(error: unknown, expected = expectedTeardownErrors) {
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

function pause<T>() {
  const started = createDeferred<void>();
  const result = createDeferred<T>();
  return {
    ...result,
    started: started.promise,
    run: () => {
      started.resolve();
      return result.promise;
    },
  };
}

async function expectCloseFailure(pageIds?: Iterable<string>) {
  expectCleanupErrors(await webRuntime.closeQaWebSessions(pageIds).catch(failure));
}

function failCleanup(handles: ReturnType<typeof makeBrowser>) {
  const contextError = new Error("context cleanup failed");
  const browserError = new Error("browser cleanup failed");
  expectedTeardownErrors = [contextError, browserError];
  handles.context.close.mockRejectedValueOnce(contextError);
  handles.browser.close.mockRejectedValueOnce(browserError);
  return expectedTeardownErrors;
}

function expectClosedOnce(handles: ReturnType<typeof makeBrowser>) {
  expect(handles.context.close).toHaveBeenCalledOnce();
  expect(handles.browser.close).toHaveBeenCalledOnce();
}

async function expectReadable(pageId: string) {
  await expect(webRuntime.qaWebSnapshot({ pageId })).resolves.toMatchObject({ text: "page body" });
}

beforeEach(async () => {
  // Failed closes remain owned. Isolate each test's registry without a production reset API.
  vi.resetModules();
  launch.mockReset();
  expectedTeardownErrors = [];
  webRuntime = await import("./web-runtime.js");
  owner = new Set();
  openPage = webRuntime.createQaWebPageOpener(owner);
  fixture = makeBrowser();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (expectedTeardownErrors.length === 0) {
    await webRuntime.closeQaWebSessions();
  } else {
    await expectCloseFailure();
  }
});

describe("QA web acquisition ownership", () => {
  it.each(["launch", "context", "page", "navigation", "title"] as const)(
    "cancels pending %s, joins its late success and removes the listener",
    async (phase) => {
      const controller = new AbortController();
      const error = new Error("scenario timed out");
      const released = pause<void>();
      const delay =
        <T>(value: T) =>
        () =>
          released.run().then(() => value);
      if (phase === "launch") {
        launch.mockReset().mockImplementationOnce(delay(fixture.browser));
      } else if (phase === "context") {
        fixture.browser.newContext.mockImplementationOnce(delay(fixture.context));
      } else if (phase === "page") {
        fixture.context.newPage.mockImplementationOnce(delay(fixture.page));
      } else if (phase === "navigation") {
        fixture.page.goto.mockImplementationOnce(delay(undefined));
      } else {
        fixture.page.title.mockImplementationOnce(delay("late title"));
      }
      const added = vi.spyOn(controller.signal, "addEventListener");
      const removed = vi.spyOn(controller.signal, "removeEventListener");
      const fulfilled = vi.fn();
      const closed = vi.fn();
      const opening = open(controller.signal).then(fulfilled).catch(failure);
      try {
        await released.started;
        controller.abort(error);
        if (phase !== "launch") {
          await fixture.browserClosed;
        }
        const closing = webRuntime.closeQaWebSessions([...owner]).then(closed);
        await Promise.resolve();
        expect(owner.size).toBe(1);
        expect(fulfilled).not.toHaveBeenCalled();
        expect(closed).not.toHaveBeenCalled();
        released.resolve();

        await expect(opening).resolves.toBe(error);
        await closing;
        expect(closed).toHaveBeenCalledOnce();
        expect(fulfilled).not.toHaveBeenCalled();
        expect(owner.size).toBe(0);
        expect(fixture.browser.close).toHaveBeenCalledOnce();
        expect(fixture.context.close).toHaveBeenCalledTimes(phase === "launch" ? 0 : 1);
        expect(fixture.closeOrder).toEqual(
          phase === "launch"
            ? ["browser"]
            : phase === "context"
              ? ["browser", "context"]
              : ["context", "browser"],
        );
        const next = {
          launch: fixture.browser.newContext,
          context: fixture.context.newPage,
          page: fixture.page.goto,
          navigation: fixture.page.title,
          title: undefined,
        }[phase];
        if (next) {
          expect(next).not.toHaveBeenCalled();
        }
        expect(added).toHaveBeenCalledOnce();
        expect(removed).toHaveBeenCalledOnce();
        expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);
        await expect(webRuntime.closeQaWebSessions(owner)).resolves.toBeUndefined();
      } finally {
        released.resolve();
        await opening;
      }
    },
  );

  it("detaches the signal without closing ready pages on later abort", async () => {
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const opened = await open(controller.signal);
    controller.abort(new Error("later scenario timeout"));
    await expectReadable(opened.pageId);
    expect(owner.has(opened.pageId)).toBe(true);
    expect(fixture.closeOrder).toEqual([]);
    expect(fixture.page.goto).toHaveBeenCalledWith(pageParams.url, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
      signal: controller.signal,
    });
    expect(removed).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);
  });

  it("retains genuine close failures after cancellation without retrying the handles", async () => {
    const controller = new AbortController();
    const reason = new Error("scenario timed out");
    const acquisitionError = new Error("navigation failed during cancellation");
    const cleanupErrors = failCleanup(fixture);
    fixture.page.goto.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw acquisitionError;
    });
    const error = expectCleanupErrors(await open(controller.signal).catch(failure), [
      reason,
      ...cleanupErrors,
    ]);
    expect(error.cause).toBe(acquisitionError);
    expect(owner.size).toBe(1);
    await expectCloseFailure(owner);
    await expectCloseFailure();
    expectClosedOnce(fixture);
  });

  it("reserves the page before launch and can close before acquisition starts", async () => {
    const opening = open().catch(failure);

    expect(owner.size).toBe(1);
    const closing = webRuntime.closeQaWebSessions(owner);

    await expect(opening).resolves.toEqual(new Error("web session closed while opening"));
    await closing;
    expect(launch).not.toHaveBeenCalled();
    expect(owner.size).toBe(0);
  });

  it("does not publish a page when title lookup rejects after close", async () => {
    const title = pause<string>();
    fixture.page.title.mockImplementationOnce(title.run);
    const opening = open().catch(failure);
    await title.started;
    const closing = webRuntime.closeQaWebSessions(owner);
    try {
      await fixture.browserClosed;
      expect(fixture.closeOrder).toEqual(["context", "browser"]);
    } finally {
      title.reject(new Error("title target closed"));
    }

    await closing;
    await expect(opening).resolves.toEqual(new Error("web session closed while opening"));
    expect(owner.size).toBe(0);
  });

  it("keeps failed rollback visible after a passing retry and preserves the original cause", async () => {
    const retry = makeBrowser();
    const openError = new Error("navigation failed");
    const cleanupErrors = failCleanup(fixture);
    fixture.page.goto.mockRejectedValueOnce(openError);
    const failed = expectCleanupErrors(await openPage(pageParams).catch(failure), [
      openError,
      ...cleanupErrors,
    ]);
    expect(failed.message).toBe("web page open and cleanup failed");
    expect(failed.cause).toBe(openError);
    expectClosedOnce(fixture);
    expect(owner.size).toBe(1);

    const openedRetry = await openPage(pageParams);
    await expectReadable(openedRetry.pageId);
    expect(owner.size).toBe(2);
    await expectCloseFailure(owner);
    expect(owner.size).toBe(1);
    expect(retry.closeOrder).toEqual(["context", "browser"]);
    expectClosedOnce(fixture);
  });
});

describe("QA web teardown ownership", () => {
  it("joins concurrent selected and global close calls until context and browser settle", async () => {
    const contextClosed = pause<void>();
    fixture.context.close.mockImplementationOnce(contextClosed.run);
    const opened = await openPage(pageParams);
    const settled = vi.fn();
    const first = webRuntime.closeQaWebSessions([opened.pageId]).then(settled);
    await contextClosed.started;
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
    expectClosedOnce(fixture);
  });

  it("returns the same cleanup failures to concurrent and later selected or global callers", async () => {
    const contextClosed = pause<void>();
    const contextError = new Error("context close failed");
    const browserError = new Error("browser close failed");
    expectedTeardownErrors = [contextError, browserError];
    fixture.context.close.mockImplementationOnce(contextClosed.run);
    fixture.browser.close.mockRejectedValueOnce(browserError);
    const opened = await openPage(pageParams);
    const first = webRuntime.closeQaWebSessions([opened.pageId]).catch(failure);
    await contextClosed.started;
    const second = webRuntime.closeQaWebSessions([opened.pageId]).catch(failure);
    contextClosed.reject(contextError);

    const errors = await Promise.all([first, second]);
    for (const error of errors) {
      expectCleanupErrors(error);
    }
    await expectCloseFailure([opened.pageId]);
    await expectCloseFailure();
    expectClosedOnce(fixture);
  });

  it("seals an empty suite synchronously and refuses both existing and later openers", async () => {
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
    const failed = fixture;
    const retry = makeBrowser();
    const later = makeBrowser();
    const openError = new Error("first page failed");
    failed.page.goto.mockRejectedValueOnce(openError);

    await expect(openPage(pageParams)).rejects.toBe(openError);
    const openedRetry = await openPage(pageParams);
    await webRuntime.closeQaWebSessions([openedRetry.pageId]);
    const openedLater = await webRuntime.createQaWebPageOpener(owner)(pageParams);
    await expectReadable(openedLater.pageId);
    await webRuntime.closeQaWebSessions(owner);

    await expect(openPage(pageParams)).rejects.toThrow("web session owner is closed");
    expect(launch).toHaveBeenCalledTimes(3);
    expect(failed.closeOrder).toEqual(["context", "browser"]);
    expect(retry.closeOrder).toEqual(["context", "browser"]);
    expect(later.closeOrder).toEqual(["context", "browser"]);
  });
});
