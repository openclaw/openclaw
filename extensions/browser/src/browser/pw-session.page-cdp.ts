import { randomUUID } from "node:crypto";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { uniqueValues } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import type { CDPSession, ElementHandle, Frame, Page } from "playwright-core";
import { readCdpDocumentIdentities, type CdpDocumentIdentities } from "./cdp-page-session.js";

type MarkBackendDomRef = { ref: string; backendDOMNodeId: number };

/** Attribute used to mark DOM nodes that correspond to generated browser refs. */
export const BROWSER_REF_MARKER_ATTRIBUTE = "data-openclaw-browser-ref";

async function withPlaywrightPageCdpSession<T>(
  page: Page,
  fn: (session: CDPSession) => Promise<T>,
  timeoutMs?: number,
  frame?: Frame,
): Promise<T> {
  let session: CDPSession | undefined;
  let released = false;
  let detach: Promise<void> | undefined;
  const releaseSession = () => {
    if (session) {
      detach ??= session.detach().catch(() => {});
    }
    return detach;
  };
  const operation = (async () => {
    let ownerFrame = frame;
    for (;;) {
      try {
        session = await page.context().newCDPSession(ownerFrame ?? page);
        break;
      } catch (error) {
        // Same-process frames share the ancestor's CDP target; OOP frames own one.
        if (
          !ownerFrame ||
          !(error instanceof Error) ||
          !error.message.includes("does not have a separate CDP session")
        ) {
          throw error;
        }
        ownerFrame = ownerFrame.parentFrame() ?? undefined;
      }
    }
    try {
      if (released) {
        throw new Error("Page CDP operation has already expired.");
      }
      return await fn(session);
    } finally {
      await releaseSession();
    }
  })();
  try {
    return await withTimeout(operation, timeoutMs ?? 0, "Page CDP operation");
  } finally {
    // Release a timed-out command now; a late attach releases itself before
    // running any work. A stuck detach must not extend the operation's deadline.
    released = true;
    void releaseSession();
  }
}

/** Run a function with a CDP send helper scoped to one Playwright page. */
export async function withPageScopedCdpClient<T>(opts: {
  page: Page;
  frame?: Frame;
  fn: (send: CDPSession["send"]) => Promise<T>;
  timeoutMs?: number;
}): Promise<T> {
  return await withPlaywrightPageCdpSession(
    opts.page,
    async (session) => await opts.fn(session.send.bind(session)),
    opts.timeoutMs,
    opts.frame,
  );
}

/** Bind the already-resolved selector element to its native DOM identity, including shadow roots. */
export async function withCdpSnapshotRoot<T>(opts: {
  root: ElementHandle<Element>;
  send: CDPSession["send"];
  run: (backendNodeId: number) => Promise<T>;
}): Promise<T> {
  const attribute = `data-openclaw-capture-${randomUUID()}`;
  let searchId: string | undefined;
  try {
    await opts.root.evaluate((element, name) => element.setAttribute(name, ""), attribute);
    await opts.send("DOM.getDocument", { depth: 0 });
    const search = await opts.send("DOM.performSearch", {
      query: `[${attribute}]`,
      includeUserAgentShadowDOM: true,
    });
    searchId = search.searchId;
    if (search.resultCount !== 1) {
      throw new Error("Snapshot root changed before native capture; retry.");
    }
    const { nodeIds } = await opts.send("DOM.getSearchResults", {
      searchId,
      fromIndex: 0,
      toIndex: 1,
    });
    const { node } = await opts.send("DOM.describeNode", { nodeId: nodeIds[0] });
    return await opts.run(node.backendNodeId);
  } finally {
    if (searchId) {
      await opts.send("DOM.discardSearchResults", { searchId }).catch(() => {});
    }
    await opts.root
      .evaluate((element, name) => element.removeAttribute(name), attribute)
      .catch(() => {});
  }
}

/** Read the browser-owned loader identity for a Playwright page's main frame. */
export async function readMainFrameDocumentIdentityForPage(
  page: Page,
  timeoutMs?: number,
): Promise<string | undefined> {
  return (await readDocumentIdentitiesForPage(page, timeoutMs)).mainFrame;
}

/** Read committed document identities through one bounded page session. */
export async function readDocumentIdentitiesForPage(
  page: Page,
  timeoutMs?: number,
): Promise<CdpDocumentIdentities> {
  return await withPlaywrightPageCdpSession(
    page,
    async (session) => await readCdpDocumentIdentities(session.send.bind(session)),
    resolveTimerTimeoutMs(timeoutMs, 5_000),
  );
}

/** Mark backend DOM node ids on the page with browser ref attributes. */
export async function markBackendDomRefsOnPage(opts: {
  page: Page;
  frame?: Frame;
  send?: CDPSession["send"];
  rootBackendNodeId?: number;
  refs: MarkBackendDomRef[];
  assertCurrent: () => void;
}): Promise<Set<string>> {
  const refs = opts.refs.filter(
    (entry) =>
      /^(?:e|ax)\d+$/.test(entry.ref) &&
      Number.isFinite(entry.backendDOMNodeId) &&
      Math.floor(entry.backendDOMNodeId) > 0,
  );
  const marked = new Set<string>();
  const mark = async (send: CDPSession["send"]) => {
    opts.assertCurrent();
    // Backend-id pushes require a bound document in this fresh session.
    // getDocument also enables DOM; depth zero avoids fetching the subtree.
    const { root } = await send("DOM.getDocument", { depth: 0 });
    opts.assertCurrent();
    const { object } = await send("DOM.resolveNode", {
      backendNodeId: opts.rootBackendNodeId ?? root.backendNodeId,
    });
    try {
      opts.assertCurrent();
      if (!object.objectId) {
        throw new Error("Snapshot document changed before refs were bound; retry.");
      }
      // Keep query and mutation in one browser invocation: Playwright evaluateAll
      // awaits its selector read internally, letting canceled captures clear newer refs.
      const cleared = await send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: `function(attribute) {
          const roots = [this.ownerDocument || this];
          for (const root of roots) {
            for (const element of root.querySelectorAll("*")) {
              if (element.hasAttribute(attribute)) element.removeAttribute(attribute);
              if (element.shadowRoot) roots.push(element.shadowRoot);
            }
          }
        }`,
        arguments: [{ value: BROWSER_REF_MARKER_ATTRIBUTE }],
      });
      opts.assertCurrent();
      if (cleared.exceptionDetails) {
        throw new Error("Snapshot markers could not be cleared; retry.");
      }
    } finally {
      if (object.objectId) {
        await send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
      }
    }
    opts.assertCurrent();
    if (!refs.length) {
      return marked;
    }

    const backendNodeIds = uniqueValues(refs.map((entry) => Math.floor(entry.backendDOMNodeId)));
    const pushed = await send("DOM.pushNodesByBackendIdsToFrontend", {
      backendNodeIds,
    }).catch(() => ({ nodeIds: [] }));
    opts.assertCurrent();
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
      opts.assertCurrent();
      try {
        await send("DOM.setAttributeValue", {
          nodeId,
          name: BROWSER_REF_MARKER_ATTRIBUTE,
          value: entry.ref,
        });
        marked.add(entry.ref);
      } catch {
        // An unavailable DOM node remains unbound; never replace its identity by name.
      }
      opts.assertCurrent();
    }

    return marked;
  };
  return opts.send
    ? await mark(opts.send)
    : await withPageScopedCdpClient({
        page: opts.page,
        frame: opts.frame,
        fn: mark,
      });
}
