import { EventEmitter, once } from "node:events";
import { vi } from "vitest";

export function fileChooserPage() {
  const events = new EventEmitter();
  const fileChooser = {
    setFiles: vi.fn(
      async (_paths: string[], _options: { timeout: number; signal: AbortSignal }) => {},
    ),
  };
  const waitForEvent = vi.fn(
    async (_event: string, { signal }: { signal: AbortSignal }): Promise<typeof fileChooser> => {
      const [chooser] = await once(events, "filechooser", { signal });
      return chooser;
    },
  );
  const press = vi.fn(async () => {});
  return {
    currentPage: { waitForEvent, keyboard: { press } },
    fileChooser,
    waitForEvent,
    press,
    emitChooser: () => {
      events.emit("filechooser", fileChooser);
    },
    listenerCount: () => events.listenerCount("filechooser"),
  };
}

export type NavigationGuardCall = {
  action: (url: string) => Promise<unknown>;
  page: { url: () => string };
  onPolicyCheckStarted?: (check: Promise<void>) => void;
  onPolicyDenied?: (event: {
    state: "detected" | "handled";
    error: unknown;
    sourcePreserved?: boolean;
  }) => void;
};

export function createGuardSession<P, L>(getPage: () => P, getLocator: () => L) {
  return {
    assertPageNavigationCompletedSafely: vi.fn(async () => {}),
    ensurePageState: vi.fn(() => ({})),
    forceDisconnectPlaywrightForTarget: vi.fn(async () => {}),
    getPageForTargetId: vi.fn(async () => getPage()),
    isBrowserObservedDialogBlockedError: vi.fn((_err: unknown) => false),
    isPolicyDenyNavigationError: vi.fn((_err: unknown) => false),
    markObservedDialogsHandledRemotelyForPage: vi.fn(() => ({})),
    quarantineBlockedNavigationTarget: vi.fn(async () => {}),
    refLocator: vi.fn(getLocator),
    restoreRoleRefsForTarget: vi.fn(() => {}),
    wasBrowserNavigationSourcePreservedAfterPolicyDenial: vi.fn((_err: unknown) => false),
    withPageNavigationRequestGuard: vi.fn(
      async ({ action, page }: NavigationGuardCall) => await action(page.url()),
    ),
  };
}

export function heldAction<T = void>() {
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<T>();
  return {
    ...result,
    started: started.promise,
    run: vi.fn(() => {
      started.resolve();
      return result.promise;
    }),
  };
}

export async function withFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
}

export function awaitStarted(started: Promise<void>, operation: Promise<unknown>) {
  return Promise.race([
    started,
    operation.then(() => {
      throw new Error("Operation settled before preparation");
    }),
  ]);
}

export function managedDownload(filename: string) {
  return {
    url: `https://example.com/${filename}`,
    suggestedFilename: filename,
    path: `/tmp/openclaw/downloads/${filename}`,
  };
}
