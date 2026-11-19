import type { EventEmitter } from "node:events";
import type { Browser, BrowserContext } from "playwright-core";

/** Basic/Digest credentials the tab's document-interception session answers with. */
export type FenceHttpCredentials = { username: string; password: string };

type AuthRequired = { requestId: string; authChallenge?: { source?: string } };
type AuthChallengeResponse =
  | { response: "Default" | "CancelAuth" }
  | { response: "ProvideCredentials"; username: string; password: string };
type AuthTarget = {
  events: EventEmitter;
  send(
    method: "Fetch.continueWithAuth",
    params: { requestId: string; authChallengeResponse: AuthChallengeResponse },
  ): Promise<unknown>;
};

const ANSWERED_CHALLENGE_LIMIT = 256;
const relayBrowsers = new WeakSet<Browser>();
const credentialsByContext = new WeakMap<BrowserContext, FenceHttpCredentials>();
const listenersByContext = new WeakMap<BrowserContext, Set<() => void>>();

/**
 * An extension relay grants each tab's Fetch domain to exactly one CDP session.
 * The tab's navigation fence holds it, so Playwright's own credential
 * interception (a second Fetch.enable) is refused on relay tabs.
 */
export function markRelayBrowser(browser: Browser): void {
  relayBrowsers.add(browser);
}

export function usesExtensionRelay(context: BrowserContext): boolean {
  const browser = context.browser();
  return browser !== null && relayBrowsers.has(browser);
}

export function setFenceHttpCredentials(
  context: BrowserContext,
  credentials: FenceHttpCredentials | null,
): void {
  if (credentials) {
    credentialsByContext.set(context, { ...credentials });
  } else {
    credentialsByContext.delete(context);
  }
  for (const listener of listenersByContext.get(context) ?? []) {
    listener();
  }
}

/** Extra Fetch.enable parameters for a fence that must answer auth challenges. */
export function interception(context: BrowserContext): { handleAuthRequests?: true } {
  return credentialsByContext.has(context) ? { handleAuthRequests: true } : {};
}

/** Re-enables a fenced tab's interception when its context's credentials change. */
export function onChange<T>(
  context: BrowserContext,
  targets: () => Iterable<T>,
  intercept: (target: T) => Promise<unknown>,
): () => void {
  let listeners = listenersByContext.get(context);
  if (!listeners) {
    listeners = new Set();
    listenersByContext.set(context, listeners);
  }
  const listener = () => {
    for (const target of targets()) {
      void intercept(target).catch(() => {});
    }
  };
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Answers one interception target's auth challenges: server challenges get the
 * context's credentials once per request; a repeated challenge means they were
 * rejected and is cancelled instead of looping. Proxy challenges and contexts
 * without credentials keep Chromium's default handling.
 */
export function answer(context: BrowserContext, target: AuthTarget): () => void {
  const answered = new Set<string>();
  const listener = (event: AuthRequired) => {
    const credentials = credentialsByContext.get(context);
    const retried = answered.has(event.requestId);
    answered.add(event.requestId);
    if (answered.size > ANSWERED_CHALLENGE_LIMIT) {
      const [oldest] = answered;
      if (oldest !== undefined) {
        answered.delete(oldest);
      }
    }
    const authChallengeResponse: AuthChallengeResponse =
      !credentials || event.authChallenge?.source === "Proxy"
        ? { response: "Default" }
        : retried
          ? { response: "CancelAuth" }
          : { response: "ProvideCredentials", ...credentials };
    // A request the page already ended has nothing left to answer.
    void target
      .send("Fetch.continueWithAuth", { requestId: event.requestId, authChallengeResponse })
      .catch(() => {});
  };
  target.events.on("Fetch.authRequired", listener);
  return () => {
    target.events.off("Fetch.authRequired", listener);
  };
}
