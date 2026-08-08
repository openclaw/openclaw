/**
 * Playwright page-scoped CDP helpers.
 *
 * Opens a CDP session through Playwright pages and marks backend DOM nodes with
 * temporary browser refs for role-snapshot interactions.
 */
import { uniqueValues } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CDPSession, Page } from "playwright-core";
import { readCdpMainFrameDocumentIdentity } from "./cdp-page-session.js";

type PageCdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type MarkBackendDomRef = { ref: string; backendDOMNodeId: number };

/** Attribute used to mark DOM nodes that correspond to generated browser refs. */
export const BROWSER_REF_MARKER_ATTRIBUTE = "data-openclaw-browser-ref";

const CLEAR_BROWSER_REF_MARKERS_EXPRESSION = `(() => {
  const attribute = '${BROWSER_REF_MARKER_ATTRIBUTE}';
  const clearRoot = (root) => {
    root.querySelectorAll('[' + attribute + ']').forEach((element) =>
      element.removeAttribute(attribute),
    );
    root.querySelectorAll('*').forEach((element) => {
      if (element.shadowRoot) {
        clearRoot(element.shadowRoot);
      }
    });
  };
  clearRoot(document);
})()`;

async function awaitWithAbort<T>(
  task: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  if (!signal) {
    return await task;
  }
  // The abort race may return before the underlying Playwright/CDP promise
  // observes session detachment. Attach the observer before checking an
  // already-aborted signal because task creation can synchronously abort it.
  void task.catch(() => {});
  signal.throwIfAborted();
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      onAbort?.();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason ?? "aborted")),
      );
    };
    signal.addEventListener("abort", abortListener, { once: true });
  });
  void aborted.catch(() => {});
  try {
    return await Promise.race([task, aborted]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

async function sendPageCdpCommand(
  session: CDPSession,
  method: string,
  params?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const task = (
    session.send as unknown as (
      method: string,
      params?: Record<string, unknown>,
    ) => Promise<unknown>
  )(method, params);
  return await awaitWithAbort(task, signal);
}

async function withPlaywrightPageCdpSession<T>(
  page: Page,
  fn: (session: CDPSession) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const sessionTask = page.context().newCDPSession(page);
  if (signal) {
    void sessionTask
      .then((session) => {
        if (signal.aborted) {
          void session.detach().catch(() => {});
        }
      })
      .catch(() => {});
  }
  const session = await awaitWithAbort(sessionTask, signal);
  let detachTask: Promise<void> | undefined;
  const detach = () => {
    detachTask ??= session.detach().catch(() => {});
    return detachTask;
  };
  try {
    return await awaitWithAbort(fn(session), signal, () => {
      void detach();
    });
  } finally {
    if (signal?.aborted) {
      void detach();
    } else {
      await detach();
    }
  }
}

/** Run a function with a CDP send helper scoped to one Playwright page. */
export async function withPageScopedCdpClient<T>(opts: {
  cdpUrl: string;
  page: Page;
  targetId?: string;
  signal?: AbortSignal;
  fn: (send: PageCdpSend) => Promise<T>;
}): Promise<T> {
  return await withPlaywrightPageCdpSession(
    opts.page,
    async (session) =>
      await opts.fn(
        async (method, params) => await sendPageCdpCommand(session, method, params, opts.signal),
      ),
    opts.signal,
  );
}

/** Read the browser-owned loader identity for a Playwright page's main frame. */
export async function readMainFrameDocumentIdentityForPage(
  page: Page,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return await withPlaywrightPageCdpSession(
    page,
    async (session) =>
      await readCdpMainFrameDocumentIdentity((method, params) =>
        (
          session.send as unknown as (
            method: string,
            params?: Record<string, unknown>,
          ) => Promise<unknown>
        )(method, params),
      ),
    signal,
  );
}

/** Mark backend DOM node ids on the page with browser ref attributes. */
export async function markBackendDomRefsOnPage(opts: {
  page: Page;
  refs: MarkBackendDomRef[];
  signal?: AbortSignal;
}): Promise<Set<string>> {
  opts.signal?.throwIfAborted();
  const refs = opts.refs.filter(
    (entry) =>
      /^ax\d+$/.test(entry.ref) &&
      Number.isFinite(entry.backendDOMNodeId) &&
      Math.floor(entry.backendDOMNodeId) > 0,
  );
  const marked = new Set<string>();
  return await withPlaywrightPageCdpSession(
    opts.page,
    async (session) => {
      const send = async (method: string, params?: Record<string, unknown>) =>
        await sendPageCdpCommand(session, method, params, opts.signal);

      await send("Runtime.evaluate", {
        expression: CLEAR_BROWSER_REF_MARKERS_EXPRESSION,
        returnByValue: true,
      }).catch(() => {});
      opts.signal?.throwIfAborted();
      if (!refs.length) {
        return marked;
      }

      opts.signal?.throwIfAborted();
      await send("DOM.enable").catch(() => {});
      opts.signal?.throwIfAborted();

      const backendNodeIds = uniqueValues(refs.map((entry) => Math.floor(entry.backendDOMNodeId)));
      const pushed = (await send("DOM.pushNodesByBackendIdsToFrontend", {
        backendNodeIds,
      }).catch(() => ({}))) as { nodeIds?: number[] };
      opts.signal?.throwIfAborted();
      const nodeIds = Array.isArray(pushed.nodeIds) ? pushed.nodeIds : [];
      const nodeIdByBackendId = new Map<number, number>();
      for (let index = 0; index < backendNodeIds.length; index += 1) {
        const backendNodeId = backendNodeIds[index];
        const nodeId = nodeIds[index];
        if (backendNodeId && typeof nodeId === "number" && nodeId > 0) {
          nodeIdByBackendId.set(backendNodeId, nodeId);
        }
      }

      for (const entry of refs) {
        const nodeId = nodeIdByBackendId.get(Math.floor(entry.backendDOMNodeId));
        if (!nodeId) {
          continue;
        }
        try {
          opts.signal?.throwIfAborted();
          await send("DOM.setAttributeValue", {
            nodeId,
            name: BROWSER_REF_MARKER_ATTRIBUTE,
            value: entry.ref,
          });
          opts.signal?.throwIfAborted();
          marked.add(entry.ref);
        } catch {
          opts.signal?.throwIfAborted();
          // Best-effort marker write. Unmarked refs fall back to role metadata.
        }
      }

      return marked;
    },
    opts.signal,
  );
}
