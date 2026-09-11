/** Existing-session action waits, navigation verification, and deadline ownership. */
import { setTimeout as sleep } from "node:timers/promises";
import { EXISTING_SESSION_NAVIGATION_RECHECK_DELAYS_MS } from "../act-policy.js";
import {
  ChromeMcpDocumentUnavailableError,
  evaluateChromeMcpScript,
  withChromeMcpDocument,
  type ChromeMcpOperationOptions,
  type ChromeMcpProfileOptions,
} from "../chrome-mcp.js";
import { normalizeBrowserEvaluateFunctionSource } from "../evaluate-source.js";
import {
  assertBrowserNavigationResultAllowed,
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,
} from "../navigation-guard.js";
import { matchBrowserUrlPattern } from "../url-pattern.js";

/** Abort nested operations without racing the route's response/error owner. */
export function createExistingSessionDeadline(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  label: string,
) {
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  const deadlineAt = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(error), timeoutMs);
  timer.unref?.();
  return {
    signal,
    throwIfAborted: () => {
      // A busy event loop must not turn a late completion into a successful action.
      if (Date.now() >= deadlineAt && !signal.aborted) {
        controller.abort(error);
      }
      signal.throwIfAborted();
    },
    cleanup: () => clearTimeout(timer),
  };
}

export type ExistingSessionOperation = ChromeMcpOperationOptions & {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
};

async function readExistingSessionLocationHref(params: ExistingSessionOperation): Promise<string> {
  const currentUrl = await evaluateChromeMcpScript({
    ...params,
    fn: "() => window.location.href",
  });
  if (typeof currentUrl !== "string") {
    throw new Error("Location probe returned a non-string result");
  }
  const normalizedUrl = currentUrl.trim();
  if (!normalizedUrl) {
    throw new Error("Location probe returned an empty URL");
  }
  return normalizedUrl;
}

export async function assertExistingSessionPostInteractionNavigationAllowed(
  params: ExistingSessionOperation &
    BrowserNavigationPolicyOptions & {
      listTabs: () => Promise<Array<{ targetId: string; url: string }>>;
      initialTabTargetIds: ReadonlySet<string>;
    },
): Promise<void> {
  const navigationPolicy = withBrowserNavigationPolicy(params.ssrfPolicy, {
    browserProxyMode: params.browserProxyMode,
  });
  if (!navigationPolicy.ssrfPolicy && !navigationPolicy.browserProxyMode) {
    return;
  }
  const listTabs = params.listTabs;
  const initialTabTargetIds = params.initialTabTargetIds;

  const assertNewTabsAllowed = async () => {
    const tabs = await listTabs();
    for (const tab of tabs) {
      if (initialTabTargetIds.has(tab.targetId)) {
        continue;
      }
      await assertBrowserNavigationResultAllowed({
        url: tab.url,
        signal: params.signal,
        ...navigationPolicy,
      });
    }
  };

  let lastObservedUrl: string | undefined;
  let sawStableAllowedUrl = false;
  for (const delayMs of EXISTING_SESSION_NAVIGATION_RECHECK_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs, undefined, { signal: params.signal });
    }
    let currentUrl: string;
    try {
      currentUrl = await readExistingSessionLocationHref(params);
    } catch {
      params.signal?.throwIfAborted();
      sawStableAllowedUrl = false;
      continue;
    }
    await assertBrowserNavigationResultAllowed({
      url: currentUrl,
      signal: params.signal,
      ...navigationPolicy,
    });
    if (currentUrl === lastObservedUrl) {
      sawStableAllowedUrl = true;
    } else {
      sawStableAllowedUrl = false;
    }
    lastObservedUrl = currentUrl;
  }

  if (sawStableAllowedUrl) {
    await assertNewTabsAllowed();
    return;
  }

  // If the loop exhausted without confirming stability but we did observe
  // at least one allowed URL, run a single follow-up probe so a late URL
  // transition that has already settled is not treated as a false failure.
  if (lastObservedUrl) {
    const lastDelay =
      EXISTING_SESSION_NAVIGATION_RECHECK_DELAYS_MS[
        EXISTING_SESSION_NAVIGATION_RECHECK_DELAYS_MS.length - 1
      ];
    await sleep(lastDelay, undefined, { signal: params.signal });
    try {
      const followUpUrl = await readExistingSessionLocationHref(params);
      await assertBrowserNavigationResultAllowed({
        url: followUpUrl,
        signal: params.signal,
        ...navigationPolicy,
      });
      if (followUpUrl === lastObservedUrl) {
        await assertNewTabsAllowed();
        return;
      }
    } catch {
      params.signal?.throwIfAborted();
      // Probe failed — fall through to throw
    }
  }

  throw new Error("Unable to verify stable post-interaction navigation");
}

function buildExistingSessionWaitPredicate(params: {
  text?: string;
  textGone?: string;
  selector?: string;
  loadState?: "load" | "domcontentloaded" | "networkidle";
  fn?: string;
}): string | null {
  const checks = [
    params.text && `Boolean(document.body?.innerText?.includes(${JSON.stringify(params.text)}))`,
    params.textGone && `!document.body?.innerText?.includes(${JSON.stringify(params.textGone)})`,
    params.selector &&
      `(function visible(node) {
      if (!node) return false;
      if (node.nodeType === 1) {
        // Like managed waits, display:contents is visible through rendered children.
        if (getComputedStyle(node).display === "contents") {
          return Array.from(node.childNodes).some(visible);
        }
        if (!node.checkVisibility({ visibilityProperty: true })) return false;
      } else if (node.nodeType !== 3) {
        return false;
      }
      const range = document.createRange();
      range.selectNode(node);
      const rect = node.nodeType === 1 ? node.getBoundingClientRect() : range.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })(document.querySelector(${JSON.stringify(params.selector)}))`,
    params.loadState === "domcontentloaded" &&
      `document.readyState === "interactive" || document.readyState === "complete"`,
    params.loadState === "load" && `document.readyState === "complete"`,
    // `fn` is admitted only by the same evaluateEnabled gate as evaluate.
    // Preserve its async semantics; document binding guards scheduler rebinding.
    params.fn && `Boolean(await (${normalizeBrowserEvaluateFunctionSource(params.fn)})())`,
  ];
  return (
    checks
      .filter(Boolean)
      .map((check) => `(${check})`)
      .join(" && ") || null
  );
}

export async function waitForExistingSessionCondition(
  params: ExistingSessionOperation & {
    timeMs?: number;
    text?: string;
    textGone?: string;
    selector?: string;
    url?: string;
    loadState?: "load" | "domcontentloaded" | "networkidle";
    fn?: string;
    ssrfPolicy?: BrowserNavigationPolicyOptions["ssrfPolicy"];
    browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  },
): Promise<void> {
  if (params.timeMs && params.timeMs > 0) {
    await sleep(params.timeMs, undefined, { signal: params.signal });
  }
  const predicate = buildExistingSessionWaitPredicate(params);
  if (!predicate && !params.url) {
    return;
  }
  const timeoutMs = Math.max(250, params.timeoutMs ?? 10_000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await withChromeMcpDocument(params, async (document) => {
        const readAllowedUrl = async () => {
          const url = await document.evaluate(`(root) => {
            const boundDocument = root?.nodeType === 9 ? root : root?.ownerDocument;
            return boundDocument === globalThis.document ? globalThis.location.href : null;
          }`);
          if (typeof url !== "string" || !url.trim()) {
            return null;
          }
          await assertBrowserNavigationResultAllowed({
            url,
            signal: params.signal,
            ...withBrowserNavigationPolicy(params.ssrfPolicy, {
              browserProxyMode: params.browserProxyMode,
            }),
          });
          return url;
        };
        const currentUrl = await readAllowedUrl();
        if (!currentUrl) {
          return false;
        }
        if (params.url && !matchBrowserUrlPattern(params.url, currentUrl)) {
          return false;
        }
        if (!predicate) {
          return true;
        }
        const outcome = await document.evaluate(`async (root) => {
          const boundDocument = root?.nodeType === 9 ? root : root?.ownerDocument;
          if (boundDocument !== globalThis.document) return { kind: "navigation" };
          try {
            return { kind: "result", ready: Boolean(await (${predicate})) };
          } catch (error) {
            const message = error && typeof error === "object" && "message" in error
              ? String(error.message)
              : String(error);
            return { kind: "error", message };
          }
        }`);
        if (!outcome || typeof outcome !== "object") {
          throw new Error("Document-bound wait returned an invalid result");
        }
        if ("kind" in outcome && outcome.kind === "error") {
          throw new Error(
            "message" in outcome && typeof outcome.message === "string"
              ? outcome.message
              : "Wait predicate failed",
          );
        }
        const predicateReady =
          "kind" in outcome &&
          outcome.kind === "result" &&
          "ready" in outcome &&
          outcome.ready === true;
        if (!predicateReady || !params.url) {
          return predicateReady;
        }
        const finalUrl = await readAllowedUrl();
        return finalUrl !== null && matchBrowserUrlPattern(params.url, finalUrl);
      });
      if (ready) {
        return;
      }
    } catch (error) {
      if (!(error instanceof ChromeMcpDocumentUnavailableError)) {
        throw error;
      }
    }
    await sleep(250, undefined, { signal: params.signal });
  }
  throw new Error("Timed out waiting for condition");
}
