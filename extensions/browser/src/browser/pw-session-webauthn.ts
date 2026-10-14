import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import type { Browser, BrowserContext, CDPSession } from "playwright-core";
import { redactCdpErrorText } from "./cdp.helpers.js";
import { processCommandUsesHeadlessChrome } from "./chrome.js";

const log = createSubsystemLogger("browser").child("webauthn");

const HEADLESS_PASSKEY_GUARD_TIMEOUT_MS = 5_000;

const contextGuards = new WeakMap<BrowserContext, Promise<void>>();
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

// A CDP WebAuthn override is cleared when any page session detaches. A context
// script survives snapshots and screencast sessions and also covers popups/frames.
export function refuseHeadlessPasskeyDialogs(context: BrowserContext): Promise<void> {
  const existing = contextGuards.get(context);
  if (existing) {
    return existing;
  }
  const install = context.addInitScript(cancelModalPasskeyRequests).then(
    () => {
      for (const page of context.pages()) {
        for (const frame of page.frames()) {
          // Existing documents need the patch too; a closing frame must not block setup.
          void frame.evaluate(cancelModalPasskeyRequests, undefined).catch(() => {});
        }
      }
    },
    (err: unknown) => {
      contextGuards.delete(context);
      log.warn(`Passkey guard registration failed: ${redactCdpErrorText(formatErrorMessage(err))}`);
    },
  );
  const ready = raceWithTimeout(
    install,
    HEADLESS_PASSKEY_GUARD_TIMEOUT_MS,
    () => {
      log.warn(
        "Passkey guard registration is still waiting on an open page after 5000 ms; continuing while it finishes.",
      );
    },
    { ref: false },
  );
  contextGuards.set(context, ready);
  return ready;
}

export async function guardHeadlessContexts(contexts: readonly BrowserContext[]): Promise<void> {
  await Promise.all(contexts.map(refuseHeadlessPasskeyDialogs));
}
