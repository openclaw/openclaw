import type { Page } from "playwright-core";
import {
  assertBrowserNavigationResultAllowed,
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";

function hasBrowserNavigationPolicy(opts: BrowserNavigationPolicyOptions): boolean {
  return Boolean(opts.ssrfPolicy || opts.browserProxyMode === "explicit-browser-proxy");
}

/** Re-check the owning page and download URL immediately before writing a file. */
export async function assertBrowserDownloadSaveAllowed(
  opts: {
    downloadUrl: string;
    page: Pick<Page, "url">;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  if (!hasBrowserNavigationPolicy(opts)) {
    return;
  }
  const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy, {
    browserProxyMode: opts.browserProxyMode,
  });
  await assertBrowserNavigationResultAllowed({ url: opts.page.url(), ...navigationPolicy });
  await assertBrowserNavigationResultAllowed({ url: opts.downloadUrl, ...navigationPolicy });
  // Policy and embedded-origin checks may resolve DNS asynchronously. Re-read
  // the owner at the final pre-save boundary so a local URL cannot hide a
  // concurrent move to a private page.
  await assertBrowserNavigationResultAllowed({ url: opts.page.url(), ...navigationPolicy });
}
