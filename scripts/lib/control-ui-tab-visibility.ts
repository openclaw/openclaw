import type { Page } from "playwright";

type WebKitPageProxySession = {
  send(method: "Emulation.setActiveAndFocused", parameters: { active?: boolean }): Promise<unknown>;
};

type WebKitPage = {
  _connection?: {
    toImpl?(page: Page): { delegate?: { _pageProxySession?: WebKitPageProxySession } };
  };
};

export const FIREFOX_HIDDEN_TAB_UNSUPPORTED_REASON =
  "Playwright's Firefox Juggler forces docShell.forceActiveState and overrideHasFocus; " +
  "switching headless pages does not hide their documents or stop animation frames.";

/**
 * WebKit's native test-activity override changes document visibility and parks its
 * frame scheduler. This is native activity emulation, not OS window minimization
 * or a JavaScript override of document.hidden. Run before collecting metrics.
 */
export async function setControlUiWebKitTabVisibility(
  page: Page,
  visibility: "visible" | "hidden",
) {
  // SAFETY: The pinned Playwright 1.64.1 bridge owns this existing native pipe.
  const { _connection: connection } = page as Page & WebKitPage;
  const { _pageProxySession: session } = connection?.toImpl?.(page).delegate ?? {};
  if (!session) {
    throw new Error("WebKit tab visibility requires Playwright's in-process page-proxy session");
  }
  // Omitting active releases the override and restores the headless page's native state.
  await session.send(
    "Emulation.setActiveAndFocused",
    visibility === "hidden" ? { active: false } : {},
  );
  await page.waitForFunction((expected) => document.visibilityState === expected, visibility, {
    polling: 50,
    timeout: 5_000,
  });

  let hiddenFrameCallbacks: number | null = null;
  if (visibility === "hidden") {
    const probe = await page.evaluateHandle(() => {
      const state = { frames: 0, frameId: 0 };
      state.frameId = requestAnimationFrame(() => state.frames++);
      return state;
    });
    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      hiddenFrameCallbacks = await probe.evaluate((state) => state.frames);
      if (hiddenFrameCallbacks !== 0) {
        throw new Error("WebKit hidden document continued to run native animation frames");
      }
    } finally {
      await probe.evaluate((state) => cancelAnimationFrame(state.frameId));
      await probe.dispose();
    }
  }
  return {
    mechanism: "webkit-native-test-activity" as const,
    visibility,
    hiddenFrameCallbacks,
  };
}
