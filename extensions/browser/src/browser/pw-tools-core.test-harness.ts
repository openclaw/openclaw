/**
 * Vitest harness for pw-tools-core modules that need mocked Playwright session
 * state and navigation guards.
 */
import { beforeEach, vi } from "vitest";

let currentPage: Record<string, unknown> | null = null;
let currentRefLocator: Record<string, unknown> | null = null;
let currentDownloadCapture:
  | {
      armed: boolean;
      promise: Promise<{
        triggered: true;
        url: string;
        suggestedFilename: string;
        path: string;
      }>;
      cancel: ReturnType<typeof vi.fn>;
    }
  | undefined;
let pageState: {
  console: unknown[];
  armIdUpload: number;
  armIdDownload: number;
  downloadWaiterDepth: number;
} = {
  console: [],
  armIdUpload: 0,
  armIdDownload: 0,
  downloadWaiterDepth: 0,
};

const sessionMocks = vi.hoisted(() => ({
  assertPageNavigationCompletedSafely: vi.fn(async () => {}),
  closeBlockedNavigationTarget: vi.fn(async () => {}),
  getPageForTargetId: vi.fn(async () => {
    if (!currentPage) {
      throw new Error("missing page");
    }
    return currentPage;
  }),
  ensurePageState: vi.fn(() => pageState),
  forceDisconnectPlaywrightForTarget: vi.fn(async () => {}),
  createManagedDownloadCaptureForPage: vi.fn(
    () =>
      currentDownloadCapture ?? {
        armed: true,
        promise: new Promise(() => {}),
        cancel: vi.fn(),
      },
  ),
  gotoPageWithNavigationGuard: vi.fn(
    async (opts: {
      url: string;
      timeoutMs: number;
      page: { goto: (url: string, init: { timeout: number }) => Promise<unknown> };
    }) => (await opts.page.goto(opts.url, { timeout: opts.timeoutMs })) ?? null,
  ),
  // Match by name so mocked errors are recognized without importing real classes.
  isDownloadStartingNavigationError: vi.fn((err: unknown, expectedUrl?: string) => {
    if (!(err instanceof Error)) {
      return false;
    }
    const message = err.message.toLowerCase();
    if (message.includes("download is starting")) {
      return true;
    }
    const normalizedUrl = expectedUrl?.trim().toLowerCase();
    return Boolean(
      normalizedUrl && message.includes("net::err_aborted") && message.includes(normalizedUrl),
    );
  }),
  isPolicyDenyNavigationError: vi.fn((err: unknown) => {
    if (!(err instanceof Error)) {
      return false;
    }
    return err.name === "SsrFBlockedError" || err.name === "InvalidBrowserNavigationUrlError";
  }),
  restoreRoleRefsForTarget: vi.fn(() => {}),
  respondToObservedDialogOnPage: vi.fn(async () => {
    throw new Error("No dialog is pending.");
  }),
  armObservedDialogResponseOnPage: vi.fn(() => {}),
  createObservedDialogAbortSignalForPage: vi.fn((opts?: { parentSignal?: AbortSignal }) => ({
    signal: opts?.parentSignal ?? new AbortController().signal,
    cleanup: vi.fn(() => {}),
  })),
  isBrowserObservedDialogBlockedError: vi.fn(() => false),
  storeRoleRefsForTarget: vi.fn(() => {}),
  refLocator: vi.fn(() => {
    if (!currentRefLocator) {
      throw new Error("missing locator");
    }
    return currentRefLocator;
  }),
  rememberRoleRefsForTarget: vi.fn(() => {}),
}));

const navigationGuardMocks = vi.hoisted(() => ({
  assertBrowserNavigationResultAllowed: vi.fn(async () => {}),
  withBrowserNavigationPolicy: vi.fn((ssrfPolicy?: unknown) => ({ ssrfPolicy })),
}));

vi.mock("./pw-session.js", () => sessionMocks);
vi.mock("./navigation-guard.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ...navigationGuardMocks,
  };
});

/** Returns mocked pw-session exports shared by pw-tools-core tests. */
export function getPwToolsCoreSessionMocks() {
  return sessionMocks;
}

/** Returns mocked navigation guard exports shared by pw-tools-core tests. */
export function getPwToolsCoreNavigationGuardMocks() {
  return navigationGuardMocks;
}

/** Sets the current mocked page returned by getPageForTargetId. */
export function setPwToolsCoreCurrentPage(page: Record<string, unknown> | null) {
  currentPage = page;
}

/** Sets the current mocked locator returned by refLocator. */
export function setPwToolsCoreCurrentRefLocator(locator: Record<string, unknown> | null) {
  currentRefLocator = locator;
}

export function setPwToolsCoreDownloadCapture(
  capture:
    | {
        armed: boolean;
        promise: Promise<{
          triggered: true;
          url: string;
          suggestedFilename: string;
          path: string;
        }>;
        cancel: ReturnType<typeof vi.fn>;
      }
    | undefined,
) {
  currentDownloadCapture = capture;
}

/** Installs per-test cleanup for pw-tools-core mocked session state. */
export function installPwToolsCoreTestHooks() {
  beforeEach(() => {
    currentPage = null;
    currentRefLocator = null;
    currentDownloadCapture = undefined;
    pageState = {
      console: [],
      armIdUpload: 0,
      armIdDownload: 0,
      downloadWaiterDepth: 0,
    };

    for (const fn of Object.values(sessionMocks)) {
      fn.mockClear();
    }
    for (const fn of Object.values(navigationGuardMocks)) {
      fn.mockClear();
    }
  });
}
