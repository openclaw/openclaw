import { truncateUtf16Safe, withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS, DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS } from "./constants.js";
import type {
  BrowserConsoleMessage,
  BrowserNetworkRequest,
  BrowserPageError,
} from "./pw-session.js";
import { ensurePageState, getPageForTargetId } from "./pw-session.js";
import { readDocumentIdentitiesForPage } from "./pw-session.page-cdp.js";
import { awaitActionWithAbort } from "./pw-tools-core.interactions.navigation.js";

/**
 * Returns visible page text without evaluating caller-provided JavaScript.
 * Text is discarded when the page closes, leaves `expectedUrl`, or reports a different
 * main-frame document after the read than before it. Navigations that return to the
 * original document in between are not detected.
 */
export async function getPageTextViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  expectedUrl?: string;
  selector?: string;
  maxChars?: number;
  signal?: AbortSignal;
}): Promise<{ text: string; truncated: boolean }> {
  const maxChars = Math.min(
    opts.maxChars ?? DEFAULT_AI_SNAPSHOT_MAX_CHARS,
    DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  );
  const timeout = DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS;
  const deadline = performance.now() + timeout;
  const controller = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal;
  const changedError = () =>
    new Error("Page text target changed or closed; refresh tabs and retry.");
  const read = async () => {
    signal.throwIfAborted();
    const page = await getPageForTargetId(opts);
    signal.throwIfAborted();
    const assertPageCurrent = () => {
      signal.throwIfAborted();
      if (page.isClosed() || (opts.expectedUrl !== undefined && page.url() !== opts.expectedUrl)) {
        throw changedError();
      }
    };
    // Engines that never report a committed loader id read no identity before or after
    // the text, so the comparison below does not reject them.
    const readMainFrameIdentity = async () => {
      const identities = await readDocumentIdentitiesForPage(page).catch(() => undefined);
      assertPageCurrent();
      return identities?.mainFrame;
    };
    const documentIdentity = await readMainFrameIdentity();
    let locator = page.locator(opts.selector ?? "body").first();
    if (!opts.selector) {
      for (const selector of ["article", "main"]) {
        const candidate = page.locator(selector).first();
        const count = await candidate.count();
        signal.throwIfAborted();
        if (count) {
          locator = candidate;
          break;
        }
      }
    }
    // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- This action reads rendered text, not hidden DOM text.
    const text = await locator.innerText({
      timeout: Math.max(1, deadline - performance.now()),
      signal,
    });
    // Locators re-resolve after navigation, so the text may belong to a successor document.
    if ((await readMainFrameIdentity()) !== documentIdentity) {
      throw changedError();
    }
    return text;
  };
  const text = await withTimeout(awaitActionWithAbort(read(), signal), timeout, {
    createError: () => {
      const error = new Error(`Page text extraction timed out after ${timeout}ms`);
      controller.abort(error);
      return error;
    },
  });
  return { text: truncateUtf16Safe(text, maxChars), truncated: text.length > maxChars };
}

export async function getPageErrorsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  clear?: boolean;
}): Promise<{ errors: BrowserPageError[] }> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const errors = [...state.errors];
  if (opts.clear) {
    state.errors = [];
  }
  return { errors };
}

export async function getNetworkRequestsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  filter?: string;
  clear?: boolean;
}): Promise<{ requests: BrowserNetworkRequest[] }> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const raw = [...state.requests.values()];
  const filter = opts.filter?.trim();
  const requests = filter
    ? raw.filter((r) => r.url.includes(filter) || r.resourceType?.includes(filter))
    : raw;
  if (opts.clear) {
    state.requests.clear();
    state.requestIds = new WeakMap();
  }
  return { requests };
}

function consolePriority(level: string) {
  if (level === "error") {
    return 3;
  }
  if (level === "warn" || level === "warning") {
    return 2;
  }
  return level === "debug" ? 0 : 1;
}

export async function getConsoleMessagesViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  level?: string;
}): Promise<BrowserConsoleMessage[]> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  if (!opts.level) {
    return [...state.console];
  }
  const min = consolePriority(opts.level);
  return state.console.filter((msg) => consolePriority(msg.type) >= min);
}
