import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { afterEach, beforeEach, vi } from "vitest";

/** Loads remote-profile tab operation dependencies after Chrome mocks are installed. */
export const loadRemoteProfileTestDeps = createLazyRuntimeModule(async () => {
  await import("./server-context.chrome-test-harness.js");
  const cdpModule = await import("./cdp.js");
  const chromeModule = await import("./chrome.js");
  const { BrowserCdpEndpointBlockedError } = await import("./errors.js");
  const { InvalidBrowserNavigationUrlError } = await import("./navigation-guard.js");
  const pwAiModule = await import("./pw-ai-module.js");
  const { closePlaywrightBrowserConnection } = await import("./pw-session.js");
  const { createBrowserRouteContext } = await import("./server-context.js");
  const harness = await import("./server-context.remote-tab-ops.harness.js");
  return {
    cdpModule,
    chromeModule,
    BrowserCdpEndpointBlockedError,
    InvalidBrowserNavigationUrlError,
    pwAiModule,
    closePlaywrightBrowserConnection,
    createBrowserRouteContext,
    createJsonListFetchMock: harness.createJsonListFetchMock,
    createTestBrowserRouteContext: harness.createTestBrowserRouteContext,
    createRemoteRouteHarness: harness.createRemoteRouteHarness,
    createSequentialPageLister: harness.createSequentialPageLister,
    makeState: harness.makeState,
    originalFetch: harness.originalFetch,
  };
});

/** Installs per-test mock reset and Playwright connection cleanup. */
export function installRemoteProfileTestLifecycle(
  deps: Awaited<ReturnType<typeof loadRemoteProfileTestDeps>>,
): void {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = deps.originalFetch;
  });

  afterEach(async () => {
    await deps.closePlaywrightBrowserConnection().catch(() => {});
    globalThis.fetch = deps.originalFetch;
    vi.restoreAllMocks();
  });
}
