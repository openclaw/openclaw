import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type { Browser, Page, Request, Route } from "playwright-core";
import {
  assertBrowserNavigationAllowed,
  parseBrowserNavigationUrl,
  type BrowserNavigationPolicyOptions,
} from "./navigation-guard.js";

export type DocumentPolicyClaim = {
  handle: (route: Route, request: Request) => Promise<boolean>;
  failed: (route: Route, request: Request, error: unknown) => Promise<void>;
  assertCurrent?: () => void | Promise<void>;
  inFlight: Set<Promise<void>>;
};

type DocumentPolicyOwner = {
  ready: Promise<void>;
  policy: BrowserNavigationPolicyOptions;
  claims: Set<DocumentPolicyClaim>;
};
const owners = new WeakMap<Page, DocumentPolicyOwner>();
const log = createSubsystemLogger("browser").child("document-policy");

function isDocument(request: Request): boolean {
  return request.isNavigationRequest() || request.resourceType() === "document";
}

async function checkStandingDocument(
  page: Page,
  request: Request,
  policy: BrowserNavigationPolicyOptions,
): Promise<void> {
  const parsed = parseBrowserNavigationUrl(request.url());
  // Reloads and in-app links reach no new origin. Never extend this exception
  // to active invocations, which must still pass their own current authority.
  if (
    policy.browserProxyMode !== "explicit-browser-proxy" &&
    (parsed.protocol === "http:" || parsed.protocol === "https:")
  ) {
    let frameUrl: string | undefined;
    try {
      frameUrl = request.frame().url();
    } catch {
      // Renderer churn cannot grant an unknown frame an origin exception.
    }
    if ([frameUrl, page.url()].some((url) => url && URL.parse(url)?.origin === parsed.origin)) {
      return;
    }
  }
  await assertBrowserNavigationAllowed({ url: request.url(), ...policy });
}

/** One Playwright interception owner per connected tab, not per invocation. */
export async function ensurePageDocumentPolicy(
  page: Page,
  options: BrowserNavigationPolicyOptions,
): Promise<DocumentPolicyOwner> {
  // Only configured policy survives a call. A caller supplying a temporary
  // exception must also carry its original policy, never its live authority.
  const policy: BrowserNavigationPolicyOptions = {
    ssrfPolicy: options.standingSsrfPolicy ?? options.ssrfPolicy,
    browserProxyMode: options.browserProxyMode,
  };
  let owner = owners.get(page);
  if (owner) {
    owner.policy = policy;
    await owner.ready;
    return owner;
  }
  const claims = new Set<DocumentPolicyClaim>();
  let retired = false;
  const browser: Browser | null = page.context().browser();
  const retire = () => {
    retired = true;
    owners.delete(page);
    claims.clear();
    page.off("close", retire);
    browser?.off("disconnected", retire);
  };
  owner = { ready: Promise.resolve(), policy, claims };
  const current = owner;
  const handler = (route: Route, request: Request): Promise<void> => {
    // Capture at arrival: releasing a claim cannot transfer its already-paused
    // request or its temporary grants to a later invocation.
    const active = [...claims];
    const operation = (async () => {
      try {
        if (retired) {
          await route.abort();
          return;
        }
        if (active.length) {
          for (const claim of active) {
            if (!(await claim.handle(route, request))) {
              return;
            }
          }
          // Policy checks can await DNS. Recheck each invocation immediately
          // before releasing the document, not just before native dispatch.
          for (const claim of active) {
            const assertion = claim.assertCurrent?.();
            if (assertion) await assertion;
          }
        } else if (isDocument(request)) {
          await checkStandingDocument(page, request, current.policy);
        }
        if (retired) {
          await route.abort();
          return;
        }
        await route.fallback();
      } catch (error) {
        if (error instanceof Error && error.message.includes("Route is already handled")) {
          return;
        }
        if (active.length) {
          await Promise.all(active.map((claim) => claim.failed(route, request, error)));
        } else {
          log.warn("Blocked a browser document request under the standing navigation policy.");
          // A 204 rejects a document without replacing the person's source page.
          await route.fulfill({ status: 204, body: "" }).catch(() => route.abort().catch(() => {}));
        }
      }
    })();
    for (const claim of active) {
      claim.inFlight.add(operation);
    }
    void operation.finally(() => {
      for (const claim of active) {
        claim.inFlight.delete(operation);
      }
    });
    return operation;
  };
  owners.set(page, owner);
  page.on("close", retire);
  browser?.on("disconnected", retire);
  owner.ready = page.route("**", handler).catch(async (error: unknown) => {
    retire();
    // Playwright registers locally before remote setup can fail.
    await page.unroute("**", handler).catch(() => {});
    throw error;
  });
  await owner.ready;
  return owner;
}

export async function claimPageDocumentPolicy(
  page: Page,
  options: BrowserNavigationPolicyOptions,
  claim: DocumentPolicyClaim,
): Promise<() => Promise<void>> {
  const owner = await ensurePageDocumentPolicy(page, options);
  owner.claims.add(claim);
  return async () => {
    owner.claims.delete(claim);
    while (claim.inFlight.size) {
      await Promise.allSettled(claim.inFlight);
    }
  };
}
