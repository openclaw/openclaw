/** Abort-aware Playwright page target metadata reads. */
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CDPSession, Page } from "playwright-core";
import { PLAYWRIGHT_TARGET_INFO_TIMEOUT_MS } from "./cdp-timeouts.js";

type PageTargetInfo = { targetId: string; title: string };

export async function readPageTargetInfo(
  page: Page,
  signal?: AbortSignal,
): Promise<PageTargetInfo | null> {
  signal?.throwIfAborted();
  let session: CDPSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let detachStarted = false;
  const detach = () => {
    if (!session || detachStarted) {
      return;
    }
    detachStarted = true;
    void session.detach().catch(() => {});
  };
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      detach();
      resolve(null);
    }, PLAYWRIGHT_TARGET_INFO_TIMEOUT_MS);
    timer.unref?.();
  });
  let abortListener: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_resolve, reject) => {
        abortListener = () => {
          detach();
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error(String(signal.reason ?? "Page target lookup aborted.")),
          );
        };
        signal.addEventListener("abort", abortListener, { once: true });
      })
    : undefined;
  const read = (async () => {
    session = await page.context().newCDPSession(page);
    if (signal?.aborted) {
      detach();
      throw signal.reason ?? new Error("Page target lookup aborted.");
    }
    if (timedOut) {
      detach();
      return null;
    }
    try {
      const { targetInfo } = await session.send("Target.getTargetInfo");
      signal?.throwIfAborted();
      const targetId = normalizeOptionalString(targetInfo.targetId) ?? "";
      if (!targetId) {
        return null;
      }
      return { targetId, title: targetInfo.title };
    } finally {
      detach();
    }
  })();
  void read.catch(() => {});
  void aborted?.catch(() => {});
  try {
    return await Promise.race([read, timeout, ...(aborted ? [aborted] : [])]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}
