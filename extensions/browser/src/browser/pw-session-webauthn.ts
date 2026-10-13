import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import type { Browser, BrowserContext, CDPSession } from "playwright-core";
import { redactCdpErrorText } from "./cdp.helpers.js";
import { processCommandUsesHeadlessChrome } from "./chrome.js";

const log = createSubsystemLogger("browser").child("webauthn");

// Chrome answers SystemInfo.getInfo once its GPU feature info is ready: tens of
// milliseconds under --disable-gpu, a few hundred with a GPU. The same budget
// bounds guard registration, which waits on every open page of a context.
const HEADLESS_PASSKEY_GUARD_TIMEOUT_MS = 5_000;

const contextGuards = new WeakMap<BrowserContext, Promise<void>>();
// Registrations that already outlived one bounded wait. Playwright applies a
// context script to new pages as soon as registration starts, so later callers
// do not wait for the open pages again.
const slowContextGuards = new WeakSet<Promise<void>>();

/** Read once per connection whether the connected Chromium was launched headless. */
export async function isHeadlessChromium(browser: Browser): Promise<boolean> {
  let session: CDPSession | undefined;
  let settled = false;
  const release = () => {
    void session?.detach().catch(() => {});
  };
  const unknown = (reason: string) => {
    log.warn(
      `Could not read the browser launch mode (${reason}). If it runs headless, a page that asks for a passkey ignores clicks and keys until the request ends or the page navigates away; use a headed profile for such sites.`,
    );
    return false;
  };
  try {
    return await raceWithTimeout(
      async () => {
        session = await browser.newBrowserCDPSession();
        if (settled) {
          release();
          return false;
        }
        // A user-agent override hides "HeadlessChrome", and Browser.getVersion
        // reports plain Chrome under --headless=new; the launch command line does not.
        const { commandLine } = await session.send("SystemInfo.getInfo");
        return processCommandUsesHeadlessChrome({ argv: null, text: commandLine });
      },
      HEADLESS_PASSKEY_GUARD_TIMEOUT_MS,
      () => unknown(`no answer within ${HEADLESS_PASSKEY_GUARD_TIMEOUT_MS} ms`),
      { ref: false },
    );
  } catch (err) {
    return unknown(redactCdpErrorText(formatErrorMessage(err)));
  } finally {
    settled = true;
    release();
  }
}

type PasskeyPageScope = {
  CredentialsContainer?: { prototype: CredentialsContainer };
  DOMException?: typeof DOMException;
};

/**
 * Page-side script: answer passkey requests that would open Chrome's modal
 * passkey dialog the way a user who dismisses that dialog does. Conditional
 * (autofill) requests open no dialog and keep the browser's behavior.
 * Playwright serializes this function, so it must stay self-contained.
 */
function cancelModalPasskeyRequests(scope: PasskeyPageScope = globalThis): void {
  const prototype = scope.CredentialsContainer?.prototype;
  const NotAllowed = scope.DOMException;
  if (!prototype || !NotAllowed) {
    return;
  }
  const nativeGet: CredentialsContainer["get"] = Reflect.get(prototype, "get");
  const nativeCreate: CredentialsContainer["create"] = Reflect.get(prototype, "create");
  const opensDialog = (options?: { publicKey?: unknown; mediation?: string }) =>
    Boolean(options?.publicKey) && options?.mediation !== "conditional";
  const dismissed = () =>
    Promise.reject(
      new NotAllowed("The operation either timed out or was not allowed.", "NotAllowedError"),
    );
  // Patch the prototype like the native methods, with their names and arities.
  const methods = {
    get(this: CredentialsContainer, ...args: [CredentialRequestOptions?]) {
      return opensDialog(args[0]) ? dismissed() : Reflect.apply(nativeGet, this, args);
    },
    create(this: CredentialsContainer, ...args: [CredentialCreationOptions?]) {
      return opensDialog(args[0]) ? dismissed() : Reflect.apply(nativeCreate, this, args);
    },
  };
  Object.assign(prototype, methods);
}

/** The page script as document source, for a raw CDP session that opens a tab. */
export const HEADLESS_PASSKEY_GUARD_SOURCE = `(${String(cancelModalPasskeyRequests)})();`;

/**
 * Keep pages of a headless browser usable when a site asks for a passkey.
 *
 * Headless Chrome cannot show its passkey dialog, yet the hidden dialog stays
 * tab-modal: Chrome drops every input event for the tab, including the CDP input
 * behind agent clicks and the browser panel, until the site's request ends.
 * Answering such requests in the page, before Chrome sees them, keeps the tab
 * usable and lets the site offer its other sign-in methods. No credential is
 * created, read or returned.
 *
 * The DevTools WebAuthn environment (enableUI: false) also removes the dialog,
 * but Chrome clears it whenever any DevTools session on the page detaches, and
 * page lookups, snapshots and the screencast attach and detach sessions all the
 * time. A context init script lives on Playwright's own page sessions and
 * covers new pages, popups and iframes. Documents that are already open get the
 * same patch once; a request one of them already started keeps its dialog until
 * the page reloads.
 */
export function refuseHeadlessPasskeyDialogs(context: BrowserContext): Promise<void> {
  const existing = contextGuards.get(context);
  if (existing) {
    return existing;
  }
  const guard: Promise<void> = context.addInitScript(cancelModalPasskeyRequests).then(
    () => {
      for (const page of context.pages()) {
        for (const frame of page.frames()) {
          // A busy or closing page must not hold up the guard.
          void frame.evaluate(cancelModalPasskeyRequests, undefined).catch(() => {});
        }
      }
    },
    (err: unknown) => {
      // Playwright drops a context script when any page fails it; retry on next use.
      if (contextGuards.get(context) === guard) {
        contextGuards.delete(context);
      }
      log.warn(
        `Passkey guard registration failed: ${redactCdpErrorText(formatErrorMessage(err))}. It is retried on the next page action.`,
      );
    },
  );
  contextGuards.set(context, guard);
  return guard;
}

/** Wait for passkey guard work at most the guard budget; the work itself keeps running. */
export async function waitForPasskeyGuard(
  work: Promise<unknown>,
  onSlow: (budgetMs: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  await raceWithTimeout(
    work.then(
      () => {},
      () => {},
    ),
    HEADLESS_PASSKEY_GUARD_TIMEOUT_MS,
    () => onSlow(HEADLESS_PASSKEY_GUARD_TIMEOUT_MS),
    { ref: false, ...(signal ? { signal, onAbort: (aborted) => aborted.throwIfAborted() } : {}) },
  );
}

/** Guard contexts of a headless browser, waiting a bounded time for open pages to accept it. */
export async function guardHeadlessContexts(contexts: readonly BrowserContext[]): Promise<void> {
  const pending = contexts
    .map((context) => refuseHeadlessPasskeyDialogs(context))
    .filter((guard) => !slowContextGuards.has(guard));
  if (pending.length === 0) {
    return;
  }
  await waitForPasskeyGuard(Promise.all(pending), (budgetMs) => {
    for (const guard of pending) {
      slowContextGuards.add(guard);
    }
    log.warn(
      `Passkey guard registration is still waiting on an open page after ${budgetMs} ms; continuing while it finishes.`,
    );
  });
}
