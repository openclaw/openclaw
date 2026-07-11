// Browser tests cover pw tools core.interactions.set input files plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

let page: Record<string, unknown> | null = null;
let locator: Record<string, unknown> | null = null;

const getPageForTargetId = vi.fn(async () => {
  if (!page) {
    throw new Error("test: page not set");
  }
  return page;
});
const ensurePageState = vi.fn(() => ({}));
const restoreRoleRefsForTarget = vi.fn(() => {});
const isBrowserObservedDialogBlockedError = vi.fn(() => false);
const markObservedDialogsHandledRemotelyForPage = vi.fn(() => ({}));
const refLocator = vi.fn(() => {
  if (!locator) {
    throw new Error("test: locator not set");
  }
  return locator;
});
const forceDisconnectPlaywrightForTarget = vi.fn(async () => {});
const finalizePendingBrowserInteractionAction = vi.fn((error: unknown) => ({
  error: error instanceof Error ? error : new Error("pending interaction failed"),
  deferred: false,
}));
const assertPageNavigationCompletedSafely = vi.fn(async () => {});
const isPolicyDenyNavigationError = vi.fn(() => false);
const quarantineBlockedNavigationTargetForError = vi.fn(async () => {});
const wasBrowserNavigationRequestBlockedBeforeDispatch = vi.fn(() => false);
const trackPendingBrowserInteractionAction = vi.fn(
  (err: unknown, actionPromise: Promise<unknown>, onActionResolved?: () => void) => {
    void actionPromise.then(onActionResolved, () => {});
    return err instanceof Error ? err : new Error("aborted");
  },
);
const replacePendingBrowserInteractionActionError = vi.fn(
  (_current: unknown, replacement: unknown) =>
    replacement instanceof Error ? replacement : new Error("replacement error"),
);
const withPageNavigationRequestGuard = vi.fn(
  async <T>({ action }: { action: () => Promise<T> }): Promise<T> => await action(),
);

const resolveStrictExistingUploadPaths =
  vi.fn<typeof import("./paths.js").resolveStrictExistingUploadPaths>();

vi.mock("./pw-session.js", () => {
  return {
    assertPageNavigationCompletedSafely,
    ensurePageState,
    forceDisconnectPlaywrightForTarget,
    finalizePendingBrowserInteractionAction,
    getPageForTargetId,
    isBrowserObservedDialogBlockedError,
    isPolicyDenyNavigationError,
    markObservedDialogsHandledRemotelyForPage,
    quarantineBlockedNavigationTargetForError,
    refLocator,
    replacePendingBrowserInteractionActionError,
    restoreRoleRefsForTarget,
    trackPendingBrowserInteractionAction,
    wasBrowserNavigationRequestBlockedBeforeDispatch,
    withPageNavigationRequestGuard,
  };
});

vi.mock("./paths.js", () => {
  return {
    resolveStrictExistingUploadPaths,
  };
});

const { setInputFilesViaPlaywright } = await import("./pw-tools-core.interactions.js");

function seedSingleLocatorPage() {
  let currentUrl = "https://example.com/form";
  const setInputFiles = vi.fn(async () => {});
  const elementHandle = vi.fn(async () => {
    throw new Error("manual upload event dispatch is forbidden");
  });
  locator = {
    setInputFiles,
    elementHandle,
  };
  page = {
    locator: vi.fn(() => ({ first: () => locator })),
    url: vi.fn(() => currentUrl),
  };
  return {
    setInputFiles,
    elementHandle,
    setUrl: (url: string) => {
      currentUrl = url;
    },
  };
}

describe("setInputFilesViaPlaywright", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    page = null;
    locator = null;
    resolveStrictExistingUploadPaths.mockResolvedValue({
      ok: true,
      paths: ["/private/tmp/openclaw/uploads/ok.txt"],
    });
  });

  it("sets resolved files once and leaves browser events to Playwright", async () => {
    const { setInputFiles, elementHandle } = seedSingleLocatorPage();

    await setInputFilesViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      inputRef: "e7",
      paths: ["/tmp/openclaw/uploads/ok.txt"],
    });

    expect(resolveStrictExistingUploadPaths).toHaveBeenCalledWith({
      requestedPaths: ["/tmp/openclaw/uploads/ok.txt"],
    });
    expect(refLocator).toHaveBeenCalledWith(page, "e7");
    expect(setInputFiles).toHaveBeenCalledWith(["/private/tmp/openclaw/uploads/ok.txt"]);
    expect(setInputFiles).toHaveBeenCalledTimes(1);
    expect(elementHandle).not.toHaveBeenCalled();
  });

  it("throws and skips setInputFiles when use-time validation fails", async () => {
    resolveStrictExistingUploadPaths.mockResolvedValueOnce({
      ok: false,
      error: "Invalid path: must stay within inbound media directory",
    });

    const { setInputFiles } = seedSingleLocatorPage();

    await expect(
      setInputFilesViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        element: "input[type=file]",
        paths: ["/tmp/openclaw/uploads/missing.txt"],
      }),
    ).rejects.toThrow("Invalid path: must stay within inbound media directory");

    expect(setInputFiles).not.toHaveBeenCalled();
  });

  it("rechecks the current page inside the upload request guard", async () => {
    const { setInputFiles } = seedSingleLocatorPage();

    await expect(
      setInputFilesViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "T1",
        element: "input[type=file]",
        paths: ["/tmp/openclaw/uploads/ok.txt"],
        ssrfPolicy: { allowPrivateNetwork: false },
        browserProxyMode: "explicit-browser-proxy",
      }),
    ).rejects.toThrow("strict browser SSRF policy cannot be enforced");

    expect(withPageNavigationRequestGuard).toHaveBeenCalledOnce();
    expect(setInputFiles).not.toHaveBeenCalled();
  });

  it("guards the upload dispatch and checks its resulting navigation", async () => {
    const { setInputFiles, setUrl } = seedSingleLocatorPage();
    const requestSignal = new AbortController().signal;
    setInputFiles.mockImplementationOnce(async () => {
      setUrl("https://example.com/uploaded");
    });

    await setInputFilesViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      element: "input[type=file]",
      paths: ["/tmp/openclaw/uploads/ok.txt"],
      ssrfPolicy: { allowPrivateNetwork: true },
      browserProxyMode: "explicit-browser-proxy",
      signal: requestSignal,
    });

    expect(withPageNavigationRequestGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        page,
        ssrfPolicy: { allowPrivateNetwork: true },
        browserProxyMode: "explicit-browser-proxy",
        action: expect.any(Function),
      }),
    );
    expect(withPageNavigationRequestGuard.mock.invocationCallOrder[0]).toBeLessThan(
      setInputFiles.mock.invocationCallOrder[0]!,
    );
    expect(assertPageNavigationCompletedSafely).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      page,
      response: null,
      ssrfPolicy: { allowPrivateNetwork: true },
      browserProxyMode: "explicit-browser-proxy",
      targetId: "T1",
    });
  });
});
