import type { Page } from "playwright-core";
import { SsrFBlockedError, type SsrFPolicy } from "../infra/net/ssrf.js";
import {
  assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import * as pwSession from "./pw-session.js";

export async function getAllowedPageForTarget(opts: {
  cdpUrl: string;
  targetId?: string;
  page?: Page;
  ssrfPolicy?: SsrFPolicy;
}): Promise<Page> {
  let page: Page | undefined;
  try {
    page = opts.page ?? (await pwSession.getPageForTargetId(opts));
    const guardUrl = page.url();
    if (typeof guardUrl !== "string" || !guardUrl.trim()) {
      throw new SsrFBlockedError("Blocked: unable to verify the current Playwright target URL");
    }
    await assertBrowserNavigationResultAllowed({
      url: guardUrl,
      ...withBrowserNavigationPolicy(opts.ssrfPolicy),
    });
    return page;
  } catch (err) {
    if (page && typeof page.close === "function") {
      await page.close().catch(() => {});
    } else if (opts.targetId && typeof pwSession.closePageByTargetIdViaPlaywright === "function") {
      await pwSession
        .closePageByTargetIdViaPlaywright({
          cdpUrl: opts.cdpUrl,
          targetId: opts.targetId,
        })
        .catch(() => {});
    }
    throw err;
  }
}
